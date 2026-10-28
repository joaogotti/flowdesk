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

class AdminIndexUserTest extends TestCase
{
    private const ENDPOINT = '/api/admin/users';

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertSame('sqlite', config('database.default'));
        $this->assertSame(':memory:', config('database.connections.sqlite.database'));
        (require database_path('migrations/0001_01_01_000000_create_users_table.php'))->up();
        Schema::table('users', function (Blueprint $table): void {
            $table->string('role', 20)->default('requester');
            $table->timestampTz('disabled_at')->nullable();
        });
        config(['sanctum.stateful' => ['localhost:5173']]);
        $this->withHeader('Origin', 'http://localhost:5173');
        $this->travelTo(now()->startOfSecond());
    }

    public function test_admin_lists_all_roles_and_states_with_exact_safe_fields(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        foreach (['requester', 'technician', 'admin'] as $role) {
            foreach ([null, now()] as $disabledAt) {
                User::factory()->create(['role' => $role, 'disabled_at' => $disabledAt, 'remember_token' => 'private-token-marker']);
            }
        }
        $expected = User::orderBy('name')->orderBy('id')->get()->map(fn (User $user): array => $this->row($user))->all();

        $response = $this->actingAs($admin, 'web')->getJson(self::ENDPOINT)->assertOk()
            ->assertHeader('Content-Type', 'application/json')->assertJsonPath('data', $expected)
            ->assertJsonPath('total', 7)->assertJsonPath('per_page', 15)->assertJsonPath('current_page', 1);

        foreach ($response->json('data') as $row) {
            $this->assertSame(['id', 'name', 'email', 'role', 'disabled_at', 'created_at'], array_keys($row));
            $this->assertIsInt($row['id']);
        }
        foreach (['password', 'remember_token', 'email_verified_at', 'updated_at', 'payload', 'private-token-marker'] as $secret) {
            $response->assertDontSee($secret, false);
        }
        foreach (User::all() as $user) {
            $response->assertDontSee($user->password, false);
        }
        $this->assertSame(['current_page', 'data', 'first_page_url', 'from', 'last_page', 'last_page_url', 'links', 'next_page_url', 'path', 'per_page', 'prev_page_url', 'to', 'total'], array_keys($response->json()));
    }

    public function test_guest_is_unauthorized_before_query_validation(): void
    {
        $this->getJson(self::ENDPOINT.'?role=invalid&per_page=1000')->assertUnauthorized()->assertJsonMissingPath('data');
    }

    #[DataProvider('nonAdminRoles')]
    public function test_non_admin_is_forbidden_even_with_admin_query_parameters(string $role): void
    {
        $user = User::factory()->create(['role' => $role]);
        $this->actingAs($user, 'web')->getJson(self::ENDPOINT.'?role=admin&status=active&per_page=invalid')
            ->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
    }

    public static function nonAdminRoles(): array
    {
        return [['requester'], ['technician'], ['unknown']];
    }

    #[DataProvider('roles')]
    public function test_disabled_users_are_forbidden(string $role): void
    {
        $user = User::factory()->create(['role' => $role, 'disabled_at' => now()]);
        $this->actingAs($user, 'web')->getJson(self::ENDPOINT)->assertForbidden()->assertJsonMissingPath('data');
    }

    public static function roles(): array
    {
        return [['requester'], ['technician'], ['admin']];
    }

    public function test_search_matches_name_or_email_without_case_or_surrounding_spaces_and_escapes_wildcards(): void
    {
        $admin = User::factory()->create(['role' => 'admin', 'name' => 'Administrador', 'email' => 'admin@example.invalid']);
        $name = User::factory()->create(['name' => 'Bruno Suporte', 'email' => 'one@example.invalid']);
        $email = User::factory()->create(['name' => 'Outro nome', 'email' => 'contato.bruno@example.invalid']);
        $literal = User::factory()->create(['name' => "Equipe 50%_! O'Neil"]);
        User::factory()->create(['name' => 'Equipe 500abc', 'email' => 'noise@example.invalid']);
        foreach (['BRUNO', ' bruno '] as $search) {
            $this->actingAs($admin, 'web')->getJson(self::ENDPOINT.'?'.http_build_query(['search' => $search]))
                ->assertOk()->assertJsonPath('data', [$this->row($name), $this->row($email)]);
        }
        foreach (['%', '_', '!', "O'Neil", '50%_!'] as $search) {
            $this->actingAs($admin, 'web')->getJson(self::ENDPOINT.'?'.http_build_query(['search' => $search]))
                ->assertOk()->assertJsonPath('data', [$this->row($literal)]);
        }
        $this->actingAs($admin, 'web')->getJson(self::ENDPOINT.'?'.http_build_query(['search' => "' OR 1=1 --"]))
            ->assertOk()->assertJsonPath('total', 0)->assertJsonPath('data', []);
    }

    public function test_filters_individually_and_together_keep_search_or_grouped(): void
    {
        $admin = User::factory()->create(['role' => 'admin', 'name' => 'Admin', 'email' => 'admin@example.invalid']);
        $records = collect();
        foreach (['requester', 'technician', 'admin'] as $role) {
            foreach ([null, now(), now()->addDay()] as $disabledAt) {
                $records->push(User::factory()->create(['role' => $role, 'name' => 'Alvo '.$role, 'disabled_at' => $disabledAt]));
            }
        }
        // Email-only matches in other roles/states must not bypass the AND filters.
        User::factory()->create(['role' => 'requester', 'email' => 'alvo.public@example.invalid']);
        User::factory()->create(['role' => 'technician', 'disabled_at' => now(), 'email' => 'alvo.disabled@example.invalid']);
        $all = User::orderBy('name')->orderBy('id')->get();
        $cases = [];
        foreach (['requester', 'technician', 'admin'] as $role) {
            $cases[] = [['role' => $role], $all->where('role', $role)];
        }
        foreach (['active', 'disabled'] as $status) {
            $cases[] = [['status' => $status], $all->filter(fn (User $user): bool => ($user->disabled_at === null) === ($status === 'active'))];
        }
        $cases[] = [['role' => 'technician', 'status' => 'active', 'search' => 'alvo'], $records->where('role', 'technician')->whereNull('disabled_at')];
        foreach ($cases as [$query, $expected]) {
            $this->actingAs($admin, 'web')->getJson(self::ENDPOINT.'?'.http_build_query($query))->assertOk()
                ->assertJsonPath('data', $expected->map(fn (User $user): array => $this->row($user))->values()->all());
        }
    }

    public function test_pagination_uses_stable_name_then_id_order_and_keeps_validated_filters_in_links(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $z = User::factory()->create(['role' => 'technician', 'name' => 'Zulu']);
        $first = User::factory()->create(['role' => 'technician', 'name' => 'Bruno']);
        $a = User::factory()->create(['role' => 'technician', 'name' => 'Ana']);
        $second = User::factory()->create(['role' => 'technician', 'name' => 'Bruno']);
        $query = ['role' => 'technician', 'status' => 'active', 'per_page' => 2];
        $one = $this->actingAs($admin, 'web')->getJson(self::ENDPOINT.'?'.http_build_query($query))->assertOk()
            ->assertJsonPath('data', [$this->row($a), $this->row($first)])->assertJsonPath('total', 4)->assertJsonPath('last_page', 2)
            ->assertJsonPath('from', 1)->assertJsonPath('to', 2)->assertJsonPath('prev_page_url', null);
        parse_str(parse_url($one->json('next_page_url'), PHP_URL_QUERY), $linkQuery);
        $this->assertEquals([...$query, 'page' => 2], $linkQuery);
        $this->actingAs($admin, 'web')->getJson(self::ENDPOINT.'?'.http_build_query([...$query, 'page' => 2]))->assertOk()
            ->assertJsonPath('data', [$this->row($second), $this->row($z)])->assertJsonPath('current_page', 2)
            ->assertJsonPath('next_page_url', null)->assertJsonPath('from', 3)->assertJsonPath('to', 4);
        $this->actingAs($admin, 'web')->getJson(self::ENDPOINT.'?'.http_build_query([...$query, 'page' => 3]))->assertOk()
            ->assertJsonPath('data', [])->assertJsonPath('total', 4)->assertJsonPath('from', null)->assertJsonPath('to', null);
    }

    public function test_default_page_size_maximum_and_empty_result(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        User::factory()->count(104)->create();
        $this->actingAs($admin, 'web')->getJson(self::ENDPOINT)->assertOk()->assertJsonCount(15, 'data')->assertJsonPath('total', 105);
        $this->actingAs($admin, 'web')->getJson(self::ENDPOINT.'?per_page=100')->assertOk()->assertJsonCount(100, 'data')->assertJsonPath('last_page', 2);
        $this->actingAs($admin, 'web')->getJson(self::ENDPOINT.'?search=not-found-marker')->assertOk()
            ->assertJsonPath('data', [])->assertJsonPath('total', 0)->assertJsonPath('last_page', 1)
            ->assertJsonPath('next_page_url', null)->assertJsonPath('prev_page_url', null);
    }

    #[DataProvider('invalidQueries')]
    public function test_invalid_query_parameters_return_422(array $query, string $field): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $this->actingAs($admin, 'web')->getJson(self::ENDPOINT.'?'.http_build_query($query))
            ->assertUnprocessable()->assertJsonValidationErrors($field)->assertJsonMissingPath('data');
    }

    public static function invalidQueries(): array
    {
        return [
            [['role' => 'superadmin'], 'role'], [['role' => ['admin']], 'role'], [['role' => ''], 'role'],
            [['status' => 'inactive'], 'status'], [['status' => ['active']], 'status'], [['status' => ''], 'status'],
            [['search' => ''], 'search'], [['search' => '   '], 'search'], [['search' => str_repeat('a', 256)], 'search'],
            [['search' => ['admin']], 'search'], [['search' => "a\0b"], 'search'],
            [['page' => 0], 'page'], [['page' => -1], 'page'], [['page' => '1.5'], 'page'], [['page' => 'abc'], 'page'],
            [['page' => 1000001], 'page'], [['page' => '999999999999999999999999'], 'page'], [['page' => [1]], 'page'],
            [['per_page' => 0], 'per_page'], [['per_page' => 101], 'per_page'], [['per_page' => '1.5'], 'per_page'],
            [['per_page' => 'abc'], 'per_page'], [['per_page' => [15]], 'per_page'], [['per_page' => ''], 'per_page'],
            [['fields' => 'password,remember_token'], 'query'], [['sort' => 'password'], 'query'], [['include' => 'sessions'], 'query'],
        ];
    }

    public function test_nullable_dates_and_maximum_search_length_are_supported(): void
    {
        $name = str_repeat('a', 255);
        $admin = User::factory()->create(['role' => 'admin', 'name' => $name]);
        DB::table('users')->where('id', $admin->id)->update(['created_at' => null]);
        $this->actingAs($admin, 'web')->getJson(self::ENDPOINT.'?'.http_build_query(['search' => $name]))->assertOk()
            ->assertJsonCount(1, 'data')->assertJsonPath('data.0.created_at', null)->assertJsonPath('data.0.disabled_at', null);
    }

    public function test_queries_select_only_safe_columns_and_apply_limit_and_offset_in_database(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        User::factory()->count(8)->create();
        DB::flushQueryLog();
        DB::enableQueryLog();
        $this->actingAs($admin, 'web')->getJson(self::ENDPOINT.'?per_page=2&page=2')->assertOk()->assertJsonCount(2, 'data');
        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        $this->assertCount(2, $queries);
        $this->assertStringContainsString('count(*)', $queries[0]['query']);
        $this->assertStringContainsString('select "id", "name", "email", "role", "disabled_at", "created_at"', $queries[1]['query']);
        $this->assertStringContainsString('order by "name" asc, "id" asc limit 2 offset 2', $queries[1]['query']);
        foreach ($queries as $query) {
            $this->assertMatchesRegularExpression('/^select\b/i', $query['query']);
        }
    }

    public function test_existing_session_can_read_without_changes_or_session_rotation(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $this->postJson('/api/login', ['email' => $admin->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $token = session()->token();
        $before = [];
        foreach (['users', 'sessions', 'password_reset_tokens'] as $table) {
            $before[$table] = DB::table($table)->get()->toJson();
        }
        Auth::forgetGuards();
        DB::flushQueryLog();
        DB::enableQueryLog();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)->getJson(self::ENDPOINT)->assertOk();
        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        foreach ($queries as $query) {
            $this->assertMatchesRegularExpression('/^select\b/i', $query['query']);
        }
        foreach ($before as $table => $snapshot) {
            $this->assertSame($snapshot, DB::table($table)->get()->toJson());
        }
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($token, session()->token());
    }

    #[DataProvider('lostAccess')]
    public function test_admin_disabled_or_demoted_after_login_is_forbidden(array $changes): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $this->postJson('/api/login', ['email' => $admin->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $admin->update($changes);
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)->getJson(self::ENDPOINT)->assertForbidden()->assertJsonMissingPath('data');
    }

    public static function lostAccess(): array
    {
        return [[['disabled_at' => '2026-01-01 00:00:00']], [['role' => 'technician']], [['role' => 'requester']]];
    }

    public function test_listing_route_requires_sanctum_before_active_user_check(): void
    {
        $route = Route::getRoutes()->match(Request::create(self::ENDPOINT, 'GET'));
        $middleware = Route::gatherRouteMiddleware($route);
        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(array_search(EnsureUserIsActive::class, $middleware, true), array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true));
        $this->assertSame(['GET', 'HEAD'], $route->methods());
        $this->postJson(self::ENDPOINT)->assertUnauthorized();
    }

    private function row(User $user): array
    {
        $user->refresh();

        return [
            'id' => $user->id, 'name' => $user->name, 'email' => $user->email, 'role' => $user->role,
            'disabled_at' => $user->disabled_at?->toISOString(), 'created_at' => $user->created_at?->toISOString(),
        ];
    }
}
