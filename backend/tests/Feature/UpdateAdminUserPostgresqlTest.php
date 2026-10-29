<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Symfony\Component\Process\Process;
use Tests\TestCase;

class UpdateAdminUserPostgresqlTest extends TestCase
{
    public function test_concurrent_edits_partial_updates_cross_admin_edits_and_creation_conflicts(): void
    {
        $host = getenv('FLOWDESK_USER_EDIT_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requer PostgreSQL descartável via FLOWDESK_USER_EDIT_PG_HOST.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-user-edit-test-[a-f0-9]+$/', $host);
        $connection = [
            'driver' => 'pgsql', 'host' => $host, 'port' => 5432,
            'database' => 'flowdesk_user_edit_test', 'username' => 'postgres', 'password' => '',
            'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer',
        ];
        config(['database.default' => 'user_edit_pg', 'database.connections.user_edit_pg' => $connection]);
        $this->assertSame('flowdesk_user_edit_test', DB::connection()->getDatabaseName());
        $this->assertFalse(Schema::hasTable('users'));
        (require database_path('migrations/0001_01_01_000000_create_users_table.php'))->up();
        (require database_path('migrations/2026_10_09_020940_add_role_and_disabled_at_to_users_table.php'))->up();
        (require database_path('migrations/2026_10_28_230000_add_session_version_to_users_table.php'))->up();
        $adminA = User::factory()->create(['role' => 'admin']);
        $adminB = User::factory()->create(['role' => 'admin']);
        $targetA = User::factory()->create(['role' => 'requester']);
        $targetB = User::factory()->create(['role' => 'technician', 'disabled_at' => now()]);
        $originals = [$targetA->id => $targetA->fresh()->getAttributes(), $targetB->id => $targetB->fresh()->getAttributes()];

        try {
            $index = DB::selectOne("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='users_email_unique'");
            $this->assertStringContainsString('(email)', $index->indexdef);
            foreach ([['same@example.com', 'same@example.com'], ['Mixed@Example.COM', ' mixed@EXAMPLE.com ']] as $emails) {
                $before = [$targetA->id => $targetA->fresh()->getAttributes(), $targetB->id => $targetB->fresh()->getAttributes()];
                $results = $this->concurrent($connection, [
                    ['actor_id' => $adminA->id, 'target_id' => $targetA->id, 'payload' => ['name' => 'Concorrente A', 'email' => $emails[0]]],
                    ['actor_id' => $adminB->id, 'target_id' => $targetB->id, 'payload' => ['name' => 'Concorrente B', 'email' => $emails[1]]],
                ]);
                $this->assertSame([200, 422], $this->statuses($results));
                $this->assertSame(1, User::where('email', strtolower(trim($emails[0])))->count());
                foreach ($results as $i => $result) {
                    $id = [$targetA->id, $targetB->id][$i];
                    if ($result['status'] === 422) {
                        $this->assertSame($before[$id], User::findOrFail($id)->getAttributes());
                    }
                }
                $this->assertDatabaseCount('users', 4);
            }

            // O segundo editor deve ler a versão já atualizada sob o lock e aplicar só seu campo.
            $results = $this->concurrent($connection, [
                ['actor_id' => $adminA->id, 'target_id' => $targetA->id, 'payload' => ['name' => 'Nome Composto']],
                ['actor_id' => $adminB->id, 'target_id' => $targetA->id, 'payload' => ['email' => ' Parcial@Example.COM ']],
            ]);
            $this->assertSame([200, 200], $this->statuses($results));
            $this->assertSame('Nome Composto', $targetA->fresh()->name);
            $this->assertSame('parcial@example.com', $targetA->fresh()->email);

            // A ordem dos locks deve evitar inversão quando os dois administradores se editam.
            $results = $this->concurrent($connection, [
                ['actor_id' => $adminA->id, 'target_id' => $adminB->id, 'payload' => ['name' => 'Administrador B Atualizado']],
                ['actor_id' => $adminB->id, 'target_id' => $adminA->id, 'payload' => ['name' => 'Administrador A Atualizado']],
            ]);
            $this->assertSame([200, 200], $this->statuses($results));
            $this->assertSame('Administrador A Atualizado', $adminA->fresh()->name);
            $this->assertSame('Administrador B Atualizado', $adminB->fresh()->name);
            $this->assertSame('admin', $adminA->fresh()->role);
            $this->assertSame('admin', $adminB->fresh()->role);

            $before = $targetA->fresh()->getAttributes();
            $results = $this->concurrent($connection, [
                ['actor_id' => $adminA->id, 'target_id' => $targetA->id, 'payload' => ['name' => 'Edição Disputada', 'email' => 'shared@example.com']],
                ['actor_id' => $adminB->id, 'method' => 'POST', 'payload' => [
                    'name' => 'Cadastro Disputado', 'email' => ' SHARED@Example.COM ', 'role' => 'requester',
                    'password' => 'Senha!Segura123', 'password_confirmation' => 'Senha!Segura123',
                ]],
            ]);
            $this->assertContains($this->statuses($results), [[200, 422], [201, 422]]);
            $this->assertSame(1, User::where('email', 'shared@example.com')->count());
            if ($results[0]['status'] === 422) {
                $this->assertSame($before, $targetA->fresh()->getAttributes());
            }
            foreach ([$targetA, $targetB] as $target) {
                foreach ($originals[$target->id] as $field => $value) {
                    if (! in_array($field, ['name', 'email', 'updated_at'], true)) {
                        $this->assertSame($value, $target->fresh()->getAttributes()[$field]);
                    }
                }
            }
            $this->assertDatabaseCount('sessions', 0);
        } finally {
            DB::disconnect();
        }
    }

    private function statuses(array $results): array
    {
        $statuses = array_column($results, 'status');
        sort($statuses);

        return $statuses;
    }

    private function concurrent(array $connection, array $requests): array
    {
        $workers = [];
        try {
            DB::beginTransaction();
            DB::statement('LOCK TABLE users IN SHARE MODE');
            foreach ($requests as $request) {
                $worker = new Process([PHP_BINARY, base_path('tests/Support/user-edit-worker.php')], base_path(), input: json_encode([
                    ...$request, 'connection' => $connection,
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
                $waiters = DB::selectOne("SELECT COUNT(*) AS total FROM pg_stat_activity WHERE datname='flowdesk_user_edit_test' AND application_name='flowdesk_user_edit_worker' AND wait_event_type='Lock'");
                if ((int) $waiters->total === 2) {
                    break;
                }
                usleep(20_000);
            } while (microtime(true) < $deadline);
            $this->assertSame(2, (int) $waiters->total, 'Dois kernels devem estar bloqueados antes da liberação.');
            DB::commit();
            $results = [];
            foreach ($workers as $worker) {
                $worker->wait();
                $this->assertSame(0, $worker->getExitCode(), $worker->getErrorOutput().$worker->getOutput());
                $result = json_decode(trim($worker->getOutput()), true, flags: JSON_THROW_ON_ERROR);
                if ($result['status'] === 422) {
                    $this->assertSame(['message' => 'Já existe um usuário com esse e-mail.', 'errors' => ['email' => ['Já existe um usuário com esse e-mail.']]], $result['body']);
                } elseif (in_array($result['status'], [200, 201], true)) {
                    $this->assertSame(['id', 'name', 'email', 'role', 'disabled_at', 'created_at'], array_keys($result['body']['data']));
                }
                $results[] = $result;
            }

            return $results;
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
