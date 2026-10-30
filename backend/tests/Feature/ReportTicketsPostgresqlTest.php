<?php

namespace Tests\Feature;

use App\Models\Category;
use App\Models\TicketStatus;
use App\Models\User;
use App\Support\SessionVersion;
use Carbon\CarbonImmutable;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class ReportTicketsPostgresqlTest extends TestCase
{
    use AssignmentFixtures;

    public function test_real_filters_pagination_sla_snapshots_and_authorization_cutovers(): void
    {
        $host = getenv('FLOWDESK_REPORTS_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requires disposable PostgreSQL via FLOWDESK_REPORTS_PG_HOST.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-reports-test-[a-f0-9]+$/', $host);
        $config = ['driver' => 'pgsql', 'host' => $host, 'port' => 5432, 'database' => 'flowdesk_reports_test',
            'username' => 'postgres', 'password' => '', 'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer'];
        config(['database.default' => 'reports_pg', 'database.connections.reports_pg' => $config,
            'database.connections.reports_writer' => $config, 'logging.default' => 'null']);
        $this->createAssignmentFixtures();
        $this->travelTo(CarbonImmutable::parse('2026-10-30T15:00:00Z'));
        $admin = User::factory()->create(['role' => 'admin']);
        $owner = User::factory()->create(['role' => 'requester', 'disabled_at' => now()]);
        $this->actingAs($admin, 'web');
        $category = Category::firstOrFail();
        $category->update(['is_active' => false]);
        $ids = [];
        foreach (['open', 'resolved', 'cancelled'] as $code) {
            $row = $this->ticket(['category_id' => $category->id, 'status_id' => TicketStatus::where('code', $code)->sole()->id, 'assigned_to' => $code === 'resolved' ? $owner->id : null]);
            $row->forceFill(['created_at' => now()->subDay(), 'resolved_at' => $code === 'resolved' ? now() : null])->save();
            $ids[] = $row->id;
        }
        $prototype = $row->getAttributes();
        unset($prototype['id']);
        $writer = DB::connection('reports_writer');
        $mode = null;
        $kind = 'tickets';
        $operation = null;
        $fired = false;
        $isolations = [];
        $raceCategory = Category::create(['name' => 'Categoria de concorrência', 'is_active' => true]);
        $raceTech = User::factory()->create(['role' => 'technician']);
        DB::listen(function (QueryExecuted $query) use (&$mode, &$kind, &$operation, &$fired, &$isolations, $writer, $prototype, $admin, $raceCategory, $raceTech): void {
            if ($mode === null || $fired || $query->connectionName !== 'reports_pg') {
                return;
            }
            $matches = $kind === 'tickets'
                ? str_contains(strtolower($query->sql), 'count(*)') && str_contains($query->sql, '"records"')
                : str_contains($query->sql, 'from "users"') && str_contains($query->sql, 'exists');
            if (! $matches) {
                return;
            }
            $fired = true;
            $isolations[] = DB::selectOne("SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only");
            if ($mode === 'data') {
                $writer->table('tickets')->insert($prototype);
            } elseif ($mode === 'options') {
                $writer->table('categories')->where('id', $raceCategory->id)->update(['is_active' => false]);
                $writer->table('users')->where('id', $raceTech->id)->update(['disabled_at' => now()]);
            } else {
                $writer->table('users')->where('id', $admin->id)->update($operation);
            }
        });
        $period = 'start_date=2026-10-01&end_date=2026-10-30';
        $url = '/api/reports/tickets?'.$period;
        try {
            DB::statement("SET TIME ZONE 'America/Sao_Paulo'");
            $this->getJson($url.'&assigned_to='.$owner->id.'&category_id='.$category->id.'&priority=medium&status=resolved')
                ->assertOk()->assertJsonPath('total', 1)->assertJsonPath('data.0.id', $ids[1])
                ->assertJsonPath('data.0.created_at', '2026-10-29T15:00:00.000000Z');
            $this->getJson($url.'&assigned_to=unassigned')->assertOk()->assertJsonPath('total', 2);
            $mode = 'data';
            $response = $this->getJson($url.'&per_page=100')->assertOk()->assertJsonPath('total', 3)->assertJsonCount(3, 'data');
            $this->assertTrue($fired);
            $this->assertSame(array_reverse($ids), array_column($response->json('data'), 'id'));
            $mode = null;
            $this->getJson($url.'&per_page=100')->assertOk()->assertJsonPath('total', 4)->assertJsonCount(4, 'data');
            $rows = $this->getJson($url.'&per_page=100')->json('data');
            $summary = $this->getJson('/api/reports/summary?'.$period)->assertOk()->json('data.sla');
            foreach (['first_response', 'resolution'] as $obligation) {
                foreach (['met', 'late', 'pending_on_time', 'pending_overdue', 'not_evaluable'] as $state) {
                    $this->assertSame($summary[$obligation][$state], count(array_filter($rows, fn ($r) => $r['sla'][$obligation] === $state)));
                }
            }
            $mode = 'options';
            $kind = 'filters';
            $fired = false;
            $options = $this->getJson('/api/reports/filters')->assertOk()->json('data');
            $this->assertTrue($fired);
            $this->assertContains($owner->id, array_column($options['assignees'], 'id'));
            $this->assertContains($raceTech->id, array_column($options['assignees'], 'id'));
            $this->assertTrue(collect($options['categories'])->firstWhere('id', $raceCategory->id)['is_active']);
            $mode = null;
            $next = $this->getJson('/api/reports/filters')->assertOk()->json('data');
            $this->assertNotContains($raceTech->id, array_column($next['assignees'], 'id'));
            $this->assertFalse(collect($next['categories'])->firstWhere('id', $raceCategory->id)['is_active']);
            foreach (['tickets', 'filters'] as $endpoint) {
                foreach ([[['role' => 'technician'], 403], [['disabled_at' => now()], 403], [['session_version' => 1], 401]] as [$changes, $status]) {
                    $writer->table('users')->where('id', $admin->id)->update(['role' => 'admin', 'disabled_at' => null, 'session_version' => 0]);
                    Auth::forgetGuards();
                    $this->actingAs($admin->fresh(), 'web')->withSession([SessionVersion::KEY => 0]);
                    $kind = $endpoint;
                    $mode = 'auth';
                    $operation = $changes;
                    $fired = false;
                    $this->getJson('/api/reports/'.$endpoint)->assertStatus($status)->assertJsonMissingPath('data');
                    $this->assertTrue($fired);
                }
            }
            foreach ($isolations as $isolation) {
                $this->assertSame('repeatable read', $isolation->isolation);
                $this->assertSame('on', $isolation->read_only);
            }
            $this->assertSame('off', DB::selectOne("SELECT current_setting('transaction_read_only') AS value")->value);
        } finally {
            $mode = null;
            DB::disconnect('reports_writer');
            DB::disconnect('reports_pg');
        }
    }
}
