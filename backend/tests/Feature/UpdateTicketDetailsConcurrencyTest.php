<?php

namespace Tests\Feature;

use App\Models\Category;
use App\Models\SlaPolicy;
use App\Models\Ticket;
use App\Models\TicketActivity;
use App\Models\TicketStatus;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Symfony\Component\Process\Process;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class UpdateTicketDetailsConcurrencyTest extends TestCase
{
    use AssignmentFixtures;

    public function test_independent_postgresql_requests_serialize_and_revalidate_details_and_sla(): void
    {
        $host = getenv('FLOWDESK_DETAILS_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requer PostgreSQL descartável via FLOWDESK_DETAILS_PG_HOST; SQLite não testa bloqueios de linha.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-details-test-[a-f0-9]+$/', $host);
        $connection = [
            'driver' => 'pgsql', 'host' => $host, 'port' => 5432,
            'database' => 'flowdesk_details_test', 'username' => 'postgres', 'password' => '',
            'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer',
        ];
        config(['database.default' => 'details_pg', 'database.connections.details_pg' => $connection]);
        $this->createAssignmentFixtures();
        $admin = User::factory()->create(['role' => 'admin']);
        $otherTechnician = User::factory()->create(['role' => 'technician']);
        $untouched = $this->ticket();
        $untouchedBefore = $untouched->fresh()->getAttributes();

        try {
            // A ausência da política é testada antes de haver chamados que a referenciem.
            foreach (['policy', 'duplicate', 'partial', 'conflicting', 'ownership', 'unassigned', 'terminal', 'disabled', 'role', 'category', 'deleted_category', 'changed_policy'] as $scenario) {
                $technician = User::factory()->create(['role' => 'technician']);
                $category = Category::create(['name' => 'Destino '.$scenario, 'is_active' => true]);
                SlaPolicy::updateOrCreate(['priority' => 'high'], ['first_response_minutes' => 60, 'resolution_minutes' => 480]);
                $ticket = $this->ticket([
                    'assigned_to' => $technician->id,
                    'first_responded_at' => now()->subDay()->startOfSecond(),
                ]);
                $ticket->created_at = now()->subDays(2)->startOfSecond();
                $ticket->save();
                $ticket->comments()->create(['user_id' => $this->requester->id, 'body' => 'Preservar comentário.', 'is_internal' => true]);
                $original = $ticket->fresh()->getAttributes();
                $workers = [];
                try {
                    DB::beginTransaction();
                    Ticket::whereKey($ticket->id)->lockForUpdate()->firstOrFail();
                    $requests = [['user' => $technician, 'payload' => ['category_id' => $category->id, 'priority' => 'high']]];
                    if ($scenario === 'duplicate') {
                        $requests[] = ['user' => $admin, 'payload' => $requests[0]['payload']];
                    } elseif ($scenario === 'partial') {
                        $requests = [['user' => $technician, 'payload' => ['category_id' => $category->id]], ['user' => $admin, 'payload' => ['priority' => 'high']]];
                    } elseif ($scenario === 'conflicting') {
                        $requests = [['user' => $technician, 'payload' => ['priority' => 'high']], ['user' => $admin, 'payload' => ['priority' => 'urgent']]];
                    }
                    foreach ($requests as $index => $request) {
                        $input = ['connection' => $connection, 'user_id' => $request['user']->id,
                            'ticket_id' => $ticket->id, 'payload' => $request['payload'],
                            'now' => $index === 0 ? '2030-01-01T10:00:00Z' : '2030-01-01T10:05:00Z'];
                        $process = new Process([PHP_BINARY, base_path('tests/Support/details-worker.php')], base_path(), input: json_encode($input, JSON_THROW_ON_ERROR), timeout: 30);
                        $process->start();
                        $workers[] = $process;
                    }
                    $this->waitForWorkers($workers, fn ($output) => str_contains($output, "ready\n"));
                    $this->waitForLockWaiters(count($workers));
                    // Alterações concorrentes efetivadas enquanto os kernels aguardam a linha.
                    if ($scenario === 'ownership' || $scenario === 'unassigned') {
                        $original['assigned_to'] = $scenario === 'ownership' ? $otherTechnician->id : null;
                        DB::table('tickets')->where('id', $ticket->id)->update(['assigned_to' => $original['assigned_to']]);
                    } elseif ($scenario === 'terminal') {
                        $original['status_id'] = TicketStatus::where('code', 'resolved')->sole()->id;
                        DB::table('tickets')->where('id', $ticket->id)->update(['status_id' => $original['status_id']]);
                    } elseif ($scenario === 'disabled') {
                        $technician->update(['disabled_at' => now()]);
                    } elseif ($scenario === 'role') {
                        $technician->update(['role' => 'requester']);
                    } elseif ($scenario === 'category') {
                        $category->update(['is_active' => false]);
                    } elseif ($scenario === 'deleted_category') {
                        $category->delete();
                    } elseif ($scenario === 'policy') {
                        SlaPolicy::where('priority', 'high')->delete();
                    } elseif ($scenario === 'changed_policy') {
                        SlaPolicy::where('priority', 'high')->update(['first_response_minutes' => 37, 'resolution_minutes' => 173]);
                    }
                    $snapshot = $this->snapshot();
                    DB::commit();
                    $this->waitForWorkers($workers, fn ($output) => str_contains($output, '"status":'));
                    $results = array_map(function (Process $process): array {
                        $lines = explode("\n", trim($process->getOutput()));

                        return json_decode(end($lines), true, flags: JSON_THROW_ON_ERROR);
                    }, $workers);
                    $expectedHttp = match ($scenario) {
                        'ownership' => 404, 'unassigned', 'disabled', 'role' => 403,
                        'terminal' => 409, 'category', 'deleted_category', 'policy' => 422, default => 200,
                    };
                    $this->assertSame(array_fill(0, count($workers), $expectedHttp), array_column($results, 'status'), $scenario);
                    $fresh = $ticket->fresh();
                    $activities = TicketActivity::where('ticket_id', $ticket->id)->orderBy('id')->get();
                    if ($expectedHttp !== 200) {
                        $this->assertCount(0, $activities);
                        $this->assertSame($original, $fresh->getAttributes());
                    } else {
                        $this->assertCount(in_array($scenario, ['partial', 'conflicting'], true) ? 2 : 1, $activities);
                        if ($scenario === 'duplicate') {
                            $this->assertSame($results[0]['body'], $results[1]['body']);
                        }
                        $state = ['category_id' => $original['category_id'], 'priority' => $original['priority']];
                        foreach ($activities as $activity) {
                            $this->assertSame('details_changed', $activity->action);
                            $this->assertContains($activity->actor_id, [$technician->id, $admin->id]);
                            $this->assertNotEmpty($activity->changes);
                            foreach ($activity->changes as $field => $values) {
                                $this->assertContains($field, ['category_id', 'priority']);
                                $this->assertCount(2, $values);
                                $this->assertSame($state[$field], $values['from']);
                                $this->assertNotSame($values['from'], $values['to']);
                                $state[$field] = $values['to'];
                            }
                        }
                        $this->assertSame($state['category_id'], $fresh->category_id);
                        $this->assertSame($state['priority'], $fresh->priority);
                        if ($scenario !== 'conflicting') {
                            $this->assertSame($category->id, $fresh->category_id);
                            $this->assertSame('high', $fresh->priority);
                        }
                        $policy = SlaPolicy::where('priority', $fresh->priority)->sole();
                        $this->assertSame($policy->id, $fresh->sla_policy_id);
                        $this->assertTrue($fresh->first_response_due_at->equalTo($fresh->created_at->copy()->addMinutes($policy->first_response_minutes)));
                        $this->assertTrue($fresh->resolution_due_at->equalTo($fresh->created_at->copy()->addMinutes($policy->resolution_minutes)));
                        $this->assertTrue($fresh->updated_at->equalTo($activities->last()->created_at));
                        foreach ($results as $result) {
                            $this->assertSame(['id', 'category', 'priority', 'updated_at'], array_keys($result['body']));
                            $this->assertSame($ticket->id, $result['body']['id']);
                        }
                        $current = $fresh->getAttributes();
                        foreach (['category_id', 'priority', 'sla_policy_id', 'first_response_due_at', 'resolution_due_at', 'updated_at'] as $field) {
                            unset($original[$field], $current[$field]);
                        }
                        $this->assertSame($original, $current);
                    }
                    $this->assertSame($untouchedBefore, $untouched->fresh()->getAttributes());
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
        } finally {
            DB::disconnect();
        }
    }

    private function waitForLockWaiters(int $count): void
    {
        $deadline = microtime(true) + 10;
        do {
            $waiting = DB::selectOne("select count(*) as total from pg_stat_activity where datname = 'flowdesk_details_test' and application_name = 'flowdesk_details_worker' and wait_event_type = 'Lock' and query like '%for update%'");
            if ((int) $waiting->total === $count) {
                return;
            }
            // A visão de estatísticas pode estar em cache durante a transação do pai.
            DB::select('select pg_stat_clear_snapshot()');
            usleep(10_000);
        } while (microtime(true) < $deadline);

        $this->fail('Os kernels independentes não aguardaram o bloqueio PostgreSQL.');
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
