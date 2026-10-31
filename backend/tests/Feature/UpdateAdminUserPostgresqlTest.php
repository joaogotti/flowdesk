<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Database\Schema\Blueprint;
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
        // Disposable fixture only: no application migrations or development volumes.
        Schema::create('users', function (Blueprint $table): void {
            $table->id();
            $table->string('name');
            $table->string('email')->unique();
            $table->timestamp('email_verified_at')->nullable();
            $table->string('password');
            $table->rememberToken();
            $table->timestamps();
            $table->string('role', 20)->default('requester');
            $table->timestampTz('disabled_at')->nullable();
            $table->bigInteger('session_version')->default(0);
        });
        Schema::create('sessions', function (Blueprint $table): void {
            $table->string('id')->primary();
            $table->foreignId('user_id')->nullable()->index();
            $table->string('ip_address', 45)->nullable();
            $table->text('user_agent')->nullable();
            $table->longText('payload');
            $table->integer('last_activity')->index();
        });
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

            // Real competing kernels must not overwrite the same original name.
            foreach (['self_admin', 'self_self', 'admin_admin'] as $mode) {
                $before = $targetA->fresh()->getAttributes();
                $results = $this->concurrent($connection, [
                    ['actor_id' => $mode === 'admin_admin' ? $adminA->id : $targetA->id,
                        'target_id' => $targetA->id, 'self_profile' => $mode !== 'admin_admin',
                        'payload' => ['name' => $mode.' A', 'expected_name' => $before['name']]],
                    ['actor_id' => $mode === 'self_self' ? $targetA->id : $adminB->id,
                        'target_id' => $targetA->id, 'self_profile' => $mode === 'self_self',
                        'payload' => ['name' => $mode.' B', 'expected_name' => $before['name']]],
                ]);
                $this->assertSame([200, 409], $this->statuses($results));
                $fresh = $targetA->fresh()->getAttributes();
                $winner = $results[0]['status'] === 200 ? ' A' : ' B';
                $this->assertSame($mode.$winner, $fresh['name']);
                foreach ($before as $field => $value) {
                    if (! in_array($field, ['name', 'updated_at'], true)) {
                        $this->assertSame($value, $fresh[$field]);
                    }
                }
            }
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
                if (($request['method'] ?? 'PATCH') === 'PATCH') {
                    $target = User::findOrFail($request['target_id']);
                    foreach (['name', 'email'] as $field) {
                        if (array_key_exists($field, $request['payload']) && ! array_key_exists('expected_'.$field, $request['payload'])) {
                            $request['payload']['expected_'.$field] = $target->{$field};
                        }
                    }
                }
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
            foreach ($workers as $i => $worker) {
                $worker->wait();
                $this->assertSame(0, $worker->getExitCode(), $worker->getErrorOutput().$worker->getOutput());
                $result = json_decode(trim($worker->getOutput()), true, flags: JSON_THROW_ON_ERROR);
                if ($result['status'] === 422) {
                    $this->assertSame(['message' => 'Já existe um usuário com esse e-mail.', 'errors' => ['email' => ['Já existe um usuário com esse e-mail.']]], $result['body']);
                } elseif ($result['status'] === 409) {
                    $this->assertSame('profile_changed', $result['body']['code']);
                    $this->assertArrayNotHasKey('data', $result['body']);
                } elseif (in_array($result['status'], [200, 201], true)) {
                    $keys = ($requests[$i]['self_profile'] ?? false)
                        ? ['id', 'name', 'email', 'role'] : ['id', 'name', 'email', 'role', 'disabled_at', 'created_at'];
                    $this->assertSame($keys, array_keys($result['body']['data']));
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
