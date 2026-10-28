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

class DashboardCategoriesTest extends TestCase
{
    use AssignmentFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertSame('sqlite', config('database.default'));
        $this->assertSame(':memory:', config('database.connections.sqlite.database'));
        $this->createAssignmentFixtures();
    }

    public static function roles(): array
    {
        return [['admin'], ['technician'], ['requester']];
    }

    #[DataProvider('roles')]
    public function test_visibility_all_statuses_inactive_categories_and_total_consistency(string $role): void
    {
        $user = User::factory()->create(['role' => $role]);
        $otherTechnician = User::factory()->create(['role' => 'technician']);
        $active = Category::create(['name' => 'Categoria ativa']);
        $inactive = Category::create(['name' => 'Categoria inativa', 'is_active' => false]);
        $empty = Category::create(['name' => 'Categoria vazia', 'is_active' => false]);

        foreach (TicketStatus::all() as $status) {
            $this->ticket(['category_id' => $active->id, 'status_id' => $status->id, 'requester_id' => $user->id, 'assigned_to' => null]);
            $this->ticket(['category_id' => $inactive->id, 'status_id' => $status->id, 'assigned_to' => $role === 'technician' ? $user->id : null]);
            // Authorship does not grant technicians access to another technician's assignment.
            $this->ticket(['category_id' => $inactive->id, 'status_id' => $status->id, 'requester_id' => $user->id, 'assigned_to' => $otherTechnician->id]);
        }

        $response = $this->actingAs($user, 'web')->getJson('/api/dashboard/categories')->assertOk();
        $rows = collect($response->json('data'))->keyBy('id');
        $this->assertSame(6, $rows[$active->id]['count']);
        $this->assertSame(match ($role) {
            'admin' => 12,
            default => 6,
        }, $rows[$inactive->id]['count']);
        $this->assertSame(0, $rows[$empty->id]['count']);
        $this->assertCount(Category::count(), $rows);
        foreach ($rows as $row) {
            $this->assertSame(['id', 'name', 'count'], array_keys($row));
            $this->assertIsInt($row['id']);
            $this->assertIsString($row['name']);
            $this->assertIsInt($row['count']);
            $this->assertGreaterThanOrEqual(0, $row['count']);
        }
        $total = $this->getJson('/api/dashboard/stats')->assertOk()->json('data.total');
        $this->assertSame($total, $rows->sum('count'));
        $this->assertSame($role === 'admin' ? 18 : 12, $total);
    }

    #[DataProvider('roles')]
    public function test_categories_without_visible_tickets_have_zero_counts(string $role): void
    {
        $user = User::factory()->create(['role' => $role]);
        $category = Category::firstOrFail();
        $otherTechnician = User::factory()->create(['role' => 'technician']);
        $this->ticket(['assigned_to' => $otherTechnician->id, 'requester_id' => $role === 'technician' ? $user->id : $this->requester->id]);

        $response = $this->actingAs($user, 'web')->getJson('/api/dashboard/categories?role=admin&requester_id='.$this->requester->id.'&assigned_to='.$otherTechnician->id)->assertOk();
        foreach ($response->json('data') as $row) {
            $this->assertSame($role === 'admin' && $row['id'] === $category->id ? 1 : 0, $row['count']);
        }
    }

    #[DataProvider('roles')]
    public function test_no_tickets_returns_all_categories_with_integer_zeros(string $role): void
    {
        $user = User::factory()->create(['role' => $role]);
        $expected = Category::orderBy('name')->orderBy('id')->get()->map(fn (Category $category): array => [
            'id' => $category->id, 'name' => $category->name, 'count' => 0,
        ])->all();
        $this->actingAs($user, 'web')->getJson('/api/dashboard/categories')->assertOk()->assertExactJson(['data' => $expected]);
    }

    public function test_order_is_count_descending_then_name_and_id_ascending(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        // Insert out of alphabetical order to ensure names, rather than IDs, break count ties.
        $zulu = Category::create(['name' => 'Zulu']);
        $beta = Category::create(['name' => 'Beta']);
        $alpha = Category::create(['name' => 'Alpha']);
        foreach ([$beta, $zulu, $alpha, $zulu] as $category) {
            $this->ticket(['category_id' => $category->id]);
        }
        $expected = [
            ['id' => $zulu->id, 'name' => 'Zulu', 'count' => 2],
            ['id' => $alpha->id, 'name' => 'Alpha', 'count' => 1],
            ['id' => $beta->id, 'name' => 'Beta', 'count' => 1],
            ...Category::whereNotIn('id', [$zulu->id, $alpha->id, $beta->id])->orderBy('name')->get()->map(fn (Category $category): array => [
                'id' => $category->id, 'name' => $category->name, 'count' => 0,
            ])->all(),
        ];
        $this->actingAs($admin, 'web')->getJson('/api/dashboard/categories')->assertOk()->assertExactJson(['data' => $expected]);
    }

    public function test_no_categories_returns_an_empty_array(): void
    {
        Category::query()->delete();
        $this->actingAs($this->requester, 'web')->getJson('/api/dashboard/categories')->assertOk()->assertExactJson(['data' => []]);
    }

    public function test_guest_disabled_and_unknown_role(): void
    {
        $this->getJson('/api/dashboard/categories')->assertUnauthorized();
        $this->requester->update(['disabled_at' => now()]);
        $this->actingAs($this->requester, 'web')->getJson('/api/dashboard/categories')->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
        $this->requester->update(['disabled_at' => null, 'role' => 'unknown']);
        $this->getJson('/api/dashboard/categories')->assertForbidden();
    }

    public function test_session_single_aggregate_order_and_preservation_of_data(): void
    {
        $this->ticket();
        $this->postJson('/api/login', ['email' => $this->requester->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $csrfToken = session()->token();
        $before = $this->snapshot();
        Auth::forgetGuards();
        DB::enableQueryLog();
        try {
            $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)->getJson('/api/dashboard/categories')->assertOk();
            $queries = DB::getQueryLog();
        } finally {
            DB::disableQueryLog();
        }
        $aggregates = array_values(array_filter($queries, fn (array $query): bool => str_contains($query['query'], '"tickets"')));
        $this->assertCount(1, $aggregates);
        $this->assertStringContainsString('COUNT(*)', $aggregates[0]['query']);
        // Category names are unique in the schema; verify the final ID tie-breaker in SQL.
        $this->assertStringContainsString('order by "count" desc, "categories"."name" asc, "categories"."id" asc', $aggregates[0]['query']);
        foreach ($queries as $query) {
            $this->assertDoesNotMatchRegularExpression('/\b(insert|update|delete|replace|create|alter|drop|truncate)\b/i', $query['query']);
        }
        $this->assertSame($before, $this->snapshot());
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($csrfToken, session()->token());
    }

    public function test_route_requires_sanctum_then_active_user(): void
    {
        $route = Route::getRoutes()->match(Request::create('/api/dashboard/categories', 'GET'));
        $middleware = Route::gatherRouteMiddleware($route);
        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(array_search(EnsureUserIsActive::class, $middleware, true), array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true));
    }
}
