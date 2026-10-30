<?php

namespace Tests\Feature;

use App\Models\Category;
use App\Models\Ticket;
use App\Models\User;
use App\Services\ReportCsv;
use App\Services\ReportTicketExport;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\DataProviderExternal;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class ReportExportTest extends TestCase
{
    use AssignmentFixtures;

    private User $admin;

    private const PERIOD = 'start_date=2026-10-01&end_date=2026-10-30';

    private const URL = '/api/reports/tickets/export?'.self::PERIOD;

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
        $ticket->forceFill(array_replace(['created_at' => CarbonImmutable::parse('2026-10-10T12:00:00Z')], $attributes))->save();

        return $ticket;
    }

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

        return $rows;
    }

    public function test_empty_csv_has_bom_header_safe_download_headers_and_server_filename(): void
    {
        $response = $this->getJson(self::URL)->assertOk()->assertHeader('Content-Type', 'text/csv; charset=UTF-8')
            ->assertHeader('X-Content-Type-Options', 'nosniff');
        $csv = $response->streamedContent();
        $this->assertSame([ReportCsv::HEADERS], $this->parse($csv));
        $this->assertStringContainsString('attachment;', $response->headers->get('Content-Disposition'));
        $this->assertStringContainsString('flowdesk-chamados-20261030_150000Z.csv', $response->headers->get('Content-Disposition'));
        $this->assertStringContainsString('private', $response->headers->get('Cache-Control'));
        $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
        $this->assertStringContainsString('sandbox', $response->headers->get('Content-Security-Policy'));
        $this->assertSame((string) strlen($csv), $response->headers->get('Content-Length'));
    }

    public function test_csv_uses_combined_filters_and_table_projection_but_ignores_pagination(): void
    {
        $owner = User::factory()->create(['role' => 'requester', 'disabled_at' => now()]);
        $category = Category::firstOrFail();
        $category->update(['is_active' => false]);
        $ids = [];
        for ($i = 0; $i < 3; $i++) {
            $ids[] = $this->row(['assigned_to' => $owner->id, 'category_id' => $category->id, 'priority' => 'urgent'])->id;
        }
        $this->row();
        $filters = self::PERIOD.'&assigned_to='.$owner->id.'&category_id='.$category->id.'&priority=urgent&status=open';
        $table = $this->getJson('/api/reports/tickets?'.$filters.'&per_page=100')->assertOk()->json('data');
        $before = $this->snapshot();
        $rows = $this->parse($this->getJson('/api/reports/tickets/export?'.$filters.'&page=999&per_page=1')->assertOk()->streamedContent());
        array_shift($rows);
        $this->assertSame(array_reverse($ids), array_map(fn ($r) => (int) $r[0], $rows));
        foreach ($rows as $i => $row) {
            $ticket = $table[$i];
            $decoded = array_map(fn ($cell, $column) => $column === 0 || $cell === '' ? $cell : substr($cell, 1), $row, array_keys($row));
            $this->assertSame([(string) $ticket['id'], $ticket['title'], $ticket['requester']['name'], $ticket['assignee']['name'],
                $ticket['category']['name'], $ticket['priority'], $ticket['status']['name'], $ticket['created_at'],
                $ticket['first_responded_at'] ?? '', $ticket['resolved_at'] ?? '', $ticket['closed_at'] ?? '',
                $ticket['sla']['first_response'], $ticket['sla']['resolution']], $decoded);
        }
        $this->assertSame($before, $this->snapshot());
    }

    public function test_special_characters_nulls_and_sensitive_fields_are_serialized_safely(): void
    {
        $title = "Ação; \"aspas\", vírgula\nsegunda linha \\ barra";
        $this->row(['title' => $title, 'description' => 'SEGREDO_NAO_EXPORTAR']);
        $csv = $this->getJson(self::URL.'&assigned_to=unassigned')->assertOk()->streamedContent();
        $rows = $this->parse($csv);
        $this->assertSame("'Ação; \"aspas\", vírgula segunda linha \\ barra", $rows[1][1]);
        $this->assertSame('', $rows[1][3]);
        foreach ([8, 9, 10] as $column) {
            $this->assertSame('', $rows[1][$column]);
        }
        $this->assertCount(13, $rows[1]);
        foreach (['SEGREDO_NAO_EXPORTAR', 'password', 'session_version', 'storage_key', 'remember_token', '@example'] as $secret) {
            $this->assertStringNotContainsString($secret, $csv);
        }
    }

    public static function injections(): array
    {
        return array_map(fn ($value) => [$value], ['=1+1', '+SUM(A1)', '-1+2', '@SUM(A1)', '   =1+1', "\t=1+1", "\r\n+1",
            "\0-1", "\u{FEFF}@x", "\u{200B}=x", '＝1+1', '＋1', '－1', '＠x', "\u{00A0}=1", "\u{2028}=1", "\u{202E}=1",
            "'=1", 'x";=HYPERLINK("x")', 'Texto comum com ação']);
    }

    #[DataProvider('injections')]
    public function test_all_text_cells_are_prefixed_including_unicode_and_controls(string $value): void
    {
        $owner = User::factory()->create(['role' => 'technician', 'name' => $value]);
        $this->row(['title' => $value, 'assigned_to' => $owner->id]);
        $this->requester->update(['name' => $value]);
        Category::firstOrFail()->update(['name' => $value]);
        DB::table('ticket_statuses')->where('code', 'open')->update(['name' => $value]);
        $csv = $this->getJson(self::URL)->assertOk()->streamedContent();
        $rows = $this->parse($csv);
        $this->assertCount(2, $rows);
        $this->assertCount(13, $rows[1]);
        foreach (array_slice($rows[1], 1) as $cell) {
            if ($cell === '') {
                continue;
            }
            $this->assertStringStartsWith("'", $cell);
            $this->assertDoesNotMatchRegularExpression('/[\p{C}\p{Zl}\p{Zp}]/u', $cell);
        }
    }

    private function many(int $count): void
    {
        $ticket = $this->row();
        $attributes = $ticket->getAttributes();
        unset($attributes['id']);
        for ($remaining = $count - 1; $remaining > 0; $remaining -= 100) {
            DB::table('tickets')->insert(array_fill(0, min(100, $remaining), $attributes));
        }
    }

    public function test_limit_exactly_5000_and_keyset_batches_preserve_all_ties(): void
    {
        $this->many(5000);
        DB::enableQueryLog();
        $csv = $this->getJson(self::URL)->assertOk()->streamedContent();
        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        $rows = $this->parse($csv);
        array_shift($rows);
        $ids = array_map(fn ($row) => (int) $row[0], $rows);
        $this->assertCount(5000, $ids);
        $this->assertSame(range(5000, 1), $ids);
        $ticketQueries = array_filter($queries, fn ($q) => str_contains($q['query'], '"tickets"'));
        $this->assertCount(26, $ticketQueries); // bounded count + 25 keyset batches
    }

    public function test_exceeding_limit_is_json_422_without_partial_csv_or_silent_truncation(): void
    {
        $this->many(5001);
        $this->getJson(self::URL.'&page=99&per_page=1')->assertUnprocessable()->assertExactJson([
            'message' => 'A exportação permite no máximo 5.000 chamados. Restrinja os filtros e tente novamente.',
            'code' => 'export_limit_exceeded', 'limit' => 5000,
        ]);
    }

    public function test_invalid_queries_and_wrong_roles_do_not_export(): void
    {
        foreach (['start_date=bad&end_date=2026-10-01', 'per_page=101', 'filename=secrets.csv', 'status=bad'] as $query) {
            $this->getJson('/api/reports/tickets/export?'.$query)->assertUnprocessable();
        }
        foreach (['requester', 'technician'] as $role) {
            Auth::forgetGuards();
            $this->actingAs(User::factory()->create(['role' => $role]), 'web')->getJson(self::URL)->assertForbidden();
        }
        $this->admin->update(['disabled_at' => now()]);
        Auth::forgetGuards();
        $this->actingAs($this->admin->fresh(), 'web')->getJson(self::URL)->assertForbidden();
        Auth::forgetGuards();
        $this->getJson(self::URL)->assertUnauthorized();
    }

    #[DataProviderExternal(ReportSummaryTest::class, 'cutovers')]
    public function test_authorization_is_revalidated_before_bytes_and_buffers_are_closed(array $changes, int $status): void
    {
        $admin = $this->admin;
        $delegate = $this->app->make(ReportTicketExport::class);
        $mock = new class($delegate, $admin, $changes) extends ReportTicketExport
        {
            public mixed $buffer = null;

            public function __construct(private ReportTicketExport $delegate, private User $admin, private array $changes) {}

            public function generate(CarbonImmutable $start, CarbonImmutable $end, CarbonImmutable $now, array $filters): mixed
            {
                $this->buffer = $this->delegate->generate($start, $end, $now, $filters);
                DB::table('users')->where('id', $this->admin->id)->update($this->changes);

                return $this->buffer;
            }
        };
        $this->app->instance(ReportTicketExport::class, $mock);
        $response = $this->getJson(self::URL)->assertStatus($status);
        $this->assertFalse(is_resource($mock->buffer));
        $this->assertStringNotContainsString('text/csv', $response->headers->get('Content-Type'));
        if ($status === 401) {
            $response->assertJsonPath('code', 'session_revoked');
        }
    }

    public function test_serialization_failure_returns_safe_503_and_invalidates_no_records(): void
    {
        $this->row();
        $before = $this->snapshot();
        $this->app->instance(ReportCsv::class, new class extends ReportCsv
        {
            public function writeTicket(mixed $stream, array $ticket): void
            {
                throw new \RuntimeException('/private/unexpected-path');
            }
        });
        $this->getJson(self::URL)->assertStatus(503)->assertExactJson(['message' => 'Relatórios temporariamente indisponíveis.', 'code' => 'report_unavailable']);
        $this->assertSame($before, $this->snapshot());
    }
}
