<?php

namespace Tests\Feature;

use App\Models\Category;
use App\Models\Ticket;
use App\Models\TicketStatus;
use App\Models\User;
use App\Services\ReportFilters;
use App\Services\ReportTickets;
use App\Support\SessionVersion;
use Carbon\CarbonImmutable;
use Illuminate\Pagination\LengthAwarePaginator;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\DataProviderExternal;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class ReportTicketsTest extends TestCase
{
    use AssignmentFixtures;

    private User $admin;

    private const PERIOD = 'start_date=2026-10-01&end_date=2026-10-30';

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

    private function row(array $attributes = []): Ticket
    {
        $ticket = $this->ticket();
        $ticket->forceFill(array_replace(['created_at' => CarbonImmutable::parse('2026-10-10T12:00:00Z'),
            'first_response_due_at' => now(), 'resolution_due_at' => now()], $attributes))->save();

        return $ticket;
    }

    public function test_empty_pagination_defaults_dates_and_links_freeze_the_period(): void
    {
        $this->travelTo(CarbonImmutable::parse('2026-10-30T02:00:00Z'));
        $response = $this->getJson('/api/reports/tickets')->assertOk()->assertJsonPath('data', [])
            ->assertJsonPath('total', 0)->assertJsonPath('current_page', 1)->assertJsonPath('per_page', 15)
            ->assertJsonPath('from', null)->assertJsonPath('to', null)
            ->assertJsonPath('meta.start_date', '2026-09-30')->assertJsonPath('meta.end_date', '2026-10-29')
            ->assertJsonPath('meta.summary_filters_applied', false);
        $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
        $this->assertStringContainsString('start_date=2026-09-30', $response->json('first_page_url'));
    }

    public function test_combined_current_filters_and_inactive_relations_are_supported_without_affecting_summary(): void
    {
        $owner = User::factory()->create(['role' => 'requester', 'disabled_at' => now()]);
        $category = Category::firstOrFail();
        $category->update(['is_active' => false]);
        $target = $this->row(['assigned_to' => $owner->id, 'category_id' => $category->id, 'priority' => 'urgent',
            'status_id' => TicketStatus::where('code', 'closed')->sole()->id]);
        $this->row();
        $this->row(['assigned_to' => $owner->id, 'priority' => 'low']);
        $summary = $this->getJson('/api/reports/summary?'.self::PERIOD)->assertOk()->json();
        $query = self::PERIOD.'&assigned_to='.$owner->id.'&category_id='.$category->id.'&priority=urgent&status=closed';
        $this->getJson('/api/reports/tickets?'.$query)->assertOk()->assertJsonPath('total', 1)
            ->assertJsonPath('data.0.id', $target->id)->assertJsonPath('data.0.assignee.id', $owner->id)
            ->assertJsonPath('meta.filters.assigned_to', $owner->id);
        $this->assertSame($summary, $this->getJson('/api/reports/summary?'.self::PERIOD)->json());
        $this->getJson('/api/reports/summary?'.$query)->assertUnprocessable();
    }

    public function test_unassigned_null_dates_public_projection_and_no_join_multiplication(): void
    {
        $ticket = $this->row();
        $this->row(['assigned_to' => $this->admin->id]);
        for ($i = 0; $i < 3; $i++) {
            $ticket->comments()->create(['user_id' => $this->admin->id, 'body' => 'Conteúdo interno protegido.', 'is_internal' => true]);
        }
        $before = $this->snapshot();
        $response = $this->getJson('/api/reports/tickets?'.self::PERIOD.'&assigned_to=unassigned')->assertOk()
            ->assertJsonPath('total', 1)->assertJsonPath('data.0.assignee', null)->assertJsonPath('data.0.first_responded_at', null)
            ->assertJsonPath('data.0.resolved_at', null)->assertJsonPath('data.0.closed_at', null)
            ->assertJsonPath('data.0.sla.first_response', 'pending_on_time');
        $this->assertSame(['id', 'title', 'requester', 'assignee', 'category', 'priority', 'status', 'created_at', 'first_responded_at',
            'resolved_at', 'closed_at', 'first_response_due_at', 'resolution_due_at', 'sla'], array_keys($response->json('data.0')));
        $this->assertStringNotContainsString('Conteúdo interno protegido', $response->getContent());
        $this->assertStringNotContainsString('email', $response->getContent());
        $this->assertSame($before, $this->snapshot());
    }

    public function test_pagination_ties_are_ordered_by_id_and_queries_are_bounded(): void
    {
        $ids = [];
        for ($i = 0; $i < 5; $i++) {
            $ids[] = $this->row()->id;
        }
        DB::enableQueryLog();
        $first = $this->getJson('/api/reports/tickets?'.self::PERIOD.'&per_page=2')->assertOk()->assertJsonPath('total', 5)->assertJsonPath('last_page', 3);
        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        $ticketQueries = array_filter($queries, fn ($q) => str_contains($q['query'], '"tickets"'));
        $this->assertCount(2, $ticketQueries);
        foreach ($queries as $query) {
            $this->assertDoesNotMatchRegularExpression('/\b(insert|update|delete|replace|create|alter|drop|truncate)\b/i', $query['query']);
        }
        $this->assertSame([$ids[4], $ids[3]], array_column($first->json('data'), 'id'));
        $second = $this->getJson('/api/reports/tickets?'.self::PERIOD.'&per_page=2&page=2')->assertOk();
        $this->assertSame([$ids[2], $ids[1]], array_column($second->json('data'), 'id'));
        $this->getJson('/api/reports/tickets?'.self::PERIOD.'&page=99')->assertOk()->assertJsonPath('data', [])->assertJsonPath('total', 5);
    }

    public function test_half_open_dates_exclude_last_boundary_and_ignore_updated_at(): void
    {
        $ids = [];
        foreach (['2026-10-01T02:59:59Z', '2026-10-01T03:00:00Z', '2026-10-31T02:59:59Z', '2026-10-31T03:00:00Z'] as $date) {
            $ids[] = $this->row(['created_at' => CarbonImmutable::parse($date)])->id;
        }
        $response = $this->getJson('/api/reports/tickets?'.self::PERIOD)->assertOk()->assertJsonPath('total', 2);
        $this->assertSame([$ids[2], $ids[1]], array_column($response->json('data'), 'id'));
    }

    #[DataProviderExternal(ReportSummaryTest::class, 'slaCases')]
    public function test_row_sla_matches_summary_exactly(string $status, ?int $reply, ?int $resolved, ?int $closed, int $due, string $firstState, string $resolutionState): void
    {
        $time = fn (?int $seconds) => $seconds === null ? null : now()->addSeconds($seconds);
        $this->row(['status_id' => TicketStatus::where('code', $status)->sole()->id,
            'first_responded_at' => $time($reply), 'resolved_at' => $time($resolved), 'closed_at' => $time($closed),
            'first_response_due_at' => $time($due), 'resolution_due_at' => $time($due)]);
        $this->getJson('/api/reports/tickets?'.self::PERIOD)->assertOk()->assertJsonPath('data.0.sla.first_response', $firstState)
            ->assertJsonPath('data.0.sla.resolution', $resolutionState);
        $this->getJson('/api/reports/summary?'.self::PERIOD)->assertOk()->assertJsonPath('data.sla.first_response.'.$firstState, 1)
            ->assertJsonPath('data.sla.resolution.'.$resolutionState, 1);
    }

    public function test_filter_catalog_includes_inactive_categories_and_former_technicians_still_assigned(): void
    {
        $former = User::factory()->create(['role' => 'admin', 'disabled_at' => now()]);
        $active = User::factory()->create(['role' => 'technician']);
        $unused = User::factory()->create(['role' => 'technician', 'disabled_at' => now()]);
        $this->row(['assigned_to' => $former->id, 'created_at' => now()->subYears(2)]);
        $category = Category::firstOrFail();
        $category->update(['is_active' => false]);
        $response = $this->getJson('/api/reports/filters?'.self::PERIOD)->assertOk()
            ->assertJsonPath('data.unassigned_value', 'unassigned')->assertJsonCount(6, 'data.statuses')
            ->assertJsonPath('meta.options_scope', 'administrative_catalog_across_all_periods');
        $this->assertEqualsCanonicalizing([$former->id, $active->id], array_column($response->json('data.assignees'), 'id'));
        $this->assertFalse(collect($response->json('data.categories'))->firstWhere('id', $category->id)['is_active']);
        $this->assertNotContains($unused->id, array_column($response->json('data.assignees'), 'id'));
        foreach (['email', 'password', 'session_version', 'remember_token'] as $field) {
            $this->assertStringNotContainsString($field, $response->getContent());
        }
    }

    public static function invalidFilters(): array
    {
        return array_map(fn ($value) => [$value], ['per_page=101', 'per_page=0', 'page=0', 'page=1000001', 'page[]=1',
            'assigned_to=0', 'assigned_to=999999', 'assigned_to=9223372036854775808', 'assigned_to=', 'category_id=999999',
            'priority=invalid', 'status=invalid', 'sort=title', 'start_date=2026-10-01',
            'start_date=2026-02-30&end_date=2026-03-01', 'start_date=2026-01-01&end_date=2027-01-01']);
    }

    #[DataProvider('invalidFilters')]
    public function test_invalid_filters_are_rejected(string $query): void
    {
        $this->getJson('/api/reports/tickets?'.$query)->assertUnprocessable();
    }

    public static function endpoints(): array
    {
        return [['tickets'], ['filters']];
    }

    #[DataProvider('endpoints')]
    public function test_access_control_precedes_validation_and_session_revocation_is_preserved(string $endpoint): void
    {
        foreach (['requester', 'technician'] as $role) {
            Auth::forgetGuards();
            $this->actingAs(User::factory()->create(['role' => $role]), 'web')->getJson('/api/reports/'.$endpoint.'?page=invalid')->assertForbidden();
        }
        $this->admin->update(['disabled_at' => now()]);
        Auth::forgetGuards();
        $this->actingAs($this->admin->fresh(), 'web')->getJson('/api/reports/'.$endpoint)->assertForbidden();
        $this->admin->forceFill(['disabled_at' => null, 'session_version' => 1])->save();
        Auth::forgetGuards();
        $this->actingAs($this->admin->fresh(), 'web')->withSession([SessionVersion::KEY => 0])
            ->getJson('/api/reports/'.$endpoint)->assertUnauthorized()->assertJsonPath('code', 'session_revoked');
        Auth::forgetGuards();
        $this->getJson('/api/reports/'.$endpoint)->assertUnauthorized();
    }

    #[DataProvider('endpoints')]
    public function test_permissions_are_revalidated_after_queries_and_failures_are_safe(string $endpoint): void
    {
        $admin = $this->admin;
        if ($endpoint === 'tickets') {
            $this->app->instance(ReportTickets::class, new class($admin) extends ReportTickets
            {
                public function __construct(private User $admin) {}

                public function paginate(CarbonImmutable $start, CarbonImmutable $end, CarbonImmutable $now, array $filters, int $page, int $perPage): LengthAwarePaginator
                {
                    $data = parent::paginate($start, $end, $now, $filters, $page, $perPage);
                    DB::table('users')->where('id', $this->admin->id)->update(['role' => 'technician']);

                    return $data;
                }
            });
        } else {
            $this->app->instance(ReportFilters::class, new class($admin) extends ReportFilters
            {
                public function __construct(private User $admin) {}

                public function options(): array
                {
                    $data = parent::options();
                    DB::table('users')->where('id', $this->admin->id)->update(['role' => 'technician']);

                    return $data;
                }
            });
        }
        $this->getJson('/api/reports/'.$endpoint)->assertForbidden()->assertJsonMissingPath('data');
    }

    #[DataProvider('endpoints')]
    public function test_unavailable_tables_return_generic_503(string $endpoint): void
    {
        Schema::drop('ticket_comments');
        Schema::drop('ticket_activities');
        Schema::drop('tickets');
        $this->getJson('/api/reports/'.$endpoint)->assertStatus(503)->assertExactJson(['message' => 'Relatórios temporariamente indisponíveis.', 'code' => 'report_unavailable']);
    }
}
