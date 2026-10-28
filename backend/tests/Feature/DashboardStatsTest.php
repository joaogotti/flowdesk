<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Models\TicketStatus;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class DashboardStatsTest extends TestCase
{
    use AssignmentFixtures;

    private const STATUSES = ['open', 'in_progress', 'waiting_requester', 'resolved', 'closed', 'cancelled'];

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
    public function test_empty_database_returns_exact_integer_zeros(string $role): void
    {
        $user = User::factory()->create(['role' => $role]);

        $this->actingAs($user, 'web')->getJson('/api/dashboard/stats')
            ->assertOk()->assertExactJson(['data' => array_fill_keys(['total', ...self::STATUSES, 'unassigned'], 0)]);
    }

    #[DataProvider('roles')]
    public function test_all_statuses_assignments_and_visibility_match_the_listing(string $role): void
    {
        $user = User::factory()->create(['role' => $role]);
        $technician = User::factory()->create(['role' => 'technician']);

        // IDs deliberately differ from their seeded values; only status codes matter.
        foreach (self::STATUSES as $index => $code) {
            $status = TicketStatus::where('code', $code)->sole();
            $status->id = 100 + $index;
            $status->save();
            $this->ticket(['requester_id' => $user->id, 'assigned_to' => null, 'status_id' => $status->id]);
            $this->ticket(['requester_id' => $user->id, 'assigned_to' => $technician->id, 'status_id' => $status->id]);
            if ($role === 'technician') {
                $this->ticket(['assigned_to' => $user->id, 'status_id' => $status->id]);
            }
            $this->ticket(['assigned_to' => null, 'status_id' => $status->id]);
            $this->ticket(['assigned_to' => $technician->id, 'status_id' => $status->id]);
        }

        $expectedPerStatus = match ($role) {
            'admin' => 4,
            'technician' => 3,
            'requester' => 2,
        };
        $expectedUnassigned = $role === 'requester' ? 6 : 12;
        $response = $this->actingAs($user, 'web')->getJson('/api/dashboard/stats')->assertOk();
        $expected = ['total' => 6 * $expectedPerStatus, ...array_fill_keys(self::STATUSES, $expectedPerStatus), 'unassigned' => $expectedUnassigned];
        $response->assertExactJson(['data' => $expected]);
        foreach ($response->json('data') as $count) {
            $this->assertIsInt($count);
            $this->assertGreaterThanOrEqual(0, $count);
        }
        $this->assertSame($response->json('data.total'), array_sum(array_intersect_key($response->json('data'), array_flip(self::STATUSES))));
        $this->getJson('/api/tickets')->assertOk()->assertJsonPath('total', $expected['total']);
    }

    #[DataProvider('roles')]
    public function test_invisible_tickets_return_zeros_and_query_parameters_cannot_change_scope(string $role): void
    {
        $user = User::factory()->create(['role' => $role]);
        $technician = User::factory()->create(['role' => 'technician']);
        // A technician's authorship never grants access to another technician's assignment.
        $this->ticket([
            'requester_id' => $role === 'technician' ? $user->id : $this->requester->id,
            'assigned_to' => $technician->id,
        ]);

        $expected = array_fill_keys(['total', ...self::STATUSES, 'unassigned'], 0);
        if ($role === 'admin') {
            $expected['total'] = $expected['open'] = 1;
        }
        $this->actingAs($user, 'web')
            ->getJson('/api/dashboard/stats?role=admin&requester_id='.$this->requester->id.'&assigned_to='.$technician->id)
            ->assertOk()->assertExactJson(['data' => $expected]);
    }

    public function test_guest_is_unauthorized_and_disabled_user_is_forbidden(): void
    {
        $this->getJson('/api/dashboard/stats')->assertUnauthorized();
        $this->requester->update(['disabled_at' => now()]);
        $this->actingAs($this->requester, 'web')->getJson('/api/dashboard/stats')
            ->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
    }

    public function test_unknown_role_is_forbidden(): void
    {
        $this->requester->update(['role' => 'unknown']);
        $this->actingAs($this->requester, 'web')->getJson('/api/dashboard/stats')->assertForbidden();
    }

    public function test_session_authentication_single_aggregate_and_preservation_of_existing_data(): void
    {
        $this->ticket();
        $this->postJson('/api/login', ['email' => $this->requester->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $csrfToken = session()->token();
        $before = $this->snapshot();
        Auth::forgetGuards();
        DB::enableQueryLog();

        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
            ->getJson('/api/dashboard/stats')->assertOk()->assertJsonPath('data.total', 1);

        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        $ticketQueries = array_values(array_filter($queries, fn (array $query): bool => str_contains($query['query'], '"tickets"')));
        $this->assertCount(1, $ticketQueries);
        $this->assertStringContainsString('COUNT(', $ticketQueries[0]['query']);
        foreach ($queries as $query) {
            $this->assertDoesNotMatchRegularExpression('/\b(insert|update|delete|replace|create|alter|drop|truncate)\b/i', $query['query']);
        }
        $this->assertSame($before, $this->snapshot());
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($csrfToken, session()->token());

        $this->requester->update(['disabled_at' => now()]);
        Auth::forgetGuards();
        $this->getJson('/api/dashboard/stats')->assertForbidden();
    }

    public function test_route_requires_sanctum_then_active_user(): void
    {
        $route = Route::getRoutes()->match(Request::create('/api/dashboard/stats', 'GET'));
        $middleware = Route::gatherRouteMiddleware($route);
        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(
            array_search(EnsureUserIsActive::class, $middleware, true),
            array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true),
        );
    }
}
