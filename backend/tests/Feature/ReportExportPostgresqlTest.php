<?php

namespace Tests\Feature;

use App\Models\Category;
use App\Models\User;
use App\Support\SessionVersion;
use Carbon\CarbonImmutable;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class ReportExportPostgresqlTest extends TestCase
{
    use AssignmentFixtures;

    private function parse(string $csv): array
    {
        $this->assertStringStartsWith("\xEF\xBB\xBF", $csv);
        $stream = fopen('php://memory', 'w+');
        fwrite($stream, substr($csv, 3));
        rewind($stream);
        $rows = [];
        while (($row = fgetcsv($stream, 0, ';', '"', '')) !== false) {
            $rows[] = $row;
        }
        fclose($stream);
        array_shift($rows);

        return $rows;
    }

    public function test_postgresql_export_uses_consistent_keyset_snapshot_limits_and_fresh_authorization(): void
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
        $category = Category::firstOrFail();
        $category->update(['is_active' => false]);
        $ticket = $this->ticket(['category_id' => $category->id, 'assigned_to' => $owner->id, 'priority' => 'urgent', 'title' => '=1+1; "ação"']);
        $ticket->forceFill(['created_at' => CarbonImmutable::parse('2026-10-10T12:00:00Z')])->save();
        $prototype = $ticket->getAttributes();
        unset($prototype['id']);
        for ($remaining = 449; $remaining > 0; $remaining -= 100) {
            DB::table('tickets')->insert(array_fill(0, min(100, $remaining), $prototype));
        }
        $this->ticket(['assigned_to' => null]);
        $writer = DB::connection('reports_writer');
        $mode = null;
        $changes = [];
        $fired = false;
        $checks = [];
        DB::listen(function (QueryExecuted $query) use (&$mode, &$changes, &$fired, &$checks, $writer, $prototype, $ticket, $admin): void {
            if ($mode === null || $fired || $query->connectionName !== 'reports_pg' || ! str_contains($query->sql, '"export_limit"')) {
                return;
            }
            $fired = true;
            $checks[] = DB::selectOne("SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only");
            if ($mode === 'data') {
                $writer->table('tickets')->where('id', $ticket->id)->update(['title' => 'changed_after_snapshot']);
                $writer->table('tickets')->insert($prototype);
            } else {
                $writer->table('users')->where('id', $admin->id)->update($changes);
            }
        });
        $url = '/api/reports/tickets/export?start_date=2026-10-01&end_date=2026-10-30&assigned_to='.$owner->id
            .'&category_id='.$category->id.'&priority=urgent&status=open&page=4&per_page=1';
        try {
            DB::statement("SET TIME ZONE 'America/Sao_Paulo'");
            $this->actingAs($admin, 'web');
            $mode = 'data';
            $csv = $this->getJson($url)->assertOk()->streamedContent();
            $this->assertTrue($fired);
            $rows = $this->parse($csv);
            $this->assertCount(450, $rows);
            $this->assertSame(range(450, 1), array_map(fn ($r) => (int) $r[0], $rows));
            $this->assertStringNotContainsString('changed_after_snapshot', $csv);
            $this->assertSame("'=1+1; \"ação\"", $rows[0][1]);
            $this->assertSame("'2026-10-10T12:00:00.000000Z", $rows[0][7]);
            $mode = null;
            $this->assertCount(451, $this->parse($this->getJson($url)->assertOk()->streamedContent()));
            foreach ([[['role' => 'technician'], 403], [['disabled_at' => now()], 403], [['session_version' => 1], 401]] as [$update, $status]) {
                $writer->table('users')->where('id', $admin->id)->update(['role' => 'admin', 'disabled_at' => null, 'session_version' => 0]);
                Auth::forgetGuards();
                $this->actingAs($admin->fresh(), 'web')->withSession([SessionVersion::KEY => 0]);
                $changes = $update;
                $mode = 'auth';
                $fired = false;
                $response = $this->getJson($url)->assertStatus($status);
                $this->assertTrue($fired);
                $this->assertStringNotContainsString('text/csv', $response->headers->get('Content-Type'));
                if ($status === 401) {
                    $response->assertJsonPath('code', 'session_revoked');
                }
            }
            $mode = null;
            $writer->table('users')->where('id', $admin->id)->update(['role' => 'admin', 'disabled_at' => null, 'session_version' => 0]);
            Auth::forgetGuards();
            $this->actingAs($admin->fresh(), 'web')->withSession([SessionVersion::KEY => 0]);
            for ($remaining = 4550; $remaining > 0; $remaining -= 100) {
                $writer->table('tickets')->insert(array_fill(0, min(100, $remaining), $prototype));
            }
            $this->getJson($url)->assertUnprocessable()->assertJsonPath('code', 'export_limit_exceeded')->assertJsonPath('limit', 5000);
            foreach ($checks as $check) {
                $this->assertSame('repeatable read', $check->isolation);
                $this->assertSame('on', $check->read_only);
            }
            $this->assertSame('off', DB::selectOne("SELECT current_setting('transaction_read_only') AS value")->value);
        } finally {
            $mode = null;
            DB::disconnect('reports_writer');
            DB::disconnect('reports_pg');
        }
    }
}
