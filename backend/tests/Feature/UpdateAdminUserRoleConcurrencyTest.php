<?php

namespace Tests\Feature;

use App\Models\TicketActivity;
use App\Models\TicketComment;
use App\Models\User;
use App\Models\UserRoleChange;
use Illuminate\Support\Facades\DB;
use Symfony\Component\Process\Process;
use Tests\Support\UserRoleFixtures;
use Tests\TestCase;

class UpdateAdminUserRoleConcurrencyTest extends TestCase
{
    use UserRoleFixtures;

    private array $connection;

    private array $workers = [];

    public function test_disposable_postgresql_role_changes_assignments_comments_and_admins_are_serialized(): void
    {
        $connection = $this->configureRolePostgresql();
        if ($connection === null) {
            $this->markTestSkipped('Requires disposable PostgreSQL via FLOWDESK_ROLE_PG_HOST.');
        }
        $this->connection = $connection;
        $this->createRoleFixtures();
        try {
            $this->sameTargetConflict();
            $this->mutualAdminDemotions();
            $this->roleWinsAgainstAssignmentAndComment('assignment');
            $this->roleWinsAgainstAssignmentAndComment('comment');
            $this->ticketWriterWins('assignment');
            $this->ticketWriterWins('comment');
            $this->nameEditDoesNotDeadlockOrOverwriteRole();
            $this->assertDatabaseCount('sessions', 0);
            $this->assertSame(0, DB::transactionLevel());
        } finally {
            $this->cleanupWorkers();
            DB::disconnect();
        }
    }

    private function sameTargetConflict(): void
    {
        $actor = User::factory()->create(['role' => 'admin']);
        $other = User::factory()->create(['role' => 'admin']);
        $target = User::factory()->create(['role' => 'requester']);
        DB::beginTransaction();
        User::whereKey($target->id)->lockForUpdate()->firstOrFail();
        $first = $this->worker('role', $actor, ['target_id' => $target->id, 'payload' => ['role' => 'technician', 'expected_role' => 'requester']]);
        $this->waitBlocked($first);
        $second = $this->worker('role', $other, ['target_id' => $target->id, 'payload' => ['role' => 'admin', 'expected_role' => 'requester']]);
        $this->waitBlocked($second);
        DB::commit();
        $winner = $this->workerResult($first);
        $loser = $this->workerResult($second);
        $this->assertSame(200, $winner['status']);
        $this->assertSame(409, $loser['status']);
        $this->assertSame('role_changed', $loser['body']['code']);
        $this->assertSame([], $loser['writes']);
        $this->assertSame('technician', $target->fresh()->role);
        $this->assertSame(1, UserRoleChange::where('target_user_id', $target->id)->count());
        $this->assertSame($actor->id, UserRoleChange::where('target_user_id', $target->id)->sole()->actor_id);
        $this->assertSame([
            ['id' => $actor->id, 'mode' => 'share'], ['id' => $target->id, 'mode' => 'update'],
        ], $winner['locks']);
    }

    private function mutualAdminDemotions(): void
    {
        // Setup only: leave precisely the two administrators involved in this dispute.
        User::where('role', 'admin')->update(['role' => 'requester']);
        $firstAdmin = User::factory()->create(['role' => 'admin']);
        $secondAdmin = User::factory()->create(['role' => 'admin']);
        User::factory()->create(['role' => 'admin', 'disabled_at' => now()]);
        $count = UserRoleChange::count();
        DB::beginTransaction();
        DB::select('SELECT pg_advisory_xact_lock(706402, 1)');
        $first = $this->worker('role', $firstAdmin, ['target_id' => $secondAdmin->id, 'payload' => ['role' => 'requester', 'expected_role' => 'admin']]);
        $second = $this->worker('role', $secondAdmin, ['target_id' => $firstAdmin->id, 'payload' => ['role' => 'technician', 'expected_role' => 'admin']]);
        $this->waitBlocked($first);
        $this->waitBlocked($second);
        DB::commit();
        $results = [$this->workerResult($first), $this->workerResult($second)];
        $statuses = array_column($results, 'status');
        sort($statuses);
        $this->assertSame([200, 403], $statuses);
        $this->assertSame(1, User::where('role', 'admin')->whereNull('disabled_at')->count());
        $this->assertSame($count + 1, UserRoleChange::count());
        foreach ($results as $result) {
            if ($result['status'] === 403) {
                $this->assertSame([], $result['writes']);
            }
        }
    }

