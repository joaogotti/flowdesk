<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Models\Category;
use App\Models\User;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Schema;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class IndexCategoryTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();

        $this->assertSame('sqlite', config('database.default'));
        $this->assertSame(':memory:', config('database.connections.sqlite.database'));

        $migration = require database_path('migrations/0001_01_01_000000_create_users_table.php');
        $migration->up();

        // Segue a suíte existente, sem executar os CHECKs específicos do PostgreSQL.
        Schema::table('users', function (Blueprint $table) {
            $table->string('role', 20)->default('requester');
            $table->timestampTz('disabled_at')->nullable();
        });

        $migration = require database_path('migrations/2026_10_19_194356_create_categories_table.php');
        $migration->up();

        config(['sanctum.stateful' => ['localhost:5173']]);
        $this->withHeader('Origin', 'http://localhost:5173');
    }

    public function test_lists_only_active_categories_with_the_exact_public_structure(): void
    {
        $user = User::factory()->create(['role' => 'requester']);
        $category = Category::create([
            'name' => 'Hardware',
            'description' => 'Descrição interna que não deve ser retornada.',
            'is_active' => true,
        ]);
        Category::create(['name' => 'Inativa', 'description' => 'Interna', 'is_active' => false]);

        $this->actingAs($user, 'web')->getJson('/api/categories')
            ->assertOk()
            ->assertHeader('Content-Type', 'application/json')
            ->assertExactJson(['data' => [['id' => $category->id, 'name' => 'Hardware']]]);
    }

    public function test_orders_by_name_and_uses_id_as_the_secondary_order(): void
    {
        $user = User::factory()->create(['role' => 'requester']);
        $software = Category::create(['name' => 'Software']);
        $acesso = Category::create(['name' => 'Acesso']);
        $hardware = Category::create(['name' => 'Hardware']);
        DB::enableQueryLog();

        $response = $this->actingAs($user, 'web')->getJson('/api/categories')->assertOk();

        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        $this->assertSame([$acesso->id, $hardware->id, $software->id], array_column($response->json('data'), 'id'));

        // O índice UNIQUE de name impede empates reais; verifica o desempate na consulta.
        $categoryQueries = array_values(array_filter(
            $queries,
            fn (array $query): bool => str_contains($query['query'], 'from "categories"'),
        ));
        $this->assertCount(1, $categoryQueries);
        $this->assertStringContainsString('order by "name" asc, "id" asc', $categoryQueries[0]['query']);
    }

    public function test_returns_an_empty_array_when_no_categories_exist(): void
    {
        $this->actingAs(User::factory()->create(['role' => 'requester']), 'web')->getJson('/api/categories')
            ->assertOk()->assertExactJson(['data' => []]);
    }

    public function test_returns_an_empty_array_when_all_categories_are_inactive(): void
    {
        Category::create(['name' => 'Inativa', 'is_active' => false]);

        $this->actingAs(User::factory()->create(['role' => 'requester']), 'web')->getJson('/api/categories')
            ->assertOk()->assertExactJson(['data' => []]);
    }

    #[DataProvider('allowedRoles')]
    public function test_all_supported_roles_can_list_categories(string $role): void
    {
        $category = Category::create(['name' => 'Rede']);

        $this->actingAs(User::factory()->create(['role' => $role]), 'web')
            ->getJson('/api/categories')->assertOk()
            ->assertExactJson(['data' => [['id' => $category->id, 'name' => 'Rede']]]);
    }

    public static function allowedRoles(): array
    {
        return [['requester'], ['technician'], ['admin']];
    }

    public function test_guest_cannot_list_categories(): void
    {
        $this->getJson('/api/categories')->assertUnauthorized()->assertJsonMissingPath('data');
    }

    #[DataProvider('allowedRoles')]
    public function test_disabled_users_cannot_list_categories(string $role): void
    {
        $user = User::factory()->create(['role' => $role, 'disabled_at' => now()]);

        $this->actingAs($user, 'web')->getJson('/api/categories')
            ->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
    }

    public function test_unknown_role_is_forbidden(): void
    {
        $this->actingAs(User::factory()->create(['role' => 'unknown']), 'web')
            ->getJson('/api/categories')->assertForbidden()->assertJsonMissingPath('data');
    }

    public function test_existing_session_can_list_without_modifying_records_or_rotating_the_session(): void
    {
        $user = User::factory()->create(['role' => 'requester']);
        Category::create(['name' => 'Hardware', 'description' => 'Interna']);
        Category::create(['name' => 'Inativa', 'is_active' => false]);
        $this->postJson('/api/login', ['email' => $user->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $csrfToken = session()->token();
        $before = [];
        $tables = ['categories' => 'id', 'users' => 'id', 'sessions' => 'id', 'password_reset_tokens' => 'email'];
        foreach ($tables as $table => $key) {
            $before[$table] = DB::table($table)->orderBy($key)->get()->toJson();
        }
        Auth::forgetGuards();
        DB::enableQueryLog();

        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
            ->getJson('/api/categories')->assertOk();

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

    public function test_user_disabled_after_login_loses_access(): void
    {
        $user = User::factory()->create(['role' => 'requester']);
        $this->postJson('/api/login', ['email' => $user->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $user->update(['disabled_at' => now()]);
        Auth::forgetGuards();

        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
            ->getJson('/api/categories')->assertForbidden()
            ->assertExactJson(['message' => 'Acesso não permitido.']);
    }

    public function test_route_uses_sanctum_before_the_active_user_middleware(): void
    {
        $route = Route::getRoutes()->match(Request::create('/api/categories', 'GET'));
        $middleware = Route::gatherRouteMiddleware($route);

        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(
            array_search(EnsureUserIsActive::class, $middleware, true),
            array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true),
        );
    }
}
