<?php

namespace Tests\Feature;

use App\Models\Category;
use App\Models\Ticket;
use App\Models\TicketActivity;
use App\Models\TicketStatus;
use App\Models\User;
use App\Services\ReportSummary;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class ReportSummaryTest extends TestCase
{
    use AssignmentFixtures;

    private User $admin;

    private const URL = '/api/reports/summary?start_date=2026-10-01&end_date=2026-10-30';

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertSame(':memory:', DB::connection()->getDatabaseName());
        $this->createAssignmentFixtures();
        $this->travelTo(CarbonImmutable::parse('2026-10-30T15:00:00Z'));
        config(['logging.default' => 'null']);
        $this->admin = User::factory()->create(['role' => 'admin']);
        $this->actingAs($this->admin, 'web');
    }

    private function reportTicket(array $attributes = []): Ticket
    {
        $ticket = $this->ticket();
        $ticket->forceFill(array_replace(['created_at' => CarbonImmutable::parse('2026-10-10T12:00:00Z'),
            'first_response_due_at' => now()->addHour(), 'resolution_due_at' => now()->addHours(2)], $attributes))->save();

        return $ticket;
    }

    public function test_empty_summary_has_explicit_universes_zero_counts_and_null_rates(): void
    {
        $response = $this->getJson(self::URL)->assertOk()->assertJsonPath('data.movements', ['created' => 0, 'resolved_distinct' => 0, 'closed' => 0])
            ->assertJsonPath('data.cohort.total', 0)->assertJsonPath('data.cohort.unassigned.count', 0)
            ->assertJsonCount(6, 'data.cohort.by_status')->assertJsonPath('data.cohort.by_category', [])
            ->assertJsonCount(4, 'data.cohort.by_priority')->assertJsonPath('meta.timezone', 'America/Sao_Paulo')
            ->assertJsonPath('data.sla.first_response.compliance_rate', null)->assertJsonPath('data.sla.resolution.compliance_rate', null);
        $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
        foreach (['first_response', 'resolution'] as $kind) {
            foreach (['met', 'late', 'pending_on_time', 'pending_overdue', 'not_evaluable', 'cancelled_excluded', 'compliance_denominator'] as $key) {
                $response->assertJsonPath("data.sla.{$kind}.{$key}", 0);
            }
        }
    }

    public function test_default_period_is_thirty_local_calendar_days_even_near_utc_midnight(): void
    {
        $this->travelTo(CarbonImmutable::parse('2026-10-30T02:00:00Z'));
        $this->getJson('/api/reports/summary')->assertOk()->assertJsonPath('meta.start_date', '2026-09-30')
            ->assertJsonPath('meta.end_date', '2026-10-29')->assertJsonPath('meta.start_utc', '2026-09-30T03:00:00.000000Z')
            ->assertJsonPath('meta.end_exclusive_utc', '2026-10-30T03:00:00.000000Z');
    }

    public static function invalidPeriods(): array
    {
        return [['start_date=2026-10-01'], ['end_date=2026-10-01'], ['start_date=&end_date='],
            ['start_date=2026-02-30&end_date=2026-03-01'], ['start_date[]=2026-10-01&end_date=2026-10-02'],
            ['start_date=2026-10-02&end_date=2026-10-01'], ['start_date=2026-01-01&end_date=2027-01-01'],
            ['start_date=2024-01-01&end_date=2025-01-01'], ['start_date=2026-1-01&end_date=2026-10-01'],
            ['start_date=0000-01-01&end_date=0000-01-02'], ['assigned_to=1'], ['status=open']];
    }

    #[DataProvider('invalidPeriods')]
    public function test_invalid_or_unimplemented_filters_are_rejected(string $query): void
    {
        $this->getJson('/api/reports/summary?'.$query)->assertUnprocessable();
    }

    public function test_calendar_year_limit_accepts_leap_year_and_single_day_and_dst_uses_real_midnight(): void
    {
        foreach ([['2024-01-01', '2024-12-31'], ['2026-01-01', '2026-12-31'], ['2026-10-01', '2026-10-01']] as [$start, $end]) {
            $this->getJson('/api/reports/summary?start_date='.$start.'&end_date='.$end)->assertOk();
        }
        $this->getJson('/api/reports/summary?start_date=2018-11-04&end_date=2018-11-04')->assertOk()
            ->assertJsonPath('meta.start_utc', '2018-11-04T03:00:00.000000Z')
            ->assertJsonPath('meta.end_exclusive_utc', '2018-11-05T02:00:00.000000Z');
    }

    public function test_half_open_boundaries_use_creation_date_not_updated_at(): void
    {
        foreach (['2026-10-01T02:59:59Z', '2026-10-01T03:00:00Z', '2026-10-31T02:59:59Z', '2026-10-31T03:00:00Z'] as $date) {
            $this->reportTicket(['created_at' => CarbonImmutable::parse($date)]);
        }
        $this->getJson(self::URL)->assertOk()->assertJsonPath('data.movements.created', 2)->assertJsonPath('data.cohort.total', 2);
    }

    public function test_movements_are_distinct_events_and_independent_of_creation_cohort_and_current_status(): void
    {
        $ticket = $this->reportTicket(['created_at' => now()->subYears(2), 'resolved_at' => null]);
        foreach (['2026-10-03T12:00:00Z', '2026-10-06T12:00:00Z'] as $date) {
            $event = new TicketActivity(['ticket_id' => $ticket->id, 'actor_id' => $this->admin->id, 'action' => 'status_changed', 'changes' => ['status' => ['from' => 'in_progress', 'to' => 'resolved']]]);
            $event->created_at = CarbonImmutable::parse($date);
            $event->save();
        }
        $outside = $this->reportTicket(['created_at' => now()->subYears(2), 'closed_at' => now()->subDay()]);
        foreach ([['comment_added', 'resolved'], ['status_changed', 'in_progress']] as [$action, $to]) {
            TicketActivity::create(['ticket_id' => $outside->id, 'actor_id' => $this->admin->id, 'action' => $action, 'changes' => ['status' => ['to' => $to]]]);
        }
        $this->getJson(self::URL)->assertOk()->assertJsonPath('data.movements', ['created' => 0, 'resolved_distinct' => 1, 'closed' => 1]);
    }

    public function test_real_resolve_reopen_sequence_remains_in_period_movements(): void
    {
        $ticket = $this->reportTicket(['status_id' => TicketStatus::where('code', 'in_progress')->sole()->id]);
        $this->patchJson('/api/tickets/'.$ticket->id.'/status', ['status' => 'resolved'])->assertOk();
        $this->patchJson('/api/tickets/'.$ticket->id.'/status', ['status' => 'in_progress'])->assertOk();
        $this->assertNull($ticket->fresh()->resolved_at);
        $this->getJson(self::URL)->assertOk()->assertJsonPath('data.movements.resolved_distinct', 1)
            ->assertJsonPath('data.sla.resolution.pending_on_time', 1);
    }

    public static function slaCases(): array
    {
        return [
            'pending at equality' => ['open', null, null, null, 0, 'pending_on_time', 'pending_on_time'],
            'pending late' => ['waiting_requester', null, null, null, -1, 'pending_overdue', 'pending_overdue'],
            'met at equality' => ['resolved', 0, 0, null, 0, 'met', 'met'],
            'late completed' => ['closed', 0, 0, 0, -1, 'late', 'late'],
            'resolution without reply' => ['resolved', null, 0, null, 0, 'not_evaluable', 'met'],
            'closure proves neither' => ['closed', null, null, 0, 0, 'not_evaluable', 'not_evaluable'],
            'cancelled despite reply' => ['cancelled', -10, null, null, 0, 'not_evaluable', 'not_evaluable'],
            'future reply does not poison resolution' => ['resolved', 1, 0, null, 0, 'not_evaluable', 'met'],
            'reply after resolution' => ['resolved', 0, -10, null, 0, 'not_evaluable', 'met'],
            'future closure' => ['closed', -10, 0, 1, 0, 'not_evaluable', 'not_evaluable'],
            'deadline before creation' => ['open', null, null, null, -1814400, 'not_evaluable', 'not_evaluable'],
            'reply before creation' => ['open', -1814400, null, null, 0, 'not_evaluable', 'pending_on_time'],
            'future resolution' => ['resolved', null, 1, null, 0, 'not_evaluable', 'not_evaluable'],
            'resolution after closure' => ['closed', -10, 0, -5, 0, 'not_evaluable', 'not_evaluable'],
        ];
    }

    #[DataProvider('slaCases')]
    public function test_independent_sla_classifications(string $status, ?int $reply, ?int $resolved, ?int $closed, int $due, string $firstState, string $resolutionState): void
    {
        $time = fn (?int $seconds) => $seconds === null ? null : now()->addSeconds($seconds);
        $this->reportTicket(['status_id' => TicketStatus::where('code', $status)->sole()->id,
            'first_responded_at' => $time($reply), 'resolved_at' => $time($resolved), 'closed_at' => $time($closed),
            'first_response_due_at' => $time($due), 'resolution_due_at' => $time($due)]);
        $response = $this->getJson(self::URL)->assertOk()->assertJsonPath('data.sla.first_response.'.$firstState, 1)
            ->assertJsonPath('data.sla.resolution.'.$resolutionState, 1);
        foreach (['first_response', 'resolution'] as $kind) {
            $counts = $response->json('data.sla.'.$kind);
            $this->assertSame(1, array_sum(array_intersect_key($counts, array_flip(['met', 'late', 'pending_on_time', 'pending_overdue', 'not_evaluable']))));
            $this->assertSame($status === 'cancelled' ? 1 : 0, $counts['cancelled_excluded']);
        }
    }

    public function test_percentages_exclude_pending_cancelled_and_missing_evidence_and_distributions_reconcile(): void
    {
        $category = Category::firstOrFail();
        $category->update(['is_active' => false]);
        $tech = User::factory()->create(['role' => 'technician', 'disabled_at' => now()]);
        $this->reportTicket(['first_responded_at' => now(), 'resolved_at' => now(), 'assigned_to' => $tech->id]);
        $this->reportTicket(['first_responded_at' => now(), 'resolved_at' => now(), 'first_response_due_at' => now()->subSecond(), 'resolution_due_at' => now()->subSecond()]);
        $this->reportTicket();
        $this->reportTicket(['status_id' => TicketStatus::where('code', 'cancelled')->sole()->id]);
        $response = $this->getJson(self::URL)->assertOk()->assertJsonPath('data.cohort.total', 4)->assertJsonPath('data.cohort.unassigned.count', 3)
            ->assertJsonPath('data.sla.first_response.compliance_denominator', 2)->assertJsonPath('data.sla.first_response.compliance_rate', 50)
            ->assertJsonPath('data.sla.resolution.compliance_rate', 50)->assertJsonPath('data.sla.resolution.cancelled_excluded', 1)
            ->assertJsonPath('data.cohort.by_category.0.is_active', false);
        foreach (['by_status', 'by_category', 'by_priority'] as $key) {
            $this->assertSame(4, array_sum(array_column($response->json('data.cohort.'.$key), 'count')));
        }
    }

    public function test_priority_change_recalculates_sla_and_summary_does_not_change_dashboard_or_records(): void
    {
        $ticket = $this->reportTicket(['created_at' => now()->subMinutes(20)]);
        $this->patchJson('/api/tickets/'.$ticket->id.'/details', ['priority' => 'urgent'])->assertOk();
        $this->postJson('/api/tickets/'.$ticket->id.'/comments', ['body' => 'Resposta pública.', 'is_internal' => false])->assertCreated();
        $stats = $this->getJson('/api/dashboard/stats')->assertOk()->json();
        $sla = $this->getJson('/api/dashboard/sla')->assertOk()->json();
        $before = $this->snapshot();
        DB::enableQueryLog();
        $this->getJson(self::URL)->assertOk()->assertJsonPath('data.sla.basis', 'currently_recorded_deadlines')
            ->assertJsonPath('data.sla.first_response.late', 1)->assertJsonPath('data.cohort.by_priority.3.count', 1);
        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        foreach ($queries as $query) {
            $this->assertDoesNotMatchRegularExpression('/\b(insert|update|delete|replace|create|alter|drop|truncate)\b/i', $query['query']);
        }
        $this->assertSame($before, $this->snapshot());
        $this->assertSame($stats, $this->getJson('/api/dashboard/stats')->json());
        $this->assertSame($sla, $this->getJson('/api/dashboard/sla')->json());
    }

    public function test_guest_wrong_roles_disabled_and_revoked_sessions_are_rejected(): void
    {
        foreach (['requester', 'technician', 'unknown'] as $role) {
            Auth::forgetGuards();
            $this->actingAs(User::factory()->create(['role' => $role]), 'web')->getJson('/api/reports/summary?start_date=invalid')->assertForbidden();
        }
        $this->admin->update(['disabled_at' => now()]);
        Auth::forgetGuards();
        $this->actingAs($this->admin->fresh(), 'web')->getJson(self::URL)->assertForbidden();
        $this->admin->forceFill(['disabled_at' => null, 'session_version' => 1])->save();
        Auth::forgetGuards();
        $this->actingAs($this->admin->fresh(), 'web')->getJson(self::URL)->assertUnauthorized()->assertJsonPath('code', 'session_revoked');
        $this->app['auth']->forgetGuards();
        $this->getJson(self::URL)->assertUnauthorized();
    }

    #[DataProvider('cutovers')]
    public function test_administrator_is_revalidated_after_summary(array $changes, int $status): void
    {
        $admin = $this->admin;
        $this->app->instance(ReportSummary::class, new class($admin, $changes) extends ReportSummary
        {
            public function __construct(private User $admin, private array $changes) {}

            public function summarize(CarbonImmutable $start, CarbonImmutable $end, CarbonImmutable $now): array
            {
                $data = parent::summarize($start, $end, $now);
                DB::table('users')->where('id', $this->admin->id)->update($this->changes);

                return $data;
            }
        });
        $this->getJson(self::URL)->assertStatus($status)->assertJsonMissingPath('data');
    }

    public static function cutovers(): array
    {
        return [[['role' => 'technician'], 403], [['disabled_at' => '2026-10-30 15:00:00'], 403], [['session_version' => 1], 401]];
    }

    public function test_unavailable_schema_returns_safe_service_error(): void
    {
        Schema::drop('ticket_activities');
        $this->getJson(self::URL)->assertStatus(503)->assertExactJson(['message' => 'Relatórios temporariamente indisponíveis.', 'code' => 'report_unavailable']);
    }
}
