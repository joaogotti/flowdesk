<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Models\TicketStatus;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class DashboardRecentTicketsTest extends TestCase
{
    use AssignmentFixtures;

    private const ENDPOINT = '/api/dashboard/recent-tickets';

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
    public function test_empty_database_returns_an_empty_array(string $role): void
    {
        $user = User::factory()->create(['role' => $role]);
        $this->actingAs($user, 'web')->getJson(self::ENDPOINT)
            ->assertOk()->assertExactJson(['data' => []]);
    }

    public function test_guest_is_unauthorized(): void
    {
        $this->getJson(self::ENDPOINT)->assertUnauthorized();
    }

    #[DataProvider('roles')]
    public function test_disabled_users_are_forbidden(string $role): void
    {
        $user = User::factory()->create(['role' => $role, 'disabled_at' => now()]);
        $this->actingAs($user, 'web')->getJson(self::ENDPOINT)
            ->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
    }

    public function test_unknown_role_is_forbidden(): void
    {
        $this->requester->update(['role' => 'unknown']);
        $this->actingAs($this->requester, 'web')->getJson(self::ENDPOINT)->assertForbidden();
    }

    public function test_requester_only_sees_own_tickets_even_when_newer_foreign_tickets_fill_the_limit(): void
    {
        $other = User::factory()->create(['role' => 'requester']);
        $own = $this->ticket();
        $own->forceFill(['updated_at' => now()->subDay()])->save();
        for ($i = 0; $i < 6; $i++) {
            $this->ticket(['requester_id' => $other->id]);
        }

        $this->actingAs($this->requester, 'web')->getJson(self::ENDPOINT)
            ->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $own->id);
        Auth::forgetGuards();
        $this->actingAs($other, 'web')->getJson(self::ENDPOINT)->assertOk()->assertJsonCount(5, 'data');
    }

    public function test_technician_sees_own_assignments_and_unassigned_but_not_other_assignments(): void
    {
        $tech = User::factory()->create(['role' => 'technician']);
        $otherTech = User::factory()->create(['role' => 'technician']);
        $assigned = $this->ticket(['assigned_to' => $tech->id]);
        $assigned->forceFill(['updated_at' => now()->subDay()])->save();
        $unassigned = $this->ticket();
        $unassigned->forceFill(['updated_at' => now()->subDay()])->save();
        for ($i = 0; $i < 6; $i++) {
            // Authorship does not grant a technician access to another assignment.
            $this->ticket(['requester_id' => $tech->id, 'assigned_to' => $otherTech->id]);
        }

        $response = $this->actingAs($tech, 'web')->getJson(self::ENDPOINT)->assertOk()->assertJsonCount(2, 'data');
        $this->assertSame([$unassigned->id, $assigned->id], array_column($response->json('data'), 'id'));
        $response->assertJsonPath('data.0.assignee', null)
            ->assertJsonPath('data.1.assignee', ['id' => $tech->id, 'name' => $tech->name]);
    }

    public function test_invisible_tickets_return_an_empty_array(): void
    {
        $tech = User::factory()->create(['role' => 'technician']);
        $other = User::factory()->create(['role' => 'technician']);
        $this->ticket(['requester_id' => $other->id, 'assigned_to' => $other->id]);

        foreach ([$this->requester, $tech] as $user) {
            Auth::forgetGuards();
            $this->actingAs($user, 'web')->getJson(self::ENDPOINT)->assertOk()->assertExactJson(['data' => []]);
        }
    }

    public function test_admin_sees_all_requesters_and_assignments(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $tech = User::factory()->create(['role' => 'technician']);
        $other = User::factory()->create(['role' => 'requester']);
        $first = $this->ticket(['assigned_to' => $tech->id]);
        $second = $this->ticket(['requester_id' => $other->id]);

        $response = $this->actingAs($admin, 'web')->getJson(self::ENDPOINT)->assertOk();
        $this->assertSame([$second->id, $first->id], array_column($response->json('data'), 'id'));
    }

    public function test_latest_updates_take_precedence_over_creation_and_id_with_five_row_limit(): void
    {
        $this->ticket()->forceFill(['updated_at' => now()->subDays(5)])->save();
        $mostRecentlyUpdated = $this->ticket();
        $mostRecentlyUpdated->forceFill(['created_at' => now()->subYear(), 'updated_at' => now()->addHour()])->save();
        $tied = [];
        for ($i = 0; $i < 6; $i++) {
            $tied[] = $this->ticket()->id;
        }
        // A higher ID with an older update must not displace newer updates.
        $this->ticket()->forceFill(['updated_at' => now()->subDays(2)])->save();

        $response = $this->actingAs($this->requester, 'web')->getJson(self::ENDPOINT.'?limit=100&per_page=100&sort=id&page=2')
            ->assertOk()->assertJsonCount(5, 'data');
        $this->assertSame([$mostRecentlyUpdated->id, ...array_slice(array_reverse($tied), 0, 4)], array_column($response->json('data'), 'id'));
    }

    public function test_query_parameters_cannot_override_visibility(): void
    {
        $other = User::factory()->create(['role' => 'requester']);
        $own = $this->ticket();
        $this->ticket(['requester_id' => $other->id]);

        $this->actingAs($this->requester, 'web')
            ->getJson(self::ENDPOINT.'?role=admin&requester_id='.$other->id.'&include=comments,activities')
            ->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $own->id);
    }

    public static function statuses(): array
    {
        return [['open'], ['in_progress'], ['waiting_requester'], ['resolved'], ['closed'], ['cancelled']];
    }

    #[DataProvider('statuses')]
    public function test_exact_public_contract_status_names_nullable_assignee_and_iso_dates(string $code): void
    {
        $status = TicketStatus::where('code', $code)->sole();
        $tech = User::factory()->create(['role' => 'technician', 'remember_token' => 'private']);
        $this->travelTo(Carbon::parse('2026-10-26T23:45:12Z'));
        $ticket = $this->ticket(['status_id' => $status->id, 'assigned_to' => $tech->id]);
        $unassigned = $this->ticket(['status_id' => $status->id]);

        $response = $this->actingAs($this->requester, 'web')->getJson(self::ENDPOINT)->assertOk();
        $this->assertSame(['data' => [
            ['id' => $unassigned->id, 'title' => $unassigned->title, 'status' => ['code' => $code, 'name' => $status->name], 'assignee' => null, 'updated_at' => now()->toISOString()],
            ['id' => $ticket->id, 'title' => $ticket->title, 'status' => ['code' => $code, 'name' => $status->name], 'assignee' => ['id' => $tech->id, 'name' => $tech->name], 'updated_at' => now()->toISOString()],
        ]], $response->json());
        $this->assertIsInt($response->json('data.0.id'));
        $this->assertIsString($response->json('data.0.title'));
        $this->assertSame('2026-10-26T23:45:12.000000Z', $response->json('data.0.updated_at'));
    }

    public function test_relationship_queries_are_bounded_and_limit_is_applied_in_sql(): void
    {
        $tech = User::factory()->create(['role' => 'technician']);
        $this->ticket(['assigned_to' => $tech->id]);
        $this->actingAs($this->requester, 'web');
        DB::enableQueryLog();
        $this->getJson(self::ENDPOINT)->assertOk()->assertJsonCount(1, 'data');
        $firstQueryCount = count(DB::getQueryLog());
        DB::disableQueryLog();

        for ($i = 0; $i < 10; $i++) {
            $assignee = User::factory()->create(['role' => 'technician']);
            $ticket = $this->ticket(['assigned_to' => $assignee->id]);
            $ticket->comments()->create(['user_id' => $this->requester->id, 'body' => 'Private comment', 'is_internal' => true]);
            $ticket->activities()->create(['actor_id' => $assignee->id, 'action' => 'created']);
        }
        DB::flushQueryLog();
        DB::enableQueryLog();
        $this->getJson(self::ENDPOINT)->assertOk()->assertJsonCount(5, 'data');
        $queries = DB::getQueryLog();
        DB::disableQueryLog();

        $this->assertSame($firstQueryCount, count($queries));
        $this->assertCount(4, $queries);
        $this->assertStringContainsString('where "users"."id" = ?', $queries[0]['query']);
        $this->assertStringContainsString('order by "updated_at" desc, "id" desc limit 5', $queries[1]['query']);
        foreach ($queries as $query) {
            foreach (['ticket_comments', 'ticket_activities', 'categories', 'sla_policies', 'personal_access_tokens'] as $table) {
                $this->assertStringNotContainsString($table, $query['query']);
            }
        }
    }

    public function test_existing_cookie_session_can_read_without_changing_records_or_rotating_session(): void
    {
        $ticket = $this->ticket();
        $this->postJson('/api/login', ['email' => $this->requester->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $csrfToken = session()->token();
        $before = $this->snapshot();
        Auth::forgetGuards();

        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)->getJson(self::ENDPOINT)
            ->assertOk()->assertJsonPath('data.0.id', $ticket->id);

        $this->assertSame($before, $this->snapshot());
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($csrfToken, session()->token());

        $this->requester->update(['disabled_at' => now()]);
        Auth::forgetGuards();
        $this->getJson(self::ENDPOINT)->assertForbidden();
    }

    public function test_route_requires_sanctum_before_active_user_middleware(): void
    {
        $route = Route::getRoutes()->match(Request::create(self::ENDPOINT, 'GET'));
        $middleware = Route::gatherRouteMiddleware($route);
        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(
            array_search(EnsureUserIsActive::class, $middleware, true),
            array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true),
        );
    }
}
