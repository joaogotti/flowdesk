<?php

namespace Tests\Feature;

use App\Models\Ticket;
use App\Models\TicketActivity;
use App\Models\TicketComment;
use App\Models\TicketStatus;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Symfony\Component\Process\Process;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class StoreTicketCommentConcurrencyTest extends TestCase
{
    use AssignmentFixtures;

    public function test_postgresql_serializes_comment_permissions_and_profile_changes(): void
    {
        $host = getenv('FLOWDESK_COMMENT_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requires disposable PostgreSQL via FLOWDESK_COMMENT_PG_HOST.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-comment-test-[a-f0-9]+$/', $host);
        $connection = [
            'driver' => 'pgsql', 'host' => $host, 'port' => 5432,
            'database' => 'flowdesk_comment_test', 'username' => 'postgres', 'password' => '',
            'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer',
        ];
        config(['database.default' => 'comment_pg', 'database.connections.comment_pg' => $connection]);
        $this->createAssignmentFixtures();
        try {
            foreach ([
                ['technician', 'requester', false, true, true, 403],
                ['admin', 'requester', false, true, true, 403],
                ['technician', 'requester', false, false, false, 404],
                ['admin', 'requester', false, false, true, 404],
                ['technician', 'technician', true, true, true, 403],
                ['admin', 'admin', true, true, false, 403],
                ['requester', 'requester', true, true, false, 403],
                ['technician', 'requester', false, true, false, 201],
                ['admin', 'requester', false, true, false, 201],
                ['requester', 'technician', false, true, false, 201],
            ] as [$beforeRole, $afterRole, $disabled, $owner, $internal, $status]) {
                $actor = User::factory()->create(['role' => $beforeRole]);
                $ticket = $this->ticket(['requester_id' => $owner ? $actor->id : $this->requester->id]);
                $process = null;
                try {
                    DB::beginTransaction();
                    User::whereKey($actor->id)->lockForUpdate()->firstOrFail();
                    $process = $this->worker($connection, $actor, $ticket, $internal);
                    $this->waitFor($process, fn () => str_contains($process->getOutput(), 'validated') && $this->waiting('flowdesk_comment_worker'));
                    DB::table('users')->where('id', $actor->id)->update(['role' => $afterRole, 'disabled_at' => $disabled ? now() : null]);
                    $before = $this->snapshot();
                    DB::commit();
                    $result = $this->workerResult($process);
                    $this->assertSame($status, $result['status']);
                    $this->assertSame(['ticket', 'user'], $result['locks']);
                    if ($status !== 201) {
                        $this->assertSame([], $result['writes']);
                        $this->assertSame($before, $this->snapshot());
                        $this->assertSame(['message'], array_keys($result['body']));
                    } else {
                        $comment = TicketComment::where('ticket_id', $ticket->id)->sole();
                        $this->assertSame($actor->id, $comment->user_id);
                        $this->assertFalse($comment->is_internal);
                        $this->assertSame($actor->id, TicketActivity::where('ticket_id', $ticket->id)->sole()->actor_id);
                        $this->assertSame(['id', 'body', 'is_internal', 'author', 'created_at'], array_keys($result['body']));
                        $this->assertSame($afterRole !== 'requester', $ticket->fresh()->first_responded_at !== null);
                        $this->assertSame($beforeRole, $actor->role, 'The worker started with the old identity.');
                    }
                } finally {
                    $this->cleanup([$process]);
                }
            }

            // The ticket must be reread after waiting, before deciding visibility/status.
            foreach (['assignment', 'status'] as $scenario) {
                $actor = User::factory()->create(['role' => 'technician']);
                $other = User::factory()->create(['role' => 'technician']);
                $ticket = $this->ticket();
                $process = null;
                try {
                    DB::beginTransaction();
                    Ticket::whereKey($ticket->id)->lockForUpdate()->firstOrFail();
                    $process = $this->worker($connection, $actor, $ticket, false);
                    $this->waitFor($process, fn () => str_contains($process->getOutput(), 'validated') && $this->waiting('flowdesk_comment_worker'));
                    $changes = $scenario === 'assignment' ? ['assigned_to' => $other->id] : ['status_id' => TicketStatus::where('code', 'resolved')->sole()->id];
                    DB::table('tickets')->where('id', $ticket->id)->update($changes);
                    $before = $this->snapshot();
                    DB::commit();
                    $result = $this->workerResult($process);
                    $this->assertSame($scenario === 'assignment' ? 404 : 409, $result['status']);
                    $this->assertSame([], $result['writes']);
                    $this->assertSame($before, $this->snapshot());
                } finally {
                    $this->cleanup([$process]);
                }
            }

            // Reverse order: a role UPDATE must wait until the comment commits.
            $actor = User::factory()->create(['role' => 'technician']);
            $ticket = $this->ticket(['requester_id' => $actor->id]);
            $commentWorker = $roleWriter = null;
            try {
                DB::beginTransaction();
                DB::select('SELECT pg_advisory_xact_lock(?)', [417208]);
                $commentWorker = $this->worker($connection, $actor, $ticket, true, ['barrier' => 417208]);
                $this->waitFor($commentWorker, fn () => str_contains($commentWorker->getOutput(), 'comment_inserted') && $this->waiting('flowdesk_comment_worker'));
                $roleWriter = $this->worker($connection, $actor, $ticket, false, ['operation' => 'role_update', 'role' => 'requester']);
                $this->waitFor($roleWriter, fn () => $this->waiting('flowdesk_comment_role_writer'));
                $this->assertSame('technician', $actor->fresh()->role);
                $this->assertSame(0, TicketComment::where('ticket_id', $ticket->id)->count());
                DB::commit();
                $this->assertSame(201, $this->workerResult($commentWorker)['status']);
                $roleWriter->wait();
                $this->assertSame(0, $roleWriter->getExitCode(), $roleWriter->getErrorOutput());
                $this->assertStringContainsString('role_committed', $roleWriter->getOutput());
                $this->assertSame('requester', $actor->fresh()->role);
                $this->assertTrue(TicketComment::where('ticket_id', $ticket->id)->sole()->is_internal);
                $this->assertNull($ticket->fresh()->first_responded_at);
                $this->assertSame(1, TicketActivity::where('ticket_id', $ticket->id)->count());
            } finally {
                $this->cleanup([$commentWorker, $roleWriter]);
            }
            $this->assertDatabaseCount('sessions', 0);
        } finally {
            DB::disconnect();
        }
    }

    private function worker(array $connection, User $actor, Ticket $ticket, bool $internal, array $extra = []): Process
    {
        $process = new Process([PHP_BINARY, base_path('tests/Support/comment-worker.php')], base_path(), input: json_encode([
            'connection' => $connection, 'user_id' => $actor->id, 'ticket_id' => $ticket->id,
            'payload' => ['body' => 'Concurrent permission check.', 'is_internal' => $internal], ...$extra,
        ], JSON_THROW_ON_ERROR), timeout: 90);
        $process->start();

        return $process;
    }

    private function waiting(string $application): bool
    {
        DB::select('SELECT pg_stat_clear_snapshot()');

        return (int) DB::selectOne("SELECT COUNT(*) AS total FROM pg_stat_activity WHERE datname='flowdesk_comment_test' AND application_name=? AND wait_event_type='Lock'", [$application])->total === 1;
    }

    private function waitFor(Process $process, callable $condition): void
    {
        $deadline = microtime(true) + 60;
        do {
            $process->checkTimeout();
            if ($process->getErrorOutput() !== '') {
                $this->fail($process->getErrorOutput());
            }
            if ($condition()) {
                return;
            }
            if (! $process->isRunning()) {
                $this->fail('Worker ended before the lock barrier: '.$process->getOutput());
            }
            usleep(20_000);
        } while (microtime(true) < $deadline);
        $this->fail('The expected lock barrier was not reached.');
    }

    private function workerResult(Process $process): array
    {
        $process->wait();
        $this->assertSame(0, $process->getExitCode(), $process->getErrorOutput());
        $this->assertSame('', $process->getErrorOutput());
        $lines = explode("\n", trim($process->getOutput()));

        return json_decode(end($lines), true, flags: JSON_THROW_ON_ERROR);
    }

    private function cleanup(array $processes): void
    {
        while (DB::transactionLevel() > 0) {
            DB::rollBack();
        }
        foreach ($processes as $process) {
            if ($process?->isRunning()) {
                $process->stop(0.2);
            }
        }
    }
}
