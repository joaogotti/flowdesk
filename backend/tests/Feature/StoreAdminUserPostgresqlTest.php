<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Schema;
use Symfony\Component\Process\Process;
use Tests\TestCase;

class StoreAdminUserPostgresqlTest extends TestCase
{
    public function test_existing_postgresql_index_protects_concurrent_normalized_creations(): void
    {
        $host = getenv('FLOWDESK_USER_CREATION_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requer PostgreSQL descartável via FLOWDESK_USER_CREATION_PG_HOST.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-user-create-test-[a-f0-9]+$/', $host);
        $connection = [
            'driver' => 'pgsql', 'host' => $host, 'port' => 5432,
            'database' => 'flowdesk_user_creation_test', 'username' => 'postgres', 'password' => '',
            'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer',
        ];
        config(['database.default' => 'user_creation_pg', 'database.connections.user_creation_pg' => $connection]);
        $this->assertSame('flowdesk_user_creation_test', DB::connection()->getDatabaseName());
        $this->assertFalse(Schema::hasTable('users'));
        (require database_path('migrations/0001_01_01_000000_create_users_table.php'))->up();
        (require database_path('migrations/2026_10_09_020940_add_role_and_disabled_at_to_users_table.php'))->up();
        (require database_path('migrations/2026_10_28_230000_add_session_version_to_users_table.php'))->up();
        $admin = User::factory()->create(['role' => 'admin']);

        try {
            $index = DB::selectOne("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='users_email_unique'");
            $this->assertStringContainsString('UNIQUE INDEX users_email_unique', $index->indexdef);
            $this->assertStringContainsString('(email)', $index->indexdef);
            $this->assertTrue(DB::selectOne("SELECT 'Case@Example.com' <> 'case@example.com' AS different")->different);
            foreach ([['same@example.com', 'same@example.com'], ['Mixed@Example.com', ' mixed@EXAMPLE.COM ']] as $emails) {
                $this->assertConcurrentCreation($connection, $admin, $emails);
            }

            $this->actingAs($admin, 'web');
            User::factory()->create(['email' => 'LEGACY@EXAMPLE.COM', 'disabled_at' => now()]);
            $this->postJson('/api/admin/users', [
                'name' => 'Duplicado', 'email' => 'legacy@example.com', 'password' => 'Senha!Segura123',
                'password_confirmation' => 'Senha!Segura123', 'role' => 'requester',
            ])->assertUnprocessable()->assertJsonValidationErrors('email');
            $this->assertDatabaseCount('users', 4);
            $this->assertDatabaseCount('sessions', 0);
        } finally {
            DB::disconnect();
        }
    }

    private function assertConcurrentCreation(array $connection, User $admin, array $emails): void
    {
        $count = User::count();
        $workers = [];
        try {
            DB::beginTransaction();
            // As duas validações passam; os INSERTs aguardam liberação do mesmo lock.
            DB::statement('LOCK TABLE users IN SHARE MODE');
            foreach ($emails as $email) {
                $worker = new Process([PHP_BINARY, base_path('tests/Support/user-creation-worker.php')], base_path(), input: json_encode([
                    'connection' => $connection, 'user_id' => $admin->id, 'email' => $email,
                ], JSON_THROW_ON_ERROR), timeout: 90);
                $worker->start();
                $workers[] = $worker;
            }
            $deadline = microtime(true) + 75;
            do {
                foreach ($workers as $worker) {
                    $worker->checkTimeout();
                    if ($worker->getErrorOutput() !== '' || ! $worker->isRunning()) {
                        $this->fail($worker->getErrorOutput().$worker->getOutput());
                    }
                }
                DB::select('SELECT pg_stat_clear_snapshot()');
                $waiters = DB::selectOne("SELECT COUNT(*) AS total FROM pg_stat_activity WHERE datname='flowdesk_user_creation_test' AND application_name='flowdesk_user_creation_worker' AND wait_event_type='Lock' AND query LIKE 'insert into %users%'");
                if ((int) $waiters->total === 2) {
                    break;
                }
                usleep(20_000);
            } while (microtime(true) < $deadline);
            $this->assertSame(2, (int) $waiters->total, 'Ambos os kernels devem atingir INSERT antes da liberação.');
            DB::commit();
            $results = [];
            foreach ($workers as $worker) {
                $worker->wait();
                $this->assertSame(0, $worker->getExitCode(), $worker->getErrorOutput().$worker->getOutput());
                $results[] = json_decode(trim($worker->getOutput()), true, flags: JSON_THROW_ON_ERROR);
            }
            $statuses = array_column($results, 'status');
            sort($statuses);
            $this->assertSame([201, 422], $statuses);
            $this->assertSame($count + 1, User::count());
            $user = User::where('email', strtolower(trim($emails[0])))->sole();
            $this->assertTrue(Hash::check('Senha!Segura123', $user->password));
            $this->assertNull($user->disabled_at);
            foreach ($results as $result) {
                if ($result['status'] === 422) {
                    $this->assertSame(['message' => 'Já existe um usuário com esse e-mail.', 'errors' => ['email' => ['Já existe um usuário com esse e-mail.']]], $result['body']);
                } else {
                    $this->assertSame(['id', 'name', 'email', 'role', 'disabled_at', 'created_at'], array_keys($result['body']['data']));
                }
            }
        } finally {
            if (DB::transactionLevel() > 0) {
                DB::rollBack();
            }
            foreach ($workers as $worker) {
                if ($worker->isRunning()) {
                    $worker->stop(0.2);
                }
            }
        }
    }
}
