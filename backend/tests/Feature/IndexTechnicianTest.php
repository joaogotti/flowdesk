<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Models\User;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Schema;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class IndexTechnicianTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();

        $this->assertSame('sqlite', config('database.default'));
        $this->assertSame(':memory:', config('database.connections.sqlite.database'));
        (require database_path('migrations/0001_01_01_000000_create_users_table.php'))->up();

        // Mesmo isolamento da suíte existente, sem CHECK exclusivo do PostgreSQL.
        Schema::table('users', function (Blueprint $table) {
            $table->string('role', 20)->default('requester');
            $table->timestampTz('disabled_at')->nullable();
        });
        config(['sanctum.stateful' => ['localhost:5173']]);
        $this->withHeader('Origin', 'http://localhost:5173');
    }

    public function test_admin_lists_only_active_technicians_with_exact_public_json(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $technician = User::factory()->create(['name' => 'Técnico de Teste Flowdesk', 'role' => 'technician']);
        User::factory()->create(['role' => 'technician', 'disabled_at' => now()]);
        User::factory()->create(['role' => 'requester']);
        User::factory()->create(['role' => 'requester', 'disabled_at' => now()]);
        User::factory()->create(['role' => 'admin', 'disabled_at' => now()]);

        $this->actingAs($admin, 'web')->getJson('/api/technicians')
            ->assertOk()->assertHeader('Content-Type', 'application/json')
            ->assertExactJson(['data' => [['id' => $technician->id, 'name' => 'Técnico de Teste Flowdesk']]]);
    }

    public function test_orders_by_name_then_id_including_duplicate_names(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $z = User::factory()->create(['name' => 'Zelia', 'role' => 'technician']);
        $firstBruno = User::factory()->create(['name' => 'Bruno', 'role' => 'technician']);
        $ana = User::factory()->create(['name' => 'Ana', 'role' => 'technician']);
        $secondBruno = User::factory()->create(['name' => 'Bruno', 'role' => 'technician']);

        $this->actingAs($admin, 'web')->getJson('/api/technicians')->assertOk()->assertExactJson([
            'data' => array_map(fn (User $user) => $user->only(['id', 'name']), [$ana, $firstBruno, $secondBruno, $z]),
        ]);
    }

    public function test_returns_empty_array_when_no_technicians_exist(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        User::factory()->create(['role' => 'requester']);

        $this->actingAs($admin, 'web')->getJson('/api/technicians')
            ->assertOk()->assertExactJson(['data' => []]);
    }

    public function test_returns_empty_array_when_all_technicians_are_disabled(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        User::factory()->count(2)->create(['role' => 'technician', 'disabled_at' => now()]);

        $this->actingAs($admin, 'web')->getJson('/api/technicians')
            ->assertOk()->assertExactJson(['data' => []]);
    }

    #[DataProvider('forbiddenRoles')]
    public function test_active_non_admin_roles_receive_403(string $role): void
    {
        User::factory()->create(['role' => 'technician']);

        $this->actingAs(User::factory()->create(['role' => $role]), 'web')->getJson('/api/technicians')
            ->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
    }

    public static function forbiddenRoles(): array
    {
        return [['requester'], ['technician'], ['unknown']];
    }

    public function test_guest_receives_401_without_technician_data(): void
    {
        User::factory()->create(['role' => 'technician']);

        $this->getJson('/api/technicians')->assertUnauthorized()->assertJsonMissingPath('data');
    }

    #[DataProvider('allRoles')]
    public function test_disabled_users_receive_403(string $role): void
    {
        $user = User::factory()->create(['role' => $role, 'disabled_at' => now()]);

        $this->actingAs($user, 'web')->getJson('/api/technicians')
            ->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
    }

    public static function allRoles(): array
    {
        return [['requester'], ['technician'], ['admin']];
    }

    public function test_query_parameters_cannot_change_filtering_or_expose_additional_fields(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $technician = User::factory()->create(['role' => 'technician']);
        User::factory()->create(['role' => 'technician', 'disabled_at' => now()]);

        $this->actingAs($admin, 'web')->getJson('/api/technicians?role=admin&include_disabled=1&fields=*&sort=-name')
            ->assertOk()->assertExactJson(['data' => [$technician->only(['id', 'name'])]]);
    }

    public function test_existing_admin_session_can_list_without_writes_or_rotating_session(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $technician = User::factory()->create(['role' => 'technician']);
        User::factory()->create(['role' => 'technician', 'disabled_at' => now()]);
        $this->postJson('/api/login', ['email' => $admin->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $csrfToken = session()->token();
        $tables = ['users' => 'id', 'sessions' => 'id', 'password_reset_tokens' => 'email'];
        $before = [];
        foreach ($tables as $table => $key) {
            $before[$table] = DB::table($table)->orderBy($key)->get()->toJson();
        }
        Auth::forgetGuards();
        DB::enableQueryLog();

        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)->getJson('/api/technicians')
            ->assertOk()->assertExactJson(['data' => [$technician->only(['id', 'name'])]]);

        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        foreach ($queries as $query) {
            $this->assertDoesNotMatchRegularExpression('/^\s*(insert|update|delete|replace|create|alter|drop|truncate)\b/i', $query['query']);
            $this->assertStringNotContainsString('personal_access_tokens', $query['query']);
        }
        foreach ($before as $table => $snapshot) {
            $this->assertSame($snapshot, DB::table($table)->orderBy($tables[$table])->get()->toJson());
        }
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($csrfToken, session()->token());
        $this->assertFalse(Schema::hasTable('personal_access_tokens'));
    }

    #[DataProvider('lostAccess')]
    public function test_admin_disabled_or_demoted_after_login_loses_access(array $changes): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $this->postJson('/api/login', ['email' => $admin->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $admin->update($changes);
        Auth::forgetGuards();

        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)->getJson('/api/technicians')
            ->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
    }

    public static function lostAccess(): array
    {
        return [['changes' => ['disabled_at' => '2026-01-01 00:00:00']], ['changes' => ['role' => 'technician']]];
    }

    public function test_route_uses_sanctum_before_active_user_middleware(): void
    {
        $route = Route::getRoutes()->match(Request::create('/api/technicians', 'GET'));
        $middleware = Route::gatherRouteMiddleware($route);

        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(
            array_search(EnsureUserIsActive::class, $middleware, true),
            array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true),
        );
    }
}
