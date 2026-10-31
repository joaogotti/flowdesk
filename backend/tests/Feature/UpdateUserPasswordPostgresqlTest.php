<?php

namespace Tests\Feature;

use App\Models\User;
use App\Support\SessionVersion;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Symfony\Component\Process\Process;
use Tests\Support\PasswordFixtures;
use Tests\TestCase;

class UpdateUserPasswordPostgresqlTest extends TestCase
{
    use PasswordFixtures;

    private const CURRENT = 'Current!Password123';

    private const NEXT = 'Different!Password456';

    private array $connection;

    private array $workers = [];

    public function test_real_password_changes_sessions_and_late_requests_respect_the_cutover(): void
    {
        $host = getenv('FLOWDESK_PASSWORD_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requires disposable PostgreSQL via FLOWDESK_PASSWORD_PG_HOST.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-password-test-[a-f0-9]+$/', $host);
        $this->connection = ['driver' => 'pgsql', 'host' => $host, 'port' => 5432, 'database' => 'flowdesk_password_test',
            'username' => 'postgres', 'password' => '', 'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer'];
        config(['database.default' => 'password_pg', 'database.connections.password_pg' => $this->connection, 'logging.default' => 'null']);
        $this->createPasswordFixtures();
        try {
            $this->competingPasswordChanges();
            $this->passwordWinsAgainstOldProfileAndLogin();
            $this->lateLoginCannotRestoreAnOldSession();
            $this->revocationAndHashAreRecheckedAfterWaiting();
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

    private function user(): User
    {
        return User::factory()->create(['password' => self::CURRENT, 'session_version' => 4]);
    }

    private function cookie(User $user): string
    {
        $id = bin2hex(random_bytes(20));
        DB::table('sessions')->insert(['id' => $id, 'user_id' => $user->id, 'last_activity' => time(),
            'payload' => base64_encode(json_encode([Auth::guard('web')->getName() => $user->id,
                SessionVersion::KEY => $user->session_version], JSON_THROW_ON_ERROR))]);

        return $id;
    }

    private function payload(string $next = self::NEXT): array
    {
        return ['current_password' => self::CURRENT, 'password' => $next, 'password_confirmation' => $next];
    }

    private function worker(string $operation, array $input = []): array
    {
        $key = bin2hex(random_bytes(4));
        $process = new Process([PHP_BINARY, base_path('tests/Support/password-worker.php')], base_path(), input: json_encode([
            'connection' => $this->connection, 'key' => $key, 'operation' => $operation, ...$input,
        ], JSON_THROW_ON_ERROR), timeout: 90);
        $process->start();
        $worker = ['key' => $key, 'process' => $process];
        $this->workers[] = $worker;

        return $worker;
    }

    private function blocked(array $worker, string $marker): void
    {
        $deadline = microtime(true) + 75;
        do {
            $worker['process']->checkTimeout();
            if (! $worker['process']->isRunning() || $worker['process']->getErrorOutput() !== '') {
                $this->fail('Worker failed before lock barrier.');
            }
            DB::select('SELECT pg_stat_clear_snapshot()');
            $waiters = DB::selectOne("SELECT count(*) AS total FROM pg_stat_activity WHERE datname='flowdesk_password_test' AND application_name=? AND wait_event_type='Lock'", ['flowdesk_password_'.$worker['key']]);
            if ((int) $waiters->total === 1 && str_contains($worker['process']->getOutput(), $marker)) {
                $this->assertTrue(true);

                return;
            }
            usleep(20_000);
        } while (microtime(true) < $deadline);
        $this->fail('Expected PostgreSQL lock barrier was not observed.');
    }

    private function workerResult(array $worker): array
    {
        $worker['process']->wait();
        $this->assertSame(0, $worker['process']->getExitCode(), 'Worker did not complete.');
        $this->assertSame('', $worker['process']->getErrorOutput());
        $lines = explode("\n", trim($worker['process']->getOutput()));

        return json_decode(end($lines), true, flags: JSON_THROW_ON_ERROR);
    }

    private function competingPasswordChanges(): void
    {
        $user = $this->user();
        $other = $this->user();
        $cookies = [$this->cookie($user), $this->cookie($user)];
        $otherCookie = $this->cookie($other);
        $next = [self::NEXT, 'Concurrent!Password789'];
        DB::beginTransaction();
        User::whereKey($user->id)->lockForUpdate()->firstOrFail();
        $a = $this->worker('password', ['session_id' => $cookies[0], 'payload' => $this->payload($next[0])]);
        $this->blocked($a, 'validated');
        $b = $this->worker('password', ['session_id' => $cookies[1], 'payload' => $this->payload($next[1])]);
        $this->blocked($b, 'validated');
        DB::commit();
        $results = [$this->workerResult($a), $this->workerResult($b)];
        $statuses = array_column($results, 'status');
        sort($statuses);
        $this->assertSame([200, 401], $statuses);
        foreach ($results as $i => $result) {
            if ($result['status'] === 200) {
                $this->assertTrue(Hash::check($next[$i], $user->fresh()->password));
                $this->assertSame('password_changed', $result['body']['code']);
                $this->assertNull($result['version']);
                $this->assertNotSame($cookies[$i], $result['session_id']);
                $this->assertSame(401, $this->workerResult($this->worker('probe', ['session_id' => $result['session_id']]))['status']);
            } else {
                $this->assertSame('session_revoked', $result['body']['code']);
            }
        }
        $this->assertSame(5, $user->fresh()->session_version);
        // A rejected late request may save an anonymous row; it must never save authentication.
        foreach (DB::table('sessions')->where('user_id', $user->id)->get() as $session) {
            $payload = json_decode(base64_decode($session->payload), true, flags: JSON_THROW_ON_ERROR);
            $this->assertArrayNotHasKey(Auth::guard('web')->getName(), $payload);
            $this->assertArrayNotHasKey(SessionVersion::KEY, $payload);
        }
        foreach ($cookies as $id) {
            $this->assertSame(401, $this->workerResult($this->worker('probe', ['session_id' => $id]))['status']);
        }
        $this->assertSame(200, $this->workerResult($this->worker('probe', ['session_id' => $otherCookie]))['status']);
    }

    private function passwordWinsAgainstOldProfileAndLogin(): void
    {
        $user = $this->user();
        $name = $user->name;
        $cookies = [$this->cookie($user), $this->cookie($user)];
        DB::select('SELECT pg_advisory_lock(706405, 1)');
        $password = $this->worker('password', ['session_id' => $cookies[0], 'payload' => $this->payload(), 'hold_password' => true]);
        $this->blocked($password, 'password_written');
        $profile = $this->worker('profile', ['session_id' => $cookies[1], 'payload' => ['name' => 'Must not save', 'expected_name' => $name]]);
        $this->blocked($profile, 'validated');
        $login = $this->worker('login', ['payload' => ['email' => $user->email, 'password' => self::CURRENT]]);
        $this->blocked($login, 'candidate_read');
        DB::select('SELECT pg_advisory_unlock(706405, 1)');
        $this->assertSame(200, $this->workerResult($password)['status']);
        $result = $this->workerResult($profile);
        $this->assertSame(401, $result['status']);
        $this->assertSame('session_revoked', $result['body']['code']);
        $this->assertSame(401, $this->workerResult($login)['status']);
        $this->assertSame($name, $user->fresh()->name);
        $freshLogin = $this->workerResult($this->worker('login', ['payload' => ['email' => $user->email, 'password' => self::NEXT]]));
        $this->assertSame(200, $freshLogin['status']);
        $this->assertSame(5, $freshLogin['version']);
        $this->assertSame(200, $this->workerResult($this->worker('probe', ['session_id' => $freshLogin['session_id']]))['status']);
    }

    private function lateLoginCannotRestoreAnOldSession(): void
    {
        $user = $this->user();
        $cookie = $this->cookie($user);
        DB::select('SELECT pg_advisory_lock(706405, 1)');
        $login = $this->worker('login', ['payload' => ['email' => $user->email, 'password' => self::CURRENT], 'late_login_save' => true]);
        $this->blocked($login, 'login_committed');
        $this->assertSame(200, $this->workerResult($this->worker('password', ['session_id' => $cookie, 'payload' => $this->payload()]))['status']);
        DB::select('SELECT pg_advisory_unlock(706405, 1)');
        $late = $this->workerResult($login);
        $this->assertSame(200, $late['status']);
        $this->assertSame(4, $late['version']);
        $this->assertSame(5, $user->fresh()->session_version);
        $this->assertSame(1, DB::table('sessions')->where('id', $late['session_id'])->where('user_id', $user->id)->count());
        $this->assertSame(401, $this->workerResult($this->worker('probe', ['session_id' => $late['session_id']]))['status']);
    }

    private function revocationAndHashAreRecheckedAfterWaiting(): void
    {
        foreach (['version', 'hash'] as $mode) {
            $user = $this->user();
            $id = $this->cookie($user);
            DB::beginTransaction();
            User::whereKey($user->id)->lockForUpdate()->firstOrFail();
            $password = $this->worker('password', ['session_id' => $id, 'payload' => $this->payload()]);
            $this->blocked($password, 'validated');
            if ($mode === 'version') {
                DB::table('users')->where('id', $user->id)->update(['session_version' => 5]);
                DB::table('sessions')->where('user_id', $user->id)->delete();
            } else {
                DB::table('users')->where('id', $user->id)->update(['password' => Hash::make('Concurrent!Current456')]);
            }
            $before = $user->fresh()->getAttributes();
            DB::commit();
            $result = $this->workerResult($password);
            $this->assertSame($mode === 'version' ? 401 : 422, $result['status']);
            if ($mode === 'version') {
                $this->assertSame('session_revoked', $result['body']['code']);
            } else {
                $this->assertArrayHasKey('current_password', $result['body']['errors']);
            }
            $this->assertSame($before, $user->fresh()->getAttributes());
        }
    }
}
