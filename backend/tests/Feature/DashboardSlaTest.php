<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Models\SlaPolicy;
use App\Models\Ticket;
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

class DashboardSlaTest extends TestCase
{
    use AssignmentFixtures;

    private const ENDPOINT = '/api/dashboard/sla';

    protected function setUp(): void
    {
        parent::setUp();

        $this->assertSame('sqlite', config('database.default'));
        $this->assertSame(':memory:', config('database.connections.sqlite.database'));
        $this->createAssignmentFixtures();
        $this->travelTo(Carbon::parse('2026-10-27T00:00:00Z'));
    }

    public static function roles(): array
    {
        return [['admin'], ['technician'], ['requester']];
    }

    #[DataProvider('roles')]
    public function test_empty_database_has_three_integer_zero_counts(string $role): void
    {
        $user = User::factory()->create(['role' => $role]);
        $this->actingAs($user, 'web')->getJson(self::ENDPOINT)->assertOk()
            ->assertExactJson(['data' => ['on_track' => 0, 'at_risk' => 0, 'overdue' => 0]]);
    }

    public function test_guest_is_unauthorized(): void
    {
        $this->getJson(self::ENDPOINT)->assertUnauthorized();
    }

    #[DataProvider('roles')]
    public function test_disabled_user_cannot_read_counts(string $role): void
    {
        $user = User::factory()->create(['role' => $role, 'disabled_at' => now()]);
        $this->actingAs($user, 'web')->getJson(self::ENDPOINT)->assertForbidden()
            ->assertExactJson(['message' => 'Acesso não permitido.']);
    }

    public function test_unknown_role_is_forbidden(): void
    {
        $this->requester->update(['role' => 'unknown']);
        $this->actingAs($this->requester, 'web')->getJson(self::ENDPOINT)->assertForbidden();
    }

    #[DataProvider('roles')]
    public function test_visibility_isolation_and_unassigned_tickets_follow_the_existing_scope(string $role): void
    {
        $viewer = User::factory()->create(['role' => $role]);
        $otherTech = User::factory()->create(['role' => 'technician']);
        $this->slaTicket(['requester_id' => $viewer->id]);
        // Being the requester does not give a technician access to a foreign assignment.
        $this->slaTicket(['requester_id' => $viewer->id, 'assigned_to' => $otherTech->id, 'resolution_due_at' => now()->subSecond()]);
        $this->slaTicket(['assigned_to' => $role === 'technician' ? $viewer->id : $otherTech->id]);
        $this->slaTicket(['resolution_due_at' => now()->subSecond()]);
        $this->slaTicket(['assigned_to' => $otherTech->id]);
        $this->slaTicket(['requester_id' => $viewer->id, 'first_response_due_at' => now()->addMinutes(3)]);
        $this->slaTicket(['assigned_to' => $otherTech->id, 'resolution_due_at' => now()->addMinutes(3)]);

        [$onTrack, $overdue] = match ($role) {
            'admin' => [3, 2],
            'technician' => [2, 1],
            'requester' => [1, 1],
        };
        $this->actingAs($viewer, 'web')->getJson(self::ENDPOINT.'?role=admin&requester_id='.$this->requester->id.'&status=closed')
            ->assertOk()->assertExactJson(['data' => ['on_track' => $onTrack, 'at_risk' => $role === 'admin' ? 2 : 1, 'overdue' => $overdue]]);
    }

    public function test_no_visible_tickets_returns_zero_without_exposing_foreign_sla(): void
    {
        $tech = User::factory()->create(['role' => 'technician']);
        $otherTech = User::factory()->create(['role' => 'technician']);
        $this->slaTicket(['assigned_to' => $otherTech->id, 'resolution_due_at' => now()->subSecond()]);
        $this->actingAs($tech, 'web')->getJson(self::ENDPOINT)->assertOk()
            ->assertExactJson(['data' => ['on_track' => 0, 'at_risk' => 0, 'overdue' => 0]]);
    }

    public static function activeStatuses(): array
    {
        return [['open'], ['in_progress'], ['waiting_requester']];
    }

    #[DataProvider('activeStatuses')]
    public function test_active_statuses_use_pending_deadlines_without_pausing_or_counting_a_ticket_twice(string $code): void
    {
        $statusId = TicketStatus::where('code', $code)->sole()->id;
        $this->slaTicket(['status_id' => $statusId]);
        $this->slaTicket([
            'status_id' => $statusId,
            'first_response_due_at' => now()->subHour(),
            'resolution_due_at' => now()->subSecond(),
        ]);
        $this->slaTicket(['status_id' => $statusId, 'first_response_due_at' => now()->addMinute()]);
        $this->assertCounts(1, 1, 1);
    }