    private function roleWinsAgainstAssignmentAndComment(string $operation): void
    {
        // Lower target ID exercises mixed locks: exclusive target, then shared administrator.
        $target = User::factory()->create(['role' => 'technician']);
        $actor = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket(['requester_id' => $target->id]);
        DB::beginTransaction();
        User::whereKey($target->id)->lockForUpdate()->firstOrFail();
        $role = $this->worker('role', $actor, ['target_id' => $target->id, 'payload' => ['role' => 'requester', 'expected_role' => 'technician']]);
        $this->waitBlocked($role);
        $writer = $this->worker($operation, $operation === 'comment' ? $target : $actor, [
            'ticket_id' => $ticket->id,
            'payload' => $operation === 'comment' ? ['body' => 'Internal before demotion.', 'is_internal' => true] : ['assigned_to' => $target->id],
        ]);
        $this->waitBlocked($writer);
        $ticketBefore = $ticket->fresh()->getAttributes();
        DB::commit();
        $roleResult = $this->workerResult($role);
        $writeResult = $this->workerResult($writer);
        $this->assertSame(200, $roleResult['status']);
        $this->assertSame($operation === 'comment' ? 403 : 422, $writeResult['status']);
        $this->assertSame([], $writeResult['writes']);
        $this->assertSame('requester', $target->fresh()->role);
        $this->assertSame($ticketBefore, $ticket->fresh()->getAttributes());
        $this->assertSame(0, TicketActivity::where('ticket_id', $ticket->id)->count());
        $this->assertSame(0, TicketComment::where('ticket_id', $ticket->id)->count());
        $this->assertSame(1, UserRoleChange::where('target_user_id', $target->id)->count());
        $this->assertSame([
            ['id' => $target->id, 'mode' => 'update'], ['id' => $actor->id, 'mode' => 'share'],
        ], $roleResult['locks']);
    }

    private function ticketWriterWins(string $operation): void
    {
        $target = User::factory()->create(['role' => 'technician']);
        $actor = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket(['requester_id' => $target->id]);
        DB::beginTransaction();
        DB::select('SELECT pg_advisory_xact_lock(706402, 2)');
        $writer = $this->worker($operation, $operation === 'comment' ? $target : $actor, [
            'ticket_id' => $ticket->id, 'hold_before_commit' => true,
            'payload' => $operation === 'comment' ? ['body' => 'Valid internal comment.', 'is_internal' => true] : ['assigned_to' => $target->id],
        ]);
        $this->waitBlocked($writer, 'mutation_written');
        $role = $this->worker('role', $actor, ['target_id' => $target->id, 'payload' => ['role' => 'requester', 'expected_role' => 'technician']]);
        $this->waitBlocked($role);
        $this->assertSame('technician', $target->fresh()->role);
        $this->assertNull($ticket->fresh()->assigned_to);
        DB::commit();
        $this->assertSame($operation === 'comment' ? 201 : 200, $this->workerResult($writer)['status']);
        $roleResult = $this->workerResult($role);
        if ($operation === 'assignment') {
            $this->assertSame(409, $roleResult['status']);
            $this->assertSame('active_assignments', $roleResult['body']['code']);
            $this->assertSame([], $roleResult['writes']);
            $this->assertSame('technician', $target->fresh()->role);
            $this->assertSame($target->id, $ticket->fresh()->assigned_to);
            $this->assertSame(0, UserRoleChange::where('target_user_id', $target->id)->count());
        } else {
            $this->assertSame(200, $roleResult['status']);
            $this->assertSame('requester', $target->fresh()->role);
            $this->assertTrue(TicketComment::where('ticket_id', $ticket->id)->sole()->is_internal);
            $this->assertNull($ticket->fresh()->first_responded_at);
            $this->assertSame(1, UserRoleChange::where('target_user_id', $target->id)->count());
        }
        $this->assertSame(1, TicketActivity::where('ticket_id', $ticket->id)->count());
    }

