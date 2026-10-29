<?php

namespace Tests\Feature;

use App\Models\Category;
use App\Models\User;
use Database\Seeders\CategorySeeder;
use Database\Seeders\SlaPolicySeeder;
use Database\Seeders\TicketStatusSeeder;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Symfony\Component\Process\Process;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class StoreCategoryPostgresqlTest extends TestCase
{
    use AssignmentFixtures;

    private const MIGRATION = 'database/migrations/2026_10_26_220000_add_normalized_category_name_unique_index.php';

    public function test_real_creation_csrf_unicode_uniqueness_concurrency_and_migration_reversal(): void
    {
        $host = getenv('FLOWDESK_CATEGORY_CREATION_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requer PostgreSQL descartável via FLOWDESK_CATEGORY_CREATION_PG_HOST.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-category-create-test-[a-f0-9]+$/', $host);
        $connection = [
            'driver' => 'pgsql', 'host' => $host, 'port' => 5432,
            'database' => 'flowdesk_category_create_test', 'username' => 'postgres', 'password' => '',
            'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer',
        ];
        config(['database.default' => 'category_creation_pg', 'database.connections.category_creation_pg' => $connection]);
        $this->assertSame('flowdesk_category_create_test', DB::connection()->getDatabaseName());
        $this->assertFalse(Schema::hasTable('users'));
        $this->artisan('migrate', ['--database' => 'category_creation_pg', '--force' => true])->assertSuccessful();
        $this->seed([CategorySeeder::class, TicketStatusSeeder::class, SlaPolicySeeder::class]);
        $this->requester = User::factory()->create(['role' => 'requester']);
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket();
        $ticketBefore = $ticket->fresh()->getAttributes();
        $originalCategories = Category::orderBy('id')->get()->toJson();
        $originalIds = Category::pluck('id')->all();
        config(['sanctum.stateful' => ['localhost:5173']]);
        $this->withHeader('Origin', 'http://localhost:5173');

        try {
            $index = DB::selectOne("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='categories_name_normalized_unique'");
            $this->assertNotNull($index);
            $this->assertStringContainsString('lower(btrim(', $index->indexdef);
            $this->postJson('/api/login', ['email' => $admin->email, 'password' => 'password'])->assertOk();
            $sessionId = session()->getId();
            $token = session()->token();
            $this->app->instance('env', 'local');
            Auth::forgetGuards();
            $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
                ->postJson('/api/admin/categories', ['name' => 'Periféricos'])->assertStatus(419);
            $this->withHeader('X-CSRF-TOKEN', $token);
            Auth::forgetGuards();
            $response = $this->postJson('/api/admin/categories', ['name' => " \tPeriféricos\n"])->assertCreated();
            $id = $response->json('data.id');
            $response->assertExactJson(['data' => ['id' => $id, 'name' => 'Periféricos', 'is_active' => true, 'tickets_count' => 0]]);
            $before = $this->snapshot();
            foreach (['Periféricos', 'PERIFÉRICOS', ' periféricos '] as $duplicate) {
                $this->postJson('/api/admin/categories', ['name' => $duplicate])->assertUnprocessable()->assertExactJson([
                    'message' => 'Já existe uma categoria com esse nome.', 'errors' => ['name' => ['Já existe uma categoria com esse nome.']],
                ]);
                $this->assertSame($before, $this->snapshot());
            }
            $this->postJson('/api/admin/categories', ['name' => str_repeat('é', 100)])->assertCreated();
            $this->postJson('/api/admin/categories', ['name' => str_repeat('é', 101)])->assertUnprocessable();
            $this->postJson('/api/admin/categories', ['name' => 'Inválida', 'is_active' => false])->assertUnprocessable();
            $this->app->instance('env', 'testing');
            $this->flushHeaders()->withHeader('Origin', 'http://localhost:5173');

            foreach ([['Concorrência exata', 'Concorrência exata'], ['Periféricos concorrentes', 'PERIFÉRICOS CONCORRENTES'], ['  Espaços concorrentes  ', 'Espaços concorrentes']] as $names) {
                $this->assertConcurrentCreation($connection, $admin, $names);
            }

            $before = $this->snapshot();
            // Select this migration from the batch, even when newer migrations exist.
            $this->artisan('migrate:rollback', ['--database' => 'category_creation_pg', '--path' => [self::MIGRATION], '--force' => true])->assertSuccessful();
            $this->assertFalse(Schema::hasIndex('categories', 'categories_name_normalized_unique'));
            $this->assertTrue(Schema::hasIndex('categories', 'categories_name_unique'));
            $this->assertSame($before, $this->snapshot());

            // Uma duplicidade legada impede o índice sem reescrever ou apagar registros.
            DB::beginTransaction();
            try {
                Category::create(['name' => 'hardware']);
                (require base_path(self::MIGRATION))->up();
                $this->fail('O índice deve rejeitar duplicidade legada.');
            } catch (UniqueConstraintViolationException) {
                // O erro deixa a transação PostgreSQL abortada; o rollback abaixo a recupera.
            } finally {
                DB::rollBack();
            }
            $this->assertSame($before, $this->snapshot());
            $this->artisan('migrate', ['--database' => 'category_creation_pg', '--path' => [self::MIGRATION], '--force' => true])->assertSuccessful();
            $this->assertTrue(Schema::hasIndex('categories', 'categories_name_normalized_unique'));
            $this->assertSame($before, $this->snapshot());
            $this->assertSame($ticketBefore, $ticket->fresh()->getAttributes());
            $this->assertSame($originalCategories, Category::whereIn('id', $originalIds)->orderBy('id')->get()->toJson());
        } finally {
            if (DB::transactionLevel() > 0) {
                DB::rollBack();
            }
            DB::disconnect();
        }
    }

    private function assertConcurrentCreation(array $connection, User $admin, array $names): void
    {
        $countBefore = Category::count();
        $workers = [];
        try {
            DB::beginTransaction();
            // Ambos os kernels atingem INSERT antes de liberar a disputa pelo índice.
            DB::statement('LOCK TABLE categories IN SHARE MODE');
            foreach ($names as $name) {
                $process = new Process([PHP_BINARY, base_path('tests/Support/category-creation-worker.php')], base_path(), input: json_encode([
                    'connection' => $connection, 'user_id' => $admin->id, 'name' => $name,
                ], JSON_THROW_ON_ERROR), timeout: 90);
                $process->start();
                $workers[] = $process;
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
                $waiters = DB::selectOne("SELECT COUNT(*) AS total FROM pg_stat_activity WHERE datname='flowdesk_category_create_test' AND application_name='flowdesk_category_creation_worker' AND wait_event_type='Lock' AND query LIKE 'insert into %categories%'");
                if ((int) $waiters->total === count($workers)) {
                    break;
                }
                usleep(20_000);
            } while (microtime(true) < $deadline);
            $this->assertSame(2, (int) $waiters->total, 'Os dois kernels devem disputar INSERT simultaneamente.');
            DB::commit();
            $results = [];
            foreach ($workers as $worker) {
                $worker->wait();
                $this->assertSame(0, $worker->getExitCode(), $worker->getErrorOutput().$worker->getOutput());
                $lines = explode("\n", trim($worker->getOutput()));
                $results[] = json_decode(end($lines), true, flags: JSON_THROW_ON_ERROR);
            }
            $statuses = array_column($results, 'status');
            sort($statuses);
            $this->assertSame([201, 422], $statuses);
            $this->assertSame($countBefore + 1, Category::count());
            $this->assertSame(1, Category::whereRaw('LOWER(BTRIM(name)) = LOWER(?)', [trim($names[0])])->count());
            foreach ($results as $result) {
                if ($result['status'] === 422) {
                    $this->assertSame(['message' => 'Já existe uma categoria com esse nome.', 'errors' => ['name' => ['Já existe uma categoria com esse nome.']]], $result['body']);
                } else {
                    $this->assertTrue($result['body']['data']['is_active']);
                    $this->assertSame(0, $result['body']['data']['tickets_count']);
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