    public static function deadlineBoundaries(): array
    {
        $cases = [];
        foreach (['first_response_due_at', 'resolution_due_at'] as $field) {
            foreach ([-1, 0, 1] as $seconds) {
                $cases[$field.' offset '.$seconds] = [$field, $seconds, $seconds < 0 ? 1 : 0, $seconds < 0 ? 0 : 1];
            }
        }

        return $cases;
    }

    #[DataProvider('deadlineBoundaries')]
    public function test_deadline_before_equal_and_after_now(string $field, int $seconds, int $overdue, int $atRisk): void
    {
        $this->slaTicket([$field => now()->addSeconds($seconds)]);
        $this->assertCounts(0, $overdue, $atRisk);
    }

    public static function fulfilledResponses(): array
    {
        return [
            'on time, resolution pending' => [-3, false, 1, 0],
            'late, resolution pending' => [-1, false, 1, 0],
            'on time, resolution overdue' => [-3, true, 0, 1],
            'late, resolution overdue' => [-1, true, 0, 1],
        ];
    }

    #[DataProvider('fulfilledResponses')]
    public function test_fulfilled_first_response_is_not_an_outstanding_deadline(int $responseHours, bool $resolutionOverdue, int $onTrack, int $overdue): void
    {
        $this->slaTicket([
            'first_response_due_at' => now()->subHours(2),
            'first_responded_at' => now()->addHours($responseHours),
            'resolution_due_at' => $resolutionOverdue ? now()->subSecond() : now()->addHours(10),
        ]);
        $this->assertCounts($onTrack, $overdue);
    }

    public static function riskBoundaries(): array
    {
        $cases = [];
        foreach ([['low', 480, 4320, 96, 864], ['medium', 240, 1440, 48, 288], ['high', 60, 480, 12, 96], ['urgent', 15, 240, 3, 48]] as [$priority, $first, $resolution, $firstWindow, $resolutionWindow]) {
            foreach (['first' => [$first, $firstWindow], 'resolution' => [$resolution, $resolutionWindow]] as $deadline => [$duration, $window]) {
                foreach ([
                    'before risk' => [($duration - $window) * 60 - 1, 'on_track'],
                    'risk entry' => [($duration - $window) * 60, 'at_risk'],
                    'inside risk' => [($duration - $window) * 60 + 1, 'at_risk'],
                    'due exactly' => [$duration * 60, 'at_risk'],
                    'after due' => [$duration * 60 + 1, 'overdue'],
                ] as $boundary => [$elapsed, $expected]) {
                    $cases[$priority.' '.$deadline.' '.$boundary] = [$priority, $deadline, $elapsed, $expected];
                }
            }
        }

        return $cases;
    }

    #[DataProvider('riskBoundaries')]
    public function test_twenty_percent_window_for_both_deadlines_and_every_priority(string $priority, string $deadline, int $elapsed, string $expected): void
    {
        $policy = SlaPolicy::where('priority', $priority)->sole();
        $createdAt = now()->subSeconds($elapsed);
        $this->slaTicket([
            'priority' => $priority,
            'created_at' => $createdAt,
            'first_response_due_at' => $createdAt->copy()->addMinutes($policy->first_response_minutes),
            'resolution_due_at' => $createdAt->copy()->addMinutes($policy->resolution_minutes),
            'first_responded_at' => $deadline === 'resolution' ? $createdAt->copy()->addSeconds($policy->first_response_minutes * 30) : null,
        ]);
        $this->assertCounts($expected === 'on_track' ? 1 : 0, $expected === 'overdue' ? 1 : 0, $expected === 'at_risk' ? 1 : 0);
    }

    public static function mixedDeadlines(): array
    {
        return [
            'both regular' => [3000, 20000, false, 'on_track'],
            'first risky' => [2880, 20000, false, 'at_risk'],
            'resolution risky' => [3000, 17280, false, 'at_risk'],
            'both risky count once' => [2880, 17280, false, 'at_risk'],
            'first overdue wins' => [-1, 17280, false, 'overdue'],
            'resolution overdue wins' => [2880, -1, false, 'overdue'],
            'both overdue count once' => [-1, -1, false, 'overdue'],
            'fulfilled first is not overdue' => [-1, 20000, true, 'on_track'],
            'fulfilled first is not risky' => [2880, 20000, true, 'on_track'],
            'fulfilled first does not mask resolution risk' => [-1, 17280, true, 'at_risk'],
        ];
    }

