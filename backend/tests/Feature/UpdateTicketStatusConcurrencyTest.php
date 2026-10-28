<?php

namespace Tests\Feature;

use App\Models\Ticket;
use App\Models\TicketActivity;
use App\Models\TicketStatus;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Symfony\Component\Process\Process;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class UpdateTicketStatusConcurrencyTest extends TestCase
{
    use AssignmentFixtures;

    public function test_independent_postgresql_requests_preserve_idempotency_transitions_and_authorization(): void
    {
        $host = getenv('FLOWDESK_STATUS_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requer PostgreSQL descartável via FLOWDESK_STATUS_PG_HOST; SQLite não testa bloqueios de linha.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-status-test-[a-f0-9]+$/', $host);
        $connection = [
            'driver' => 'pgsql', 'host' => $host, 'port' => 5432,
            'database' => 'flowdesk_status_test', 'username' => 'postgres', 'password' => '',
            'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer',
        ];
        config(['database.default' => 'status_pg', 'database.connections.status_pg' => $connection]);
        $this->createAssignmentFixtures();
        $technician = User::factory()->create(['role' => 'technician']);
        $other = User::factory()->create(['role' => 'technician']);
        $admin = User::factory()->create(['role' => 'admin']);

        foreach (['duplicate', 'conflicting', 'ownership'] as $scenario) {
            $ticket = $this->ticket([
                'assigned_to' => $technician->id,
                'status_id' => TicketStatus::where('code', 'in_progress')->sole()->id,
            ]);
            $original = $ticket->fresh()->getAttributes();
            $snapshot = $this->snapshot();
            $workers = [];
            try {
                DB::beginTransaction();
                Ticket::whereKey($ticket->id)->lockForUpdate()->firstOrFail();
                $requests = [['user' => $technician, 'status' => 'resolved']];
                if ($scenario !== 'ownership') {
                    $requests[] = ['user' => $admin, 'status' => $scenario === 'duplicate' ? 'resolved' : 'waiting_requester'];
                }
                foreach ($requests as $index => $request) {
                    // Relógios distintos detectam regravação indevida da primeira resolução.
                    $input = ['connection' => $connection, 'user_id' => $request['user']->id,
                        'ticket_id' => $ticket->id, 'status' => $request['status'],
                        'now' => $index === 0 ? '2030-01-01T10:00:00Z' : '2030-01-01T10:05:00Z'];
                    $process = new Process([PHP_BINARY, base_path('tests/Support/status-worker.php')], base_path(), input: json_encode($input, JSON_THROW_ON_ERROR), timeout: 30);
                    $process->start();
                    $workers[] = $process;
                }
                // Ambos passaram pela autorização inicial, mas aguardam o bloqueio do pai.
                $this->waitForWorkers($workers, fn ($output) => str_contains($output, "ready\n"));
                if ($scenario === 'ownership') {
                    DB::table('tickets')->where('id', $ticket->id)->update(['assigned_to' => $other->id]);
                }
                DB::commit();
                $this->waitForWorkers($workers, fn ($output) => str_contains($output, '"status":'));
                $results = array_map(function (Process $process): array {
                    $lines = explode("\n", trim($process->getOutput()));

                    return json_decode(end($lines), true, flags: JSON_THROW_ON_ERROR);
                }, $workers);
                $statuses = array_column($results, 'status');
                sort($statuses);
                $this->assertSame(match ($scenario) {
                    'duplicate' => [200, 200], 'conflicting' => [200, 409], 'ownership' => [404],
                }, $statuses);
                $fresh = $ticket->fresh();
                $activities = TicketActivity::where('ticket_id', $ticket->id)->get();
                if ($scenario === 'ownership') {
                    $this->assertCount(0, $activities);
                    $original['assigned_to'] = $other->id;
                    $this->assertSame($original, $fresh->getAttributes());
                } else {
                    $this->assertCount(1, $activities);
                    if ($scenario === 'duplicate') {
                        $this->assertSame($results[0]['body'], $results[1]['body']);
                    }
                    $winner = array_search(200, array_column($results, 'status'), true);
                    $body = $results[$winner]['body'];
                    $this->assertSame(['id', 'status', 'resolved_at', 'closed_at', 'updated_at'], array_keys($body));
                    $this->assertSame($fresh->status->code, $body['status']['code']);
                    $this->assertSame($fresh->resolved_at?->toISOString(), $body['resolved_at']);
                    $this->assertSame($fresh->updated_at->toISOString(), $body['updated_at']);
                    $activity = $activities->sole();
                    $this->assertSame('status_changed', $activity->action);
                    $this->assertSame(['status'], array_keys($activity->changes));
                    $this->assertCount(2, $activity->changes['status']);
                    $this->assertSame('in_progress', $activity->changes['status']['from']);
                    $this->assertSame($fresh->status->code, $activity->changes['status']['to']);
                    $this->assertTrue($activity->created_at->equalTo($fresh->updated_at));
                    if ($scenario === 'conflicting') {
                        $this->assertSame($requests[$winner]['user']->id, $activity->actor_id);
                    } else {
                        $this->assertContains($activity->actor_id, [$technician->id, $admin->id]);
                    }
                    $current = $fresh->getAttributes();
                    unset($original['status_id'], $original['resolved_at'], $original['updated_at'], $current['status_id'], $current['resolved_at'], $current['updated_at']);
                    $this->assertSame($original, $current);
                }
                $after = $this->snapshot();
                unset($snapshot['tickets'], $snapshot['ticket_activities'], $after['tickets'], $after['ticket_activities']);
                $this->assertSame($snapshot, $after);
            } finally {
                if (DB::transactionLevel() > 0) {
                    DB::rollBack();
                }
                foreach ($workers as $process) {
                    if ($process->isRunning()) {
                        $process->stop(0.2);
                    }
                }
            }
        }
        DB::disconnect();
    }

    private function waitForWorkers(array $workers, callable $condition): void
    {
        $deadline = microtime(true) + 25;
        do {
            $done = true;
            foreach ($workers as $process) {
                $process->checkTimeout();
                $output = $process->getOutput();
                if ($process->getErrorOutput() !== '' || (! $condition($output) && ! $process->isRunning())) {
                    $this->fail('O kernel HTTP independente falhou: '.$process->getErrorOutput().$output);
                }
                $done = $done && $condition($output);
            }
            if ($done) {
                return;
            }
            usleep(10_000);
        } while (microtime(true) < $deadline);

        $this->fail('Os processos concorrentes não atingiram a barreira esperada.');
    }
}
