<?php

namespace Tests\Feature;

use App\Models\TicketActivity;
use App\Models\TicketAttachment;
use App\Models\User;
use App\Support\SessionVersion;
use Illuminate\Cache\RateLimiter;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\Process\Process;
use Tests\Support\AttachmentFixtures;
use Tests\TestCase;

class TicketAttachmentsPostgresqlTest extends TestCase
{
    use AttachmentFixtures;

    private array $connection;

    private array $workers = [];

    public function test_real_constraints_quotas_rate_limit_and_permission_cutovers(): void
    {
        $host = getenv('FLOWDESK_ATTACHMENTS_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requires disposable PostgreSQL via FLOWDESK_ATTACHMENTS_PG_HOST.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-attachments-test-[a-f0-9]+$/', $host);
        $this->connection = ['driver' => 'pgsql', 'host' => $host, 'port' => 5432, 'database' => 'flowdesk_attachments_test',
            'username' => 'postgres', 'password' => '', 'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer'];
        config(['database.default' => 'attachments_pg', 'database.connections.attachments_pg' => $this->connection]);
        try {
            $this->createAttachmentFixtures();
            (require database_path('migrations/0001_01_01_000001_create_cache_table.php'))->up();
            (require database_path('migrations/2026_10_28_210000_create_user_role_changes_table.php'))->up();
            (require database_path('migrations/2026_10_29_020000_create_user_status_changes_table.php'))->up();
            $this->quotaRace(false);
            $this->quotaRace(true);
            foreach (['status', 'role', 'assign', 'ticket_status', 'download'] as $change) {
                $this->permissionRace($change);
            }
            $this->cleanupRace();
            $this->rateRace();
            $this->auditRollback();
            $this->constraintsAndDown();
        } finally {
            while (DB::transactionLevel()) {
                DB::rollBack();
            }
            DB::select('SELECT pg_advisory_unlock_all()');
            foreach ($this->workers as $process) {
                if ($process->isRunning()) {
                    $process->stop(0.2);
                }
            }
            $this->removeAttachmentFiles();
            DB::disconnect();
        }
    }

    private function cookie(User $actor): string
    {
        $id = bin2hex(random_bytes(20));
        DB::table('sessions')->insert(['id' => $id, 'user_id' => $actor->id, 'last_activity' => time(),
            'payload' => base64_encode(json_encode([Auth::guard('web')->getName() => $actor->id, SessionVersion::KEY => $actor->fresh()->session_version]))]);

        return $id;
    }

    private function worker(string $operation, User $actor, array $options = []): array
    {
        $key = bin2hex(random_bytes(4));
        $process = new Process([PHP_BINARY, base_path('tests/Support/attachment-worker.php')], base_path(),
            input: json_encode(['key' => $key, 'connection' => $this->connection, 'root' => $this->attachmentRoot,
                'operation' => $operation, 'session_id' => $options['session_id'] ?? $this->cookie($actor), ...$options]), timeout: 45);
        $process->start();
        $this->workers[] = $process;

        return ['key' => $key, 'process' => $process];
    }

