<?php

namespace Tests\Feature;

use App\Models\TicketComment;
use App\Models\User;
use App\Models\UserRoleChange;
use App\Models\UserStatusChange;
use App\Support\SessionVersion;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Symfony\Component\Process\Process;
use Tests\Support\UserStatusFixtures;
use Tests\TestCase;

class UpdateAdminUserStatusConcurrencyTest extends TestCase
{
    use UserStatusFixtures;

    private array $connection;

    private array $workers = [];

    public function test_postgresql_status_changes_are_atomic_and_serialize_with_all_writers(): void
    {
        $connection = $this->configureStatusPostgresql();
        if ($connection === null) {
            $this->markTestSkipped('Requires disposable PostgreSQL via FLOWDESK_USER_STATUS_PG_HOST.');
        }
        $this->connection = $connection;
        $this->createStatusFixtures();
        try {
            $this->sameTarget();
            $this->mutualAdministrators('status');
            $this->mutualAdministrators('role');
            $this->actorRevokedWhileWaiting();
            foreach (['assignment', 'comment'] as $operation) {
                $this->statusWins($operation);
                $this->writerWins($operation);
            }
            $this->oldDevicesAndLateLogin();
            $this->nameAndStatusDoNotOverwriteEachOther();
            $this->auditFailureRollsEverythingBack();
            $this->migrationConstraintsAndDown();
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

    private function cookie(User $user): string
    {
        $id = bin2hex(random_bytes(20));
        DB::table('sessions')->insert(['id' => $id, 'user_id' => $user->id, 'last_activity' => time(),
            'payload' => base64_encode(json_encode([Auth::guard('web')->getName() => $user->id,
                SessionVersion::KEY => $user->fresh()->session_version], JSON_THROW_ON_ERROR))]);

        return $id;
    }

    private function worker(string $operation, User $actor, array $input = []): array
    {
        $key = bin2hex(random_bytes(4));
        $process = new Process([PHP_BINARY, base_path('tests/Support/user-status-worker.php')], base_path(), input: json_encode([
            'connection' => $this->connection, 'key' => $key, 'operation' => $operation,
            'session_id' => $input['session_id'] ?? $this->cookie($actor), ...$input,
        ], JSON_THROW_ON_ERROR), timeout: 45);
        $process->start();
        $worker = ['key' => $key, 'process' => $process, 'actor_id' => $actor->id];
        $this->workers[] = $worker;

        return $worker;
    }

    private function waitBlocked(array $worker, string $marker = 'validated'): void
    {
        $deadline = microtime(true) + 30;
        do {
            $worker['process']->checkTimeout();
            if ($worker['process']->getErrorOutput() !== '' || ! $worker['process']->isRunning()) {
                $this->fail('Worker did not reach barrier: '.$worker['process']->getOutput().$worker['process']->getErrorOutput());
            }
            DB::select('SELECT pg_stat_clear_snapshot()');
            $waiting = DB::selectOne("SELECT count(*) AS total FROM pg_stat_activity WHERE datname='flowdesk_user_status_test' AND application_name=? AND wait_event_type='Lock'", ['flowdesk_user_status_'.$worker['key']]);
            if (str_contains($worker['process']->getOutput(), $marker) && (int) $waiting->total === 1) {
                return;
            }
            usleep(20_000);
        } while (microtime(true) < $deadline);
        $this->fail('Expected lock was not observed.');
    }

    private function workerResult(array $worker): array
    {
        $worker['process']->wait();
        $this->assertSame(0, $worker['process']->getExitCode(), $worker['process']->getErrorOutput());
        $this->assertSame('', $worker['process']->getErrorOutput());
        $lines = explode("\n", trim($worker['process']->getOutput()));

        return json_decode(end($lines), true, flags: JSON_THROW_ON_ERROR);
    }

    private function changeStatus(User $actor, User $target, bool $active, array $extra = []): array
    {
        return $this->worker('status', $actor, ['target_id' => $target->id,
            'payload' => ['is_active' => $active, 'expected_is_active' => ! $active], ...$extra]);
    }

    private function sameTarget(): void
    {
        $a = User::factory()->create(['role' => 'admin']);
        $b = User::factory()->create(['role' => 'admin']);
        $target = User::factory()->create();
        $firstCookie = $this->cookie($a);
        $secondCookie = $this->cookie($b);
        DB::beginTransaction();
        DB::select('SELECT pg_advisory_xact_lock(706402, 1)');
        $first = $this->changeStatus($a, $target, false, ['session_id' => $firstCookie]);
        $this->waitBlocked($first);
        $second = $this->changeStatus($b, $target, false, ['session_id' => $secondCookie]);
        $this->waitBlocked($second);
        DB::commit();
        $results = [$this->workerResult($first), $this->workerResult($second)];
        $codes = array_column($results, 'status');
        sort($codes);
        $this->assertSame([200, 409], $codes);
        $loser = $results[$results[0]['status'] === 409 ? 0 : 1];
        $this->assertSame('status_changed', $loser['body']['code']);
        $this->assertSame([], $loser['writes']);
        $this->assertSame(1, $target->fresh()->session_version);
        $this->assertSame(1, UserStatusChange::where('target_user_id', $target->id)->count());
    }

    private function mutualAdministrators(string $operation): void
    {
        User::where('role', 'admin')->update(['role' => 'requester']);
        $a = User::factory()->create(['role' => 'admin']);
        $b = User::factory()->create(['role' => 'admin']);
        $before = UserStatusChange::count() + UserRoleChange::count();
        $firstCookie = $this->cookie($a);
        $secondCookie = $this->cookie($b);
        DB::beginTransaction();
        DB::select('SELECT pg_advisory_xact_lock(706402, 1)');
        $first = $this->changeStatus($a, $b, false, ['session_id' => $firstCookie]);
        $this->waitBlocked($first);
        $second = $operation === 'status' ? $this->changeStatus($b, $a, false, ['session_id' => $secondCookie]) : $this->worker('role', $b, ['target_id' => $a->id, 'session_id' => $secondCookie,
            'payload' => ['role' => 'requester', 'expected_role' => 'admin']]);
        $this->waitBlocked($second);
        DB::commit();
        $results = [$this->workerResult($first), $this->workerResult($second)];
        $this->assertSame(1, count(array_filter($results, fn ($r) => $r['status'] === 200)));
        $loser = $results[$results[0]['status'] === 200 ? 1 : 0];
        $this->assertContains($loser['status'], [401, 403]);
        $this->assertSame([], $loser['writes']);
        $this->assertSame(1, User::where('role', 'admin')->whereNull('disabled_at')->count());
        $this->assertSame($before + 1, UserStatusChange::count() + UserRoleChange::count());
    }

    private function actorRevokedWhileWaiting(): void
    {
        $actor = User::factory()->create(['role' => 'admin']);
        $target = User::factory()->create();
        $cookie = $this->cookie($actor);
        DB::beginTransaction();
        User::whereKey($actor->id)->lockForUpdate()->firstOrFail();
        $worker = $this->changeStatus($actor, $target, false, ['session_id' => $cookie]);
        $this->waitBlocked($worker);
        DB::table('users')->where('id', $actor->id)->update(['session_version' => 1, 'disabled_at' => now()]);
        DB::commit();
        $result = $this->workerResult($worker);
        $this->assertSame(401, $result['status']);
        $this->assertSame('session_revoked', $result['body']['code']);
        $this->assertSame([], $result['writes']);
        $this->assertNull($target->fresh()->disabled_at);
    }

    private function statusWins(string $operation): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $otherAdmin = User::factory()->create(['role' => 'admin']);
        $tech = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket();
        $count = TicketComment::count();
        DB::select('SELECT pg_advisory_lock(706404, 1)');
        $status = $this->changeStatus($admin, $tech, false, ['hold' => true]);
        $this->waitBlocked($status, 'mutation_written');
        $writer = $this->worker($operation, $operation === 'comment' ? $tech : $otherAdmin, ['ticket_id' => $ticket->id,
            'payload' => $operation === 'comment' ? ['body' => 'Concurrent comment', 'is_internal' => true] : ['assigned_to' => $tech->id]]);
        $this->waitBlocked($writer);
        DB::select('SELECT pg_advisory_unlock(706404, 1)');
        $this->assertSame(200, $this->workerResult($status)['status']);
        $denied = $this->workerResult($writer);
        $this->assertSame($operation === 'comment' ? 401 : 422, $denied['status']);
        $this->assertSame([], $denied['writes']);
        $this->assertNull($ticket->fresh()->assigned_to);
        $this->assertSame($count, TicketComment::count());
    }

    private function writerWins(string $operation): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $tech = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket();
        DB::select('SELECT pg_advisory_lock(706404, 1)');
        $writer = $this->worker($operation, $operation === 'comment' ? $tech : $admin, ['ticket_id' => $ticket->id, 'hold' => true,
            'payload' => $operation === 'comment' ? ['body' => 'Authorized first response', 'is_internal' => false] : ['assigned_to' => $tech->id]]);
        $this->waitBlocked($writer, 'mutation_written');
        $status = $this->changeStatus($admin, $tech, false);
        $this->waitBlocked($status);
        DB::select('SELECT pg_advisory_unlock(706404, 1)');
        $this->assertSame($operation === 'comment' ? 201 : 200, $this->workerResult($writer)['status']);
        $result = $this->workerResult($status);
        $this->assertSame($operation === 'comment' ? 200 : 409, $result['status']);
        if ($operation === 'assignment') {
            $this->assertSame('active_assignments', $result['body']['code']);
            $this->assertSame($tech->id, $ticket->fresh()->assigned_to);
            $this->assertSame(0, $tech->fresh()->session_version);
        } else {
            $this->assertNotNull($ticket->fresh()->first_responded_at);
            $this->assertSame(1, $tech->fresh()->session_version);
        }
    }