    #[DataProvider('mixedDeadlines')]
    public function test_a_ticket_has_one_classification_with_overdue_precedence(int $firstRemaining, int $resolutionRemaining, bool $firstFulfilled, string $expected): void
    {
        $this->slaTicket([
            'first_response_due_at' => now()->addSeconds($firstRemaining),
            'resolution_due_at' => now()->addSeconds($resolutionRemaining),
            'first_responded_at' => $firstFulfilled ? now()->subHour() : null,
        ]);
        $this->assertCounts($expected === 'on_track' ? 1 : 0, $expected === 'overdue' ? 1 : 0, $expected === 'at_risk' ? 1 : 0);
    }

    public function test_windows_follow_policy_values_including_fractional_minutes_without_rewriting_deadlines(): void
    {
        SlaPolicy::where('priority', 'medium')->update(['first_response_minutes' => 7, 'resolution_minutes' => 23]);
        $createdAt = now()->subSeconds(336);
        $ticket = $this->slaTicket([
            'created_at' => $createdAt,
            'first_response_due_at' => $createdAt->copy()->addMinutes(7),
            'resolution_due_at' => $createdAt->copy()->addMinutes(23),
        ]);
        $original = $ticket->fresh()->getAttributes();
        $this->assertCounts(0, 0, 1); // 20% de 7 minutos = 84 segundos.
        $this->assertSame($original, $ticket->fresh()->getAttributes());
        $ticket->first_responded_at = now();
        $ticket->save();
        $this->assertCounts(1, 0);
        $this->travel(768)->seconds(); // Restam exatamente 276 segundos, 20% de 23 minutos.
        $this->assertCounts(0, 0, 1);
    }

    public static function terminalStatuses(): array
    {
        $cases = [];
        foreach (['resolved', 'closed', 'cancelled'] as $code) {
            $cases[$code.' with effective dates'] = [$code, true];
            $cases[$code.' without effective dates'] = [$code, false];
        }

        return $cases;
    }

    #[DataProvider('terminalStatuses')]
    public function test_terminal_statuses_are_not_pending_sla_even_when_deadlines_are_past(string $code, bool $withDates): void
    {
        $this->slaTicket([
            'status_id' => TicketStatus::where('code', $code)->sole()->id,
            'first_response_due_at' => now()->subHours(3),
            'resolution_due_at' => now()->subHours(2),
            'first_responded_at' => $withDates ? now()->subHour() : null,
            'resolved_at' => $withDates && $code !== 'cancelled' ? now()->subMinutes(30) : null,
            'closed_at' => $withDates && $code === 'closed' ? now()->subMinutes(15) : null,
        ]);
        $this->slaTicket(['status_id' => TicketStatus::where('code', $code)->sole()->id, 'first_response_due_at' => now()->addMinute()]);
        $this->assertCounts(0, 0);
    }

    public function test_effective_resolution_or_closure_disables_pending_deadlines_even_with_an_active_status(): void
    {
        foreach (['resolved_at', 'closed_at'] as $field) {
            $this->slaTicket([$field => now()->subMinute(), 'resolution_due_at' => now()->subHour()]);
        }
        $this->assertCounts(0, 0);
    }

    public static function reopenedDeadlines(): array
    {
        return [[-60, 0, 0, 1], [60, 0, 1, 0], [600, 1, 0, 0]];
    }

