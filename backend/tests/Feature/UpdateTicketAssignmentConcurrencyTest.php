<?php

namespace Tests\Feature;

use App\Models\Ticket;
use App\Models\TicketActivity;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class UpdateTicketAssignmentConcurrencyTest extends TestCase
{
    use AssignmentFixtures;

    public function test_two_independent_http_requests_claim_once_on_postgresql(): void
    {
        $host = getenv('FLOWDESK_ASSIGNMENT_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requer PostgreSQL descartável via FLOWDESK_ASSIGNMENT_PG_HOST; SQLite não testa bloqueios de linha.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-assignment-test-[a-f0-9]+$/', $host);
        $connection = [
            'driver' => 'pgsql', 'host' => $host, 'port' => 5432,
            'database' => 'flowdesk_assignment_test', 'username' => 'postgres', 'password' => '',
            'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer',
        ];
        config(['database.default' => 'assignment_pg', 'database.connections.assignment_pg' => $connection]);
        $this->createAssignmentFixtures();
        $first = User::factory()->create(['role' => 'technician']);
        $second = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket();
        $original = $ticket->fresh()->getAttributes();
        $workers = [];

        try {
            // Ambos passam pela visibilidade enquanto o registro ainda está sem dono.
            // O bloqueio do pai impede a atualização até os dois processos estarem prontos.
            DB::beginTransaction();
            Ticket::whereKey($ticket->id)->lockForUpdate()->firstOrFail();
            foreach ([$first, $second] as $user) {
                $process = proc_open([PHP_BINARY, base_path('tests/Support/assignment-worker.php')], [
                    0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w'],
                ], $pipes, base_path());
                $this->assertIsResource($process);
                fwrite($pipes[0], json_encode(['connection' => $connection, 'user_id' => $user->id, 'ticket_id' => $ticket->id], JSON_THROW_ON_ERROR));
                fclose($pipes[0]);
                stream_set_blocking($pipes[1], false);
                stream_set_blocking($pipes[2], false);
                $workers[] = ['process' => $process, 'stdout' => $pipes[1], 'stderr' => $pipes[2], 'output' => ''];
            }
            $this->waitForWorkers($workers, fn ($output) => str_contains($output, "ready\n"));
            DB::commit();
            $this->waitForWorkers($workers, fn ($output) => str_contains($output, '"status":'));
            $statuses = [];
            $winnerId = null;
            foreach ($workers as $worker) {
                $lines = explode("\n", trim($worker['output']));
                $result = json_decode(end($lines), true, flags: JSON_THROW_ON_ERROR);
                $statuses[] = $result['status'];
                if ($result['status'] === 200) {
                    $winnerId = $result['body']['assignee']['id'];
                }
            }
            sort($statuses);
            $this->assertSame([200, 409], $statuses);
            $this->assertContains($winnerId, [$first->id, $second->id]);
            $this->assertSame($winnerId, $ticket->fresh()->assigned_to);
            $activity = TicketActivity::sole();
            $this->assertSame($winnerId, $activity->actor_id);
            $this->assertSame('assignment_changed', $activity->action);
            // JSONB não preserva a ordem das chaves do objeto.
            $this->assertSame(['assigned_to'], array_keys($activity->changes));
            $this->assertCount(2, $activity->changes['assigned_to']);
            $this->assertNull($activity->changes['assigned_to']['from']);
            $this->assertSame($winnerId, $activity->changes['assigned_to']['to']);
            $current = $ticket->fresh()->getAttributes();
            unset($original['assigned_to'], $original['updated_at'], $current['assigned_to'], $current['updated_at']);
            $this->assertSame($original, $current);
        } finally {
            if (DB::transactionLevel() > 0) {
                DB::rollBack();
            }
            foreach ($workers as $worker) {
                if (proc_get_status($worker['process'])['running']) {
                    proc_terminate($worker['process']);
                }
                fclose($worker['stdout']);
                fclose($worker['stderr']);
                proc_close($worker['process']);
            }
            DB::disconnect();
        }
    }

    private function waitForWorkers(array &$workers, callable $condition): void
    {
        $deadline = microtime(true) + 20;
        do {
            $done = true;
            foreach ($workers as &$worker) {
                $worker['output'] .= stream_get_contents($worker['stdout']);
                $done = $done && $condition($worker['output']);
                $error = stream_get_contents($worker['stderr']);
                if ($error !== '' || (! $condition($worker['output']) && ! proc_get_status($worker['process'])['running'])) {
                    $this->fail('O processo HTTP independente falhou: '.$error.$worker['output']);
                }
            }
            unset($worker);
            if ($done) {
                return;
            }
            usleep(10_000);
        } while (microtime(true) < $deadline);

        $this->fail('Os processos concorrentes não atingiram a barreira: '.json_encode(array_column($workers, 'output')));
    }
}