    private function nameEditDoesNotDeadlockOrOverwriteRole(): void
    {
        $target = User::factory()->create(['role' => 'requester']);
        $actor = User::factory()->create(['role' => 'admin']);
        DB::beginTransaction();
        User::whereKey($target->id)->lockForUpdate()->firstOrFail();
        $role = $this->worker('role', $actor, ['target_id' => $target->id, 'payload' => ['role' => 'admin', 'expected_role' => 'requester']]);
        $this->waitBlocked($role);
        $name = $this->worker('name', $actor, ['target_id' => $target->id, 'payload' => ['name' => 'Nome Concorrente']]);
        $this->waitBlocked($name);
        DB::commit();
        $this->assertSame(200, $this->workerResult($role)['status']);
        $this->assertSame(200, $this->workerResult($name)['status']);
        $this->assertSame('admin', $target->fresh()->role);
        $this->assertSame('Nome Concorrente', $target->fresh()->name);
        $this->assertSame(1, UserRoleChange::where('target_user_id', $target->id)->count());
    }

    private function worker(string $operation, User $actor, array $input): array
    {
        $key = bin2hex(random_bytes(4));
        $process = new Process([PHP_BINARY, base_path('tests/Support/role-worker.php')], base_path(), input: json_encode([
            'connection' => $this->connection, 'operation' => $operation, 'actor_id' => $actor->id, 'worker_key' => $key, ...$input,
        ], JSON_THROW_ON_ERROR), timeout: 90);
        $process->start();
        $worker = ['process' => $process, 'key' => $key];
        $this->workers[] = $worker;

        return $worker;
    }

    private function waitBlocked(array $worker, string $marker = 'validated'): void
    {
        $process = $worker['process'];
        $deadline = microtime(true) + 60;
        do {
            $process->checkTimeout();
            if ($process->getErrorOutput() !== '' || ! $process->isRunning()) {
                $this->fail('Worker did not reach its barrier: '.$process->getErrorOutput().$process->getOutput());
            }
            DB::select('SELECT pg_stat_clear_snapshot()');
            $waiting = DB::selectOne("SELECT count(*) AS total FROM pg_stat_activity WHERE datname='flowdesk_role_test' AND application_name=? AND wait_event_type='Lock'", ['flowdesk_role_worker_'.$worker['key']]);
            if (str_contains($process->getOutput(), $marker) && (int) $waiting->total === 1) {
                return;
            }
            usleep(20_000);
        } while (microtime(true) < $deadline);
        $this->fail('Expected PostgreSQL lock barrier was not reached.');
    }

    private function workerResult(array $worker): array
    {
        $process = $worker['process'];
        $process->wait();
        $this->assertSame(0, $process->getExitCode(), $process->getErrorOutput());
        $this->assertSame('', $process->getErrorOutput());
        $lines = explode("\n", trim($process->getOutput()));

        return json_decode(end($lines), true, flags: JSON_THROW_ON_ERROR);
    }

    private function cleanupWorkers(): void
    {
        while (DB::transactionLevel() > 0) {
            DB::rollBack();
        }
        foreach ($this->workers as $worker) {
            if ($worker['process']->isRunning()) {
                $worker['process']->stop(0.2);
            }
        }
    }
}