    private function waitForBarrier(array $worker, string $marker = 'io_barrier'): void
    {
        $deadline = microtime(true) + 30;
        do {
            $process = $worker['process'];
            $process->checkTimeout();
            if (! $process->isRunning() || $process->getErrorOutput()) {
                $this->fail($process->getOutput().$process->getErrorOutput());
            }
            DB::select('SELECT pg_stat_clear_snapshot()');
            $waiting = DB::selectOne("SELECT count(*) AS total FROM pg_stat_activity WHERE application_name=? AND datname='flowdesk_attachments_test' AND wait_event_type='Lock'", ['attachment_worker_'.$worker['key']]);
            if (str_contains($process->getOutput(), $marker) && (int) $waiting->total === 1) {
                return;
            }
            usleep(20_000);
        } while (microtime(true) < $deadline);
        $this->fail('I/O barrier was not reached.');
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

    private function quotaRace(bool $bytes): void
    {
        $ticket = $this->ticket();
        $before = TicketActivity::count();
        for ($i = 0; $i < ($bytes ? 4 : 9); $i++) {
            $this->attachment($ticket, 'pending', $bytes ? ['size_bytes' => 5242880] : []);
        }
        DB::select('SELECT pg_advisory_lock(706406, 1)');
        $cookies = [$this->cookie($this->requester), $this->cookie($this->requester)];
        DB::beginTransaction();
        DB::table('tickets')->where('id', $ticket->id)->lockForUpdate()->first();
        $first = $this->worker('upload', $this->requester, ['ticket_id' => $ticket->id, 'hold' => true, 'bytes' => $bytes ? 5242880 : 100, 'session_id' => $cookies[0]]);
        $this->waitForBarrier($first, 'validated');
        $second = $this->worker('upload', $this->requester, ['ticket_id' => $ticket->id, 'hold' => true, 'bytes' => $bytes ? 5242880 : 100, 'session_id' => $cookies[1]]);
        $this->waitForBarrier($second, 'validated');
        // Both requests are inside quota admission, waiting on the same parent row.
        DB::commit();
        $deadline = microtime(true) + 30;
        while (! str_contains($first['process']->getOutput().$second['process']->getOutput(), 'io_barrier')) {
            if (microtime(true) > $deadline) {
                $this->fail('Neither quota contender reached file I/O.');
            }
            usleep(20_000);
        }
        $firstWon = str_contains($first['process']->getOutput(), 'io_barrier');
        $winner = $firstWon ? $first : $second;
        $loser = $this->workerResult($firstWon ? $second : $first);
        $this->waitForBarrier($winner);
        $this->assertSame(409, $loser['status']);
        $this->assertSame('attachment_limit_reached', $loser['body']['code']);
        DB::select('SELECT pg_advisory_unlock(706406, 1)');
        $this->assertSame(201, $this->workerResult($winner)['status']);
        $this->assertSame($bytes ? 5 : 10, TicketAttachment::where('ticket_id', $ticket->id)->count());
        $this->assertSame($before + 1, TicketActivity::count());
    }

    private function permissionRace(string $change): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $tech = User::factory()->create(['role' => 'technician']);
        $other = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket();
        $options = ['ticket_id' => $ticket->id, 'hold' => true];
        if ($change === 'download') {
            $options['attachment_id'] = $this->attachment($ticket)->id;
        }
        DB::select('SELECT pg_advisory_lock(706406, 1)');
        $upload = $this->worker($change === 'download' ? 'download' : 'upload', $tech, $options);
        $this->waitForBarrier($upload);
        $operation = $change === 'download' ? 'status' : $change;
        $payload = match ($operation) {
            'status' => ['is_active' => false, 'expected_is_active' => true],
            'role' => ['role' => 'requester', 'expected_role' => 'technician'],
            'assign' => ['assigned_to' => $other->id],
            'ticket_status' => ['status' => 'cancelled'],
        };
        $this->assertSame(200, $this->workerResult($this->worker($operation, $admin, [
            'ticket_id' => $ticket->id, 'target_id' => $tech->id, 'payload' => $payload]))['status']);
        if ($operation === 'status') {
            $this->assertSame(200, $this->workerResult($this->worker('status', $admin, ['target_id' => $tech->id,
                'payload' => ['is_active' => true, 'expected_is_active' => false]]))['status']);
        }
        DB::select('SELECT pg_advisory_unlock(706406, 1)');
        $result = $this->workerResult($upload);
        $this->assertSame(match ($change) {
            'status', 'download' => 401, 'ticket_status' => 409, default => 404
        }, $result['status']);
        if ($operation === 'status') {
            $this->assertSame('session_revoked', $result['body']['code']);
        }
        if ($change !== 'download') {
            $reservation = TicketAttachment::where('ticket_id', $ticket->id)->sole();
            $this->assertSame('failed', $reservation->state);
            $this->assertNotNull($reservation->cleaned_at);
            $this->assertFalse(Storage::disk('attachments')->exists($reservation->storage_key));
            $this->assertSame(0, TicketActivity::where('ticket_id', $ticket->id)->where('action', 'attachment_added')->count());
        }
    }

    private function cleanupRace(): void
    {
        $actor = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket();
        DB::select('SELECT pg_advisory_lock(706406, 1)');
        $upload = $this->worker('upload', $actor, ['ticket_id' => $ticket->id, 'hold' => true]);
        $this->waitForBarrier($upload);
        $record = TicketAttachment::where('ticket_id', $ticket->id)->sole();
        DB::table('ticket_attachments')->where('id', $record->id)->update(['created_at' => now()->subDays(2), 'expires_at' => now()->subDay()]);
        $gc = $this->workerResult($this->worker('reconcile', $actor));
        $this->assertGreaterThanOrEqual(1, $gc['skipped']);
        $this->assertSame('pending', $record->fresh()->state);
        DB::select('SELECT pg_advisory_unlock(706406, 1)');
        $this->assertSame(409, $this->workerResult($upload)['status']);
        $this->assertSame('failed', $record->fresh()->state);
        $this->assertNotNull($record->fresh()->cleaned_at);
    }