    private function oldDevicesAndLateLogin(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $target = User::factory()->create();
        $oldDevices = [$this->cookie($target), $this->cookie($target)];
        DB::select('SELECT pg_advisory_lock(706404, 1)');
        $login = $this->worker('login', $target, ['hold' => true, 'payload' => ['email' => $target->email, 'password' => 'password']]);
        $this->waitBlocked($login, 'mutation_written');
        $this->assertSame(200, $this->workerResult($this->changeStatus($admin, $target, false))['status']);
        $this->assertSame(0, DB::table('sessions')->where('user_id', $target->id)->count());
        $this->assertSame(200, $this->workerResult($this->changeStatus($admin, $target, true))['status']);
        DB::select('SELECT pg_advisory_unlock(706404, 1)');
        $late = $this->workerResult($login);
        $this->assertSame(200, $late['status']);
        $this->assertSame(0, $late['version']);
        $this->assertSame(2, $target->fresh()->session_version);
        foreach ([...$oldDevices, $late['session_id']] as $id) {
            $probe = $this->workerResult($this->worker('probe', $target, ['session_id' => $id]));
            $this->assertSame(401, $probe['status']);
        }
        $fresh = $this->workerResult($this->worker('login', $target, ['payload' => ['email' => $target->email, 'password' => 'password']]));
        $this->assertSame(200, $fresh['status']);
        $this->assertSame(2, $fresh['version']);
        $this->assertSame(2, UserStatusChange::where('target_user_id', $target->id)->count());
    }

