<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Models\Category;
use App\Models\TicketStatus;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class AdminIndexCategoryTest extends TestCase
{
    use AssignmentFixtures;

    protected function setUp(): void
    {
        parent::setUp();

        $this->assertSame('sqlite', config('database.default'));
        $this->assertSame(':memory:', config('database.connections.sqlite.database'));
        $this->createAssignmentFixtures();
    }

    public function test_admin_lists_active_inactive_and_empty_categories_with_exact_types_and_all_status_counts(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $technician = User::factory()->create(['role' => 'technician']);
        $active = Category::create(['name' => 'Categoria ativa', 'is_active' => true, 'description' => 'Informação interna']);
        $inactive = Category::create(['name' => 'Categoria inativa', 'is_active' => false]);
        Category::create(['name' => 'Categoria inativa vazia', 'is_active' => false]);
        foreach (TicketStatus::all() as $status) {
            $this->ticket(['category_id' => $active->id, 'status_id' => $status->id, 'assigned_to' => null]);
            $this->ticket(['category_id' => $inactive->id, 'status_id' => $status->id, 'assigned_to' => $technician->id]);
        }
        $expected = Category::orderBy('name')->orderBy('id')->get()->map(fn (Category $category): array => [
            'id' => $category->id, 'name' => $category->name, 'is_active' => $category->is_active,
            'tickets_count' => in_array($category->id, [$active->id, $inactive->id], true) ? 6 : 0,
        ])->all();

        $response = $this->actingAs($admin, 'web')->getJson('/api/admin/categories')
            ->assertOk()->assertHeader('Content-Type', 'application/json')->assertExactJson(['data' => $expected]);
        foreach ($response->json('data') as $row) {
            $this->assertIsInt($row['id']);
            $this->assertIsString($row['name']);
            $this->assertIsBool($row['is_active']);
            $this->assertIsInt($row['tickets_count']);
            $this->assertGreaterThanOrEqual(0, $row['tickets_count']);
        }
        $this->assertSame(12, array_sum(array_column($response->json('data'), 'tickets_count')));
        foreach ([$this->requester->email, $this->requester->name, $technician->email, $technician->name, 'Informação interna', 'Solicitação de teste', 'password', 'requester_id', 'assigned_to'] as $private) {
            $response->assertDontSee($private, false);
        }
    }

    public function test_name_order_is_independent_of_ids_and_ticket_counts(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $zulu = Category::create(['name' => 'Zulu']);
        Category::create(['name' => 'Alpha', 'is_active' => false]);
        $this->ticket(['category_id' => $zulu->id]);
        $expectedIds = Category::orderBy('name')->orderBy('id')->pluck('id')->all();

        $response = $this->actingAs($admin, 'web')->getJson('/api/admin/categories')->assertOk();
        $this->assertSame($expectedIds, array_column($response->json('data'), 'id'));
        $this->assertSame($zulu->id, $response->json('data.'.(count($expectedIds) - 1).'.id'));
    }

    public function test_no_categories_returns_an_empty_array(): void
    {
        Category::query()->delete();
        $this->actingAs(User::factory()->create(['role' => 'admin']), 'web')->getJson('/api/admin/categories')
            ->assertOk()->assertExactJson(['data' => []]);
    }

    public static function forbiddenRoles(): array
    {
        return [['technician'], ['requester'], ['unknown']];
    }

    #[DataProvider('forbiddenRoles')]
    public function test_non_admin_users_cannot_access_or_elevate_permissions_through_query_parameters(string $role): void
    {
        $this->ticket();
        $this->actingAs(User::factory()->create(['role' => $role]), 'web')
            ->getJson('/api/admin/categories?role=admin&is_active=1&fields=*')
            ->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
    }

    public function test_guest_is_unauthorized_without_category_data(): void
    {
        $this->getJson('/api/admin/categories')->assertUnauthorized()->assertJsonMissingPath('data');
    }

    public static function roles(): array
    {
        return [['admin'], ['technician'], ['requester']];
    }

    #[DataProvider('roles')]
    public function test_disabled_users_are_forbidden(string $role): void
    {
        $this->actingAs(User::factory()->create(['role' => $role, 'disabled_at' => now()]), 'web')
            ->getJson('/api/admin/categories')->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
    }

    public function test_admin_session_single_count_query_and_read_only_behavior(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $this->ticket();
        Category::create(['name' => 'Inativa', 'is_active' => false]);
        $this->postJson('/api/login', ['email' => $admin->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $csrfToken = session()->token();
        $before = $this->snapshot();
        Auth::forgetGuards();
        DB::enableQueryLog();
        try {
            $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
                ->getJson('/api/admin/categories')->assertOk();
            $queries = DB::getQueryLog();
        } finally {
            DB::disableQueryLog();
        }
        $categoryQueries = array_values(array_filter($queries, fn (array $query): bool => str_contains($query['query'], 'from "categories"')));
        $this->assertCount(1, $categoryQueries);
        $this->assertMatchesRegularExpression('/select count\(\*\) from "tickets"/i', $categoryQueries[0]['query']);
        // Names are unique; verify the secondary ID order in the generated SQL.
        $this->assertStringContainsString('order by "name" asc, "id" asc', $categoryQueries[0]['query']);
        $ticketQueries = array_filter($queries, fn (array $query): bool => str_contains($query['query'], '"tickets"'));
        $this->assertCount(1, $ticketQueries);
        foreach ($queries as $query) {
            $this->assertDoesNotMatchRegularExpression('/\b(insert|update|delete|replace|create|alter|drop|truncate)\b/i', $query['query']);
        }
        $this->assertSame($before, $this->snapshot());
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($csrfToken, session()->token());
    }

    public static function lostAccess(): array
    {
        return [[['role' => 'technician']], [['disabled_at' => '2026-01-01 00:00:00']]];
    }

    #[DataProvider('lostAccess')]
    public function test_admin_who_loses_access_after_login_receives_403(array $changes): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $this->postJson('/api/login', ['email' => $admin->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $admin->update($changes);
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
            ->getJson('/api/admin/categories')->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
    }

    #[DataProvider('roles')]
    public function test_existing_category_contracts_remain_available_to_all_supported_roles(string $role): void
    {
        $user = User::factory()->create(['role' => $role]);
        $inactive = Category::create(['name' => 'Inativa', 'is_active' => false]);
        $this->ticket(['category_id' => $inactive->id]);
        $expected = Category::where('is_active', true)->orderBy('name')->orderBy('id')->get(['id', 'name'])->toArray();
        $this->actingAs($user, 'web')->getJson('/api/categories')->assertOk()->assertExactJson(['data' => $expected]);
        $response = $this->getJson('/api/dashboard/categories')->assertOk();
        foreach ($response->json('data') as $row) {
            $this->assertSame(['id', 'name', 'count'], array_keys($row));
        }
    }

    public function test_route_requires_sanctum_then_active_user(): void
    {
        $route = Route::getRoutes()->match(Request::create('/api/admin/categories', 'GET'));
        $middleware = Route::gatherRouteMiddleware($route);
        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(array_search(EnsureUserIsActive::class, $middleware, true), array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true));
    }
}