    #[DataProvider('reopenedDeadlines')]
    public function test_reopening_restores_the_original_pending_resolution_deadline(int $remainingMinutes, int $onTrack, int $atRisk, int $overdue): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->slaTicket([
            'status_id' => TicketStatus::where('code', 'resolved')->sole()->id,
            'first_response_due_at' => now()->subHours(4),
            'first_responded_at' => now()->subHours(5),
            'resolution_due_at' => now()->addMinutes($remainingMinutes),
            'resolved_at' => now()->subHours(2),
        ]);
        $original = $ticket->getAttributes();
        $this->actingAs($admin, 'web')->getJson(self::ENDPOINT)->assertJsonPath('data.overdue', 0);
        $this->patchJson('/api/tickets/'.$ticket->id.'/status', ['status' => 'in_progress'])->assertOk();
        $this->getJson(self::ENDPOINT)->assertOk()->assertExactJson(['data' => ['on_track' => $onTrack, 'at_risk' => $atRisk, 'overdue' => $overdue]]);
        $ticket->refresh();
        $this->assertNull($ticket->resolved_at);
        foreach (['first_response_due_at', 'resolution_due_at', 'first_responded_at', 'created_at'] as $field) {
            $this->assertSame($original[$field], $ticket->getAttributes()[$field]);
        }
    }

    public function test_only_the_first_public_staff_comment_satisfies_first_response(): void
    {
        $tech = User::factory()->create(['role' => 'technician']);
        $ticket = $this->slaTicket(['assigned_to' => $tech->id, 'first_response_due_at' => now()->subHour()]);
        $this->actingAs($tech, 'web')->getJson(self::ENDPOINT)->assertJsonPath('data.overdue', 1);
        $this->postJson('/api/tickets/'.$ticket->id.'/comments', ['body' => 'Nota interna', 'is_internal' => true])->assertCreated();
        $this->getJson(self::ENDPOINT)->assertJsonPath('data.overdue', 1);
        $this->postJson('/api/tickets/'.$ticket->id.'/comments', ['body' => 'Resposta pública', 'is_internal' => false])->assertCreated();
        $this->getJson(self::ENDPOINT)->assertOk()->assertExactJson(['data' => ['on_track' => 1, 'at_risk' => 0, 'overdue' => 0]]);
        $this->assertTrue($ticket->fresh()->first_responded_at->equalTo(now()));
    }

    public static function inconsistentDates(): array
    {
        return [
            ['created_at', 1],
            ['first_response_due_at', -172801],
            ['resolution_due_at', -172801],
            ['first_responded_at', -172801],
            ['first_responded_at', 1],
        ];
    }

    #[DataProvider('inconsistentDates')]
    public function test_inconsistent_dates_are_not_reported_as_reliable_counts(string $field, int $seconds): void
    {
        $this->slaTicket([$field => now()->addSeconds($seconds)]);
        $this->assertCounts(0, 0);
    }

    public function test_unknown_status_does_not_invent_applicable_deadlines(): void
    {
        $status = TicketStatus::create(['code' => 'future_status', 'name' => 'Outro', 'position' => 10]);
        $this->slaTicket(['status_id' => $status->id, 'resolution_due_at' => now()->subHour()]);
        $this->assertCounts(0, 0);
    }

    public function test_timezone_offsets_are_compared_as_the_same_utc_instant(): void
    {
        $this->slaTicket([
            'first_response_due_at' => Carbon::parse('2026-10-26T21:00:00-03:00')->utc(),
            'resolution_due_at' => Carbon::parse('2026-10-27T01:00:00+01:00')->utc(),
        ]);
        $this->assertCounts(0, 0, 1);
        $this->travel(1)->seconds();
        $this->assertCounts(0, 1);
    }

    public function test_cookie_session_uses_one_read_only_aggregate_without_changing_existing_records(): void
    {
        $this->slaTicket();
        $this->slaTicket(['resolution_due_at' => now()->subHour()]);
        $this->postJson('/api/login', ['email' => $this->requester->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $token = session()->token();
        $before = $this->snapshot();
        Auth::forgetGuards();
        DB::enableQueryLog();
        $response = $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)->getJson(self::ENDPOINT)->assertOk();
        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        $ticketQueries = array_values(array_filter($queries, fn (array $query): bool => str_contains($query['query'], '"tickets"')));
        $this->assertCount(1, $ticketQueries);
        $this->assertStringContainsString('COUNT(', $ticketQueries[0]['query']);
        $this->assertStringContainsString('join "sla_policies"', $ticketQueries[0]['query']);
        foreach ($queries as $query) {
            $this->assertDoesNotMatchRegularExpression('/\b(insert|update|delete|replace|create|alter|drop|truncate)\b/i', $query['query']);
            foreach (['ticket_comments', 'ticket_activities'] as $table) {
                $this->assertStringNotContainsString($table, $query['query']);
            }
        }
        $this->assertSame($before, $this->snapshot());
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($token, session()->token());
        $response->assertExactJson(['data' => ['on_track' => 1, 'at_risk' => 0, 'overdue' => 1]]);
        $this->assertIsInt($response->json('data.on_track'));
        $this->assertIsInt($response->json('data.at_risk'));
        $this->assertIsInt($response->json('data.overdue'));
        $this->requester->update(['disabled_at' => now()]);
        Auth::forgetGuards();
        $this->getJson(self::ENDPOINT)->assertForbidden();
    }

    public function test_route_uses_sanctum_before_active_user_middleware(): void
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

    private function slaTicket(array $attributes = []): Ticket
    {
        $ticket = $this->ticket();
        // Legacy fixtures omit created_at from mass assignment; set it explicitly for past deadlines.
        $policy = SlaPolicy::where('priority', $attributes['priority'] ?? 'medium')->sole();
        $ticket->forceFill(array_replace(['created_at' => now()->subDays(2), 'sla_policy_id' => $policy->id], $attributes))->save();

        return $ticket;
    }

    private function assertCounts(int $onTrack, int $overdue, int $atRisk = 0): void
    {
        $this->actingAs($this->requester, 'web')->getJson(self::ENDPOINT)->assertOk()
            ->assertExactJson(['data' => ['on_track' => $onTrack, 'at_risk' => $atRisk, 'overdue' => $overdue]]);
    }
}