    private function nameAndStatusDoNotOverwriteEachOther(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $target = User::factory()->create();
        $firstCookie = $this->cookie($admin);
        $secondCookie = $this->cookie($admin);
        DB::beginTransaction();
        User::whereKey($target->id)->lockForUpdate()->firstOrFail();
        $status = $this->changeStatus($admin, $target, false, ['session_id' => $firstCookie]);
        $this->waitBlocked($status);
        $name = $this->worker('name', $admin, ['target_id' => $target->id, 'session_id' => $secondCookie, 'payload' => ['name' => 'Updated concurrently', 'expected_name' => $target->name]]);
        $this->waitBlocked($name);
        DB::commit();
        $this->assertSame(200, $this->workerResult($status)['status']);
        $this->assertSame(200, $this->workerResult($name)['status']);
        $this->assertSame('Updated concurrently', $target->fresh()->name);
        $this->assertNotNull($target->fresh()->disabled_at);
        $this->assertSame(1, $target->fresh()->session_version);
    }

    private function auditFailureRollsEverythingBack(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $target = User::factory()->create();
        $id = $this->cookie($target);
        $before = $target->fresh()->getAttributes();
        $session = DB::table('sessions')->where('id', $id)->sole();
        $count = UserStatusChange::count();
        DB::statement('ALTER TABLE user_status_changes ADD CONSTRAINT simulated_audit_failure CHECK (false) NOT VALID');
        $result = $this->workerResult($this->changeStatus($admin, $target, false));
        $this->assertSame(503, $result['status']);
        $this->assertSame($before, $target->fresh()->getAttributes());
        $this->assertEquals($session, DB::table('sessions')->where('id', $id)->sole());
        $this->assertSame($count, UserStatusChange::count());
        DB::statement('ALTER TABLE user_status_changes DROP CONSTRAINT simulated_audit_failure');
    }

    private function migrationConstraintsAndDown(): void
    {
        $actor = User::factory()->create(['role' => 'admin']);
        $target = User::factory()->create();
        $valid = ['actor_id' => $actor->id, 'target_user_id' => $target->id, 'previous_disabled_at' => null, 'new_disabled_at' => now(), 'created_at' => now()];
        foreach ([['new_disabled_at' => null], ['previous_disabled_at' => now()], ['target_user_id' => $actor->id], ['actor_id' => 9999999]] as $override) {
            DB::beginTransaction();
            try {
                DB::table('user_status_changes')->insert(array_replace($valid, $override));
                $this->fail('Invalid audit accepted.');
            } catch (QueryException $e) {
                $this->assertContains($e->errorInfo[0], ['23514', '23503']);
            } finally {
                DB::rollBack();
            }
        }
        $event = UserStatusChange::create($valid);
        DB::beginTransaction();
        try {
            DB::table('users')->where('id', $target->id)->delete();
            $this->fail('Audited target deletion accepted.');
        } catch (QueryException $e) {
            $this->assertSame('23503', $e->errorInfo[0]);
        } finally {
            DB::rollBack();
        }
        $this->assertSame($actor->id, $event->actor->id);
        $this->assertSame($target->id, $event->targetUser->id);
        $this->assertTrue(Schema::hasIndex('user_status_changes', 'user_status_changes_actor_id_index'));
        $this->assertTrue(Schema::hasIndex('user_status_changes', 'user_status_changes_target_user_id_created_at_index'));
        $count = User::count();
        (require database_path('migrations/2026_10_29_020000_create_user_status_changes_table.php'))->down();
        $this->assertFalse(Schema::hasTable('user_status_changes'));
        $this->assertSame($count, User::count());
    }
}