    private function rateRace(): void
    {
        $actor = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket();
        $cookie = $this->cookie($actor);
        // Seed nine attempts in the same shared database cache used by the workers.
        config(['cache.default' => 'database', 'cache.stores.database.connection' => 'attachments_pg']);
        $this->app->forgetInstance(RateLimiter::class);
        for ($i = 0; $i < 9; $i++) {
            \Illuminate\Support\Facades\RateLimiter::hit('attachment-upload:'.$actor->id, 60);
        }
        $a = $this->worker('upload', $actor, ['ticket_id' => $ticket->id, 'session_id' => $cookie]);
        $b = $this->worker('upload', $actor, ['ticket_id' => $ticket->id, 'session_id' => $this->cookie($actor)]);
        $codes = [$this->workerResult($a)['status'], $this->workerResult($b)['status']];
        sort($codes);
        $this->assertSame([201, 429], $codes);
    }

    private function auditRollback(): void
    {
        $actor = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket();
        $before = $ticket->fresh()->getAttributes();
        DB::statement("ALTER TABLE ticket_activities ADD CONSTRAINT simulated_attachment_audit_failure CHECK (action <> 'attachment_added') NOT VALID");
        try {
            $result = $this->workerResult($this->worker('upload', $actor, ['ticket_id' => $ticket->id]));
            $this->assertSame(503, $result['status']);
            $record = TicketAttachment::where('ticket_id', $ticket->id)->sole();
            $this->assertSame('failed', $record->state);
            $this->assertNull($record->confirmed_at);
            $this->assertNotNull($record->cleaned_at);
            $this->assertFalse(Storage::disk('attachments')->exists($record->storage_key));
            $this->assertSame($before, $ticket->fresh()->getAttributes());
            $this->assertSame(0, TicketActivity::where('ticket_id', $ticket->id)->count());
        } finally {
            DB::statement('ALTER TABLE ticket_activities DROP CONSTRAINT simulated_attachment_audit_failure');
        }
    }

    private function constraintsAndDown(): void
    {
        $ticket = $this->ticket();
        $record = $this->attachment($ticket, 'pending');
        foreach ([['size_bytes' => 0], ['size_bytes' => 5242881], ['state' => 'other'], ['state' => 'ready'], ['sha256' => 'invalid'],
            ['storage_key' => '../escape.txt'], ['mime_type' => 'text/html'], ['ticket_id' => 9999999], ['uploaded_by' => 9999999],
            ['original_name' => "bad\n.txt"], ['expires_at' => $record->created_at], ['state' => 'failed', 'confirmed_at' => now()]] as $changes) {
            DB::beginTransaction();
            try {
                DB::table('ticket_attachments')->where('id', $record->id)->update($changes);
                $this->fail('Invalid metadata accepted.');
            } catch (QueryException $e) {
                $this->assertContains($e->errorInfo[0], ['23514', '23503']);
            } finally {
                DB::rollBack();
            }
        }
        DB::beginTransaction();
        try {
            $duplicate = $record->getAttributes();
            unset($duplicate['id']);
            DB::table('ticket_attachments')->insert($duplicate);
            $this->fail('Duplicate storage key accepted.');
        } catch (QueryException $e) {
            $this->assertSame('23505', $e->errorInfo[0]);
        } finally {
            DB::rollBack();
        }
        foreach (['users' => $this->requester->id, 'tickets' => $ticket->id] as $table => $id) {
            DB::beginTransaction();
            try {
                DB::table($table)->where('id', $id)->delete();
                $this->fail('Referenced record was deleted.');
            } catch (QueryException $e) {
                $this->assertSame('23503', $e->errorInfo[0]);
            } finally {
                DB::rollBack();
            }
        }
        $this->assertTrue(Schema::hasIndex('ticket_attachments', 'ticket_attachments_storage_key_unique'));
        $count = User::count();
        (require database_path('migrations/2026_10_29_210000_create_ticket_attachments_table.php'))->down();
        $this->assertFalse(Schema::hasTable('ticket_attachments'));
        $this->assertSame($count, User::count());
    }
}
