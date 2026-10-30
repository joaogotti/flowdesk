<?php

namespace Tests\Feature;

use App\Models\TicketActivity;
use App\Models\TicketStatus;
use App\Models\User;
use App\Support\SessionVersion;
use Carbon\CarbonImmutable;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class ReportSummaryPostgresqlTest extends TestCase
{
    use AssignmentFixtures;

    public function test_real_aggregates_read_snapshot_concurrent_updates_and_authentication_cutovers(): void
    {
        $host = getenv('FLOWDESK_REPORTS_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requires disposable PostgreSQL via FLOWDESK_REPORTS_PG_HOST.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-reports-test-[a-f0-9]+$/', $host);
        $connection = ['driver' => 'pgsql', 'host' => $host, 'port' => 5432, 'database' => 'flowdesk_reports_test',
            'username' => 'postgres', 'password' => '', 'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer'];
        config(['database.default' => 'reports_pg', 'database.connections.reports_pg' => $connection,
            'database.connections.reports_writer' => $connection, 'logging.default' => 'null']);
        $this->createAssignmentFixtures();
        $this->travelTo(CarbonImmutable::parse('2026-10-30T15:00:00Z'));
        $admin = User::factory()->create(['role' => 'admin']);
        $this->actingAs($admin, 'web');
        $ticket = $this->ticket();
        $ticket->forceFill(['created_at' => now()->subDay(), 'first_response_due_at' => now(), 'resolution_due_at' => now()])->save();
        $url = '/api/reports/summary?start_date=2026-10-29&end_date=2026-10-30';
        $writer = DB::connection('reports_writer');
        $mode = null;
        $operation = null;
        $fired = false;
        $checks = [];
        DB::listen(function (QueryExecuted $query) use (&$mode, &$operation, &$fired, &$checks, $writer, $ticket, $admin): void {
            if ($fired || $mode === null || $query->connectionName !== 'reports_pg' || ! str_contains($query->sql, '"classified"')) {
                return;
            }
            $fired = true;
            $checks[] = DB::selectOne("SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only");
            if ($mode === 'data') {
                $writer->table('tickets')->where('id', $ticket->id)->update(['status_id' => TicketStatus::where('code', 'closed')->sole()->id,
                    'first_responded_at' => now(), 'resolved_at' => now(), 'closed_at' => now()]);
                $writer->table('ticket_activities')->insert(['ticket_id' => $ticket->id, 'actor_id' => $admin->id, 'action' => 'status_changed',
                    'changes' => json_encode(['status' => ['from' => 'in_progress', 'to' => 'resolved']]), 'created_at' => now()]);
            } else {
                $writer->table('users')->where('id', $admin->id)->update($operation);
            }
        });

        try {
            // Explicit offsets make aggregation independent of PostgreSQL's connection timezone.
            DB::statement("SET TIME ZONE 'America/Sao_Paulo'");
            $this->getJson($url)->assertOk()->assertJsonPath('data.sla.first_response.pending_on_time', 1)
                ->assertJsonPath('data.sla.resolution.pending_on_time', 1);
            $mode = 'data';
            $response = $this->getJson($url)->assertOk()->assertJsonPath('data.cohort.total', 1)
                ->assertJsonPath('data.movements.resolved_distinct', 0)->assertJsonPath('data.movements.closed', 0)
                ->assertJsonPath('data.sla.resolution.pending_on_time', 1);
            $this->assertTrue($fired);
            $this->assertSame(1, collect($response->json('data.cohort.by_status'))->firstWhere('code', 'open')['count']);
            $this->assertSame('repeatable read', $checks[0]->isolation);
            $this->assertSame('on', $checks[0]->read_only);
            $this->assertSame('off', DB::selectOne("SELECT current_setting('transaction_read_only') AS value")->value);
            $this->getJson($url)->assertOk()->assertJsonPath('data.movements.resolved_distinct', 1)
                ->assertJsonPath('data.movements.closed', 1)->assertJsonPath('data.sla.resolution.met', 1);

            // Duplicate resolution events must not multiply tickets, regardless of reopening.
            $mode = null;
            TicketActivity::create(['ticket_id' => $ticket->id, 'actor_id' => $admin->id, 'action' => 'status_changed', 'changes' => ['status' => ['to' => 'resolved']]]);
            $this->getJson($url)->assertOk()->assertJsonPath('data.movements.resolved_distinct', 1);

            foreach ([[['role' => 'technician'], 403], [['disabled_at' => now()], 403], [['session_version' => 1], 401]] as [$changes, $status]) {
                $writer->table('users')->where('id', $admin->id)->update(['role' => 'admin', 'disabled_at' => null, 'session_version' => 0]);
                Auth::forgetGuards();
                $this->actingAs($admin->fresh(), 'web')->withSession([SessionVersion::KEY => 0]);
                $operation = $changes;
                $mode = 'auth';
                $fired = false;
                $this->getJson($url)->assertStatus($status)->assertJsonMissingPath('data');
                $this->assertTrue($fired);
            }
            $mode = null;
            $writer->table('users')->where('id', $admin->id)->update(['role' => 'admin', 'disabled_at' => null, 'session_version' => 0]);
            Auth::forgetGuards();
            $this->actingAs($admin->fresh(), 'web')->withSession([SessionVersion::KEY => 0]);
            foreach (['2026-10-30T02:59:59Z', '2026-10-30T03:00:00Z', '2026-10-31T02:59:59Z', '2026-10-31T03:00:00Z'] as $date) {
                $boundary = $this->ticket();
                $writer->table('tickets')->where('id', $boundary->id)->update(['created_at' => $date]);
            }
            $this->getJson('/api/reports/summary?start_date=2026-10-30&end_date=2026-10-30')->assertOk()
                ->assertJsonPath('data.cohort.total', 2)->assertJsonPath('data.movements.created', 2)
                ->assertJsonPath('meta.start_utc', '2026-10-30T03:00:00.000000Z');
            foreach ($checks as $check) {
                $this->assertSame('repeatable read', $check->isolation);
                $this->assertSame('on', $check->read_only);
            }
        } finally {
            $mode = null;
            DB::disconnect('reports_writer');
            DB::disconnect('reports_pg');
        }
    }
}
