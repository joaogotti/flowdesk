<?php

namespace Tests\Feature;

use App\Models\TicketActivity;
use App\Models\TicketComment;
use App\Models\User;
use App\Support\SessionVersion;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Symfony\Component\Process\Process;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class UserSessionVersionPostgresqlTest extends TestCase
{
    use AssignmentFixtures;

    private array $connection;

    private array $workers = [];

    public function test_real_migration_sessions_login_and_writers_obey_version_cutover(): void
    {
        $host = getenv('FLOWDESK_SESSION_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requires disposable PostgreSQL via FLOWDESK_SESSION_PG_HOST.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-session-test-[a-f0-9]+$/', $host);
        $this->connection = ['driver' => 'pgsql', 'host' => $host, 'port' => 5432,
            'database' => 'flowdesk_session_test', 'username' => 'postgres', 'password' => '',
            'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer'];
        config(['database.default' => 'session_pg', 'database.connections.session_pg' => $this->connection]);
        $this->assertSame('flowdesk_session_test', DB::connection()->getDatabaseName());
        $this->createAssignmentFixtures();
        try {
            $this->migrationConstraints();
            foreach (['comment', 'assignment'] as $operation) {
                $this->revocationWins($operation);
                $this->writerWins($operation);
            }
            $this->revocationWinsAgainstLogin();
            $this->loginWinsWithLateSessionSave();
            $this->allOldDevicesLoseAccessWithoutDeletingOtherUsersSessions();
            $this->assertSame(0, DB::transactionLevel());
        } finally {
            while (DB::transactionLevel() > 0) {
                DB::rollBack();
            }
            DB::select('SELECT pg_advisory_unlock_all()');
            foreach ($this->workers as $worker) {
                if ($worker['process']->isRunning()) {
                    $worker['process']->stop(0.2);
                }
            }
            DB::disconnect();
        }
    }

    private function migrationConstraints(): void
    {
        Schema::table('users', fn ($table) => $table->dropColumn('session_version'));
        $before = DB::table('users')->orderBy('id')->get()->toJson();
        $migration = require database_path('migrations/2026_10_28_230000_add_session_version_to_users_table.php');
        $migration->up();
        $this->assertSame(0, $this->requester->fresh()->session_version);
        foreach ([-1, null] as $invalid) {
            DB::beginTransaction();
            try {
                DB::table('users')->where('id', $this->requester->id)->update(['session_version' => $invalid]);
                $this->fail('Invalid session version was accepted.');
            } catch (QueryException $exception) {
                $this->assertContains($exception->errorInfo[0], ['23514', '23502']);
            } finally {
                DB::rollBack();
            }
        }
        $migration->down();
        $this->assertFalse(Schema::hasColumn('users', 'session_version'));
        $this->assertSame($before, DB::table('users')->orderBy('id')->get()->toJson());
        $migration->up();
    }

    private function persistedSession(User $user): string
    {
        $id = bin2hex(random_bytes(20));
        DB::table('sessions')->insert(['id' => $id, 'user_id' => $user->id, 'last_activity' => time(),
            'payload' => base64_encode(json_encode([Auth::guard('web')->getName() => $user->id, SessionVersion::KEY => 0], JSON_THROW_ON_ERROR))]);

        return $id;
    }

    private function worker(string $operation, User $actor, array $input = []): array
    {
        $key = bin2hex(random_bytes(4));
        $process = new Process([PHP_BINARY, base_path('tests/Support/session-version-worker.php')], base_path(), input: json_encode([
            'connection' => $this->connection, 'key' => $key, 'operation' => $operation, 'actor_id' => $actor->id, ...$input,
        ], JSON_THROW_ON_ERROR), timeout: 45);
        $process->start();
        $worker = ['process' => $process, 'key' => $key];
        $this->workers[] = $worker;

        return $worker;
    }

    private function blocked(array $worker, string $marker): void
    {
        $deadline = microtime(true) + 30;
        do {
            $worker['process']->checkTimeout();
            if ($worker['process']->getErrorOutput() !== '' || ! $worker['process']->isRunning()) {
                $this->fail('Worker ended before barrier: '.$worker['process']->getOutput().$worker['process']->getErrorOutput());
            }
            DB::select('SELECT pg_stat_clear_snapshot()');
            $waiting = DB::selectOne("SELECT count(*) AS total FROM pg_stat_activity WHERE datname='flowdesk_session_test' AND application_name=? AND wait_event_type='Lock'", ['flowdesk_session_'.$worker['key']]);
            if (str_contains($worker['process']->getOutput(), $marker) && (int) $waiting->total === 1) {
                return;
            }
            usleep(20_000);
        } while (microtime(true) < $deadline);
        $this->fail('Expected PostgreSQL lock was not observed.');
    }

    private function workerResult(array $worker): array
    {
        $worker['process']->wait();
        $this->assertSame(0, $worker['process']->getExitCode(), $worker['process']->getErrorOutput());
        $this->assertSame('', $worker['process']->getErrorOutput());
        $lines = explode("\n", trim($worker['process']->getOutput()));

        return json_decode(end($lines), true, flags: JSON_THROW_ON_ERROR);
    }

    private function input(User $actor, string $operation): array
    {
        $ticket = $this->ticket();

        return ['ticket_id' => $ticket->id, 'session_id' => $this->persistedSession($actor),
            'payload' => $operation === 'comment' ? ['body' => 'Concurrent comment', 'is_internal' => true] : ['assigned_to' => $actor->id]];
    }

    private function revocationWins(string $operation): void
    {
        $actor = User::factory()->create(['role' => 'technician']);
        $input = $this->input($actor, $operation);
        $beforeComments = TicketComment::count();
        $beforeActivities = TicketActivity::count();
        DB::beginTransaction();
        User::whereKey($actor->id)->lockForUpdate()->firstOrFail();
        $worker = $this->worker($operation, $actor, $input);
        $this->blocked($worker, 'validated');
        DB::table('users')->where('id', $actor->id)->update(['session_version' => 2]);
        DB::table('sessions')->where('user_id', $actor->id)->delete();
        DB::commit();
        $result = $this->workerResult($worker);
        $this->assertSame(401, $result['status']);
        $this->assertSame('session_revoked', $result['body']['code']);
        $this->assertSame([], $result['writes']);
        $this->assertSame($beforeComments, TicketComment::count());
        $this->assertSame($beforeActivities, TicketActivity::count());
    }

    private function writerWins(string $operation): void
    {
        $actor = User::factory()->create(['role' => 'technician']);
        $input = $this->input($actor, $operation);
        DB::select('SELECT pg_advisory_lock(706403, 1)');
        $writer = $this->worker($operation, $actor, [...$input, 'hold_writer' => true]);
        $this->blocked($writer, 'writer_locked');
        $revoke = $this->worker('revoke', $actor);
        $this->blocked($revoke, 'revoke_ready');
        DB::select('SELECT pg_advisory_unlock(706403, 1)');
        $this->assertSame($operation === 'comment' ? 201 : 200, $this->workerResult($writer)['status']);
        $this->assertSame(200, $this->workerResult($revoke)['status']);
        $this->assertSame(2, $actor->fresh()->session_version);
        $this->assertSame(401, $this->workerResult($this->worker('probe', $actor, ['session_id' => $input['session_id']]))['status']);
    }

    private function revocationWinsAgainstLogin(): void
    {
        $actor = User::factory()->create();
        DB::beginTransaction();
        User::whereKey($actor->id)->lockForUpdate()->firstOrFail();
        $worker = $this->worker('login', $actor, ['payload' => ['email' => $actor->email, 'password' => 'password']]);
        $this->blocked($worker, 'candidate_read');
        DB::table('users')->where('id', $actor->id)->update(['session_version' => 2]);
        DB::commit();
        $this->assertSame(401, $this->workerResult($worker)['status']);
        $this->assertSame(0, DB::table('sessions')->where('user_id', $actor->id)->count());
    }

    private function loginWinsWithLateSessionSave(): void
    {
        $actor = User::factory()->create();
        $payload = ['email' => $actor->email, 'password' => 'password'];
        DB::select('SELECT pg_advisory_lock(706403, 1)');
        $login = $this->worker('login', $actor, ['payload' => $payload, 'late_save' => true]);
        $this->blocked($login, 'login_committed');
        DB::transaction(function () use ($actor): void {
            User::whereKey($actor->id)->lockForUpdate()->firstOrFail();
            DB::table('users')->where('id', $actor->id)->update(['session_version' => 2]);
            DB::table('sessions')->where('user_id', $actor->id)->delete();
        });
        DB::select('SELECT pg_advisory_unlock(706403, 1)');
        $result = $this->workerResult($login);
        $this->assertSame(200, $result['status']);
        $this->assertSame(0, $result['version']);
        $row = DB::table('sessions')->where('id', $result['session_id'])->sole();
        $stored = json_decode(base64_decode($row->payload), true, flags: JSON_THROW_ON_ERROR);
        $this->assertSame(0, $stored[SessionVersion::KEY]);
        $probe = $this->workerResult($this->worker('probe', $actor, ['session_id' => $result['session_id']]));
        $this->assertSame(401, $probe['status']);
        $this->assertSame('session_revoked', $probe['body']['code']);
        $fresh = $this->workerResult($this->worker('login', $actor, ['payload' => $payload]));
        $this->assertSame(200, $fresh['status']);
        $this->assertSame(2, $fresh['version']);
    }

    private function allOldDevicesLoseAccessWithoutDeletingOtherUsersSessions(): void
    {
        $actor = User::factory()->create();
        $other = User::factory()->create();
        $devices = [$this->persistedSession($actor), $this->persistedSession($actor)];
        $otherSession = $this->persistedSession($other);
        $credentials = $actor->only(['password', 'remember_token']);
        DB::table('users')->where('id', $actor->id)->increment('session_version', 2);
        foreach ($devices as $sessionId) {
            $result = $this->workerResult($this->worker('probe', $actor, ['session_id' => $sessionId]));
            $this->assertSame(401, $result['status']);
            $this->assertSame('session_revoked', $result['body']['code']);
        }
        $this->assertSame(200, $this->workerResult($this->worker('probe', $other, ['session_id' => $otherSession]))['status']);
        $this->assertSame($credentials, $actor->fresh()->only(['password', 'remember_token']));
        $this->assertTrue(DB::table('sessions')->where('id', $otherSession)->exists());
    }
}
