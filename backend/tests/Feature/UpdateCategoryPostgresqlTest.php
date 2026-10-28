<?php

namespace Tests\Feature;

use App\Models\Category;
use App\Models\TicketStatus;
use App\Models\User;
use Database\Seeders\CategorySeeder;
use Database\Seeders\SlaPolicySeeder;
use Database\Seeders\TicketStatusSeeder;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Symfony\Component\Process\Process;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class UpdateCategoryPostgresqlTest extends TestCase
{
    use AssignmentFixtures;

    public function test_session_csrf_unicode_identity_preservation_and_concurrent_name_conflicts(): void
    {
        $host = getenv('FLOWDESK_CATEGORY_UPDATE_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requer PostgreSQL descartável via FLOWDESK_CATEGORY_UPDATE_PG_HOST.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-category-update-test-[a-f0-9]+$/', $host);
        $connection = [
            'driver' => 'pgsql', 'host' => $host, 'port' => 5432,
            'database' => 'flowdesk_category_update_test', 'username' => 'postgres', 'password' => '',
            'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer',
        ];
        config(['database.default' => 'category_update_pg', 'database.connections.category_update_pg' => $connection]);
        $this->assertSame('flowdesk_category_update_test', DB::connection()->getDatabaseName());
        $this->assertFalse(Schema::hasTable('users'));
        $this->artisan('migrate', ['--database' => 'category_update_pg', '--force' => true])->assertSuccessful();
        $this->seed([CategorySeeder::class, TicketStatusSeeder::class, SlaPolicySeeder::class]);
        $this->requester = User::factory()->create(['role' => 'requester']);
        $admin = User::factory()->create(['role' => 'admin']);
        $this->travelTo(now()->startOfSecond());
        $category = Category::create(['name' => 'Equipamentos', 'is_active' => false, 'description' => 'Preservar.']);
        foreach (TicketStatus::all() as $status) {
            $ticket = $this->ticket(['category_id' => $category->id, 'status_id' => $status->id]);
            $ticket->comments()->create(['user_id' => $this->requester->id, 'body' => 'Preservar conversa.', 'is_internal' => true]);
            DB::table('ticket_activities')->insert(['ticket_id' => $ticket->id, 'actor_id' => $admin->id, 'action' => 'ticket_created', 'created_at' => now()]);
        }
        $this->ticket();
        config(['sanctum.stateful' => ['localhost:5173']]);
        $this->withHeader('Origin', 'http://localhost:5173');
        $endpoint = '/api/admin/categories/'.$category->id;

        try {
            $this->postJson('/api/login', ['email' => $admin->email, 'password' => 'password'])->assertOk();
            $sessionId = session()->getId();
            $token = session()->token();
            $this->app->instance('env', 'local');
            Auth::forgetGuards();
            $before = $this->snapshot();
            $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)->patchJson($endpoint, ['name' => 'Periféricos'])->assertStatus(419);
            $this->withHeader('X-CSRF-TOKEN', 'invalid')->patchJson($endpoint, ['name' => 'Periféricos'])->assertStatus(419);
            $this->assertSame($before, $this->snapshot());
            $this->withHeader('X-CSRF-TOKEN', $token);
            Auth::forgetGuards();
            $this->patchJson($endpoint, ['name' => " \tPeriféricos\n"])->assertOk()->assertExactJson(['data' => [
                'id' => $category->id, 'name' => 'Periféricos', 'is_active' => false, 'tickets_count' => 6,
            ]]);
            $after = $this->snapshot();
            unset($before['categories'], $after['categories']);
            $this->assertSame($before, $after);
            $this->patchJson($endpoint, ['name' => 'PERIFÉRICOS'])->assertOk()->assertJsonPath('data.name', 'PERIFÉRICOS');
            $before = $this->snapshot();
            $this->travel(5)->minutes();
            $this->patchJson($endpoint, ['name' => '  PERIFÉRICOS  '])->assertOk();
            $this->assertSame($before, $this->snapshot());
            $this->patchJson($endpoint, ['name' => str_repeat('é', 100)])->assertOk();
            $this->patchJson($endpoint, ['name' => str_repeat('é', 101)])->assertUnprocessable();
            Category::create(['name' => '  Reservada  ', 'is_active' => false]);
            $before = $this->snapshot();
            foreach (['Reservada', 'RESERVADA', '  reservada  '] as $duplicate) {
                $this->patchJson($endpoint, ['name' => $duplicate])->assertUnprocessable()->assertExactJson([
                    'message' => 'Já existe uma categoria com esse nome.', 'errors' => ['name' => ['Já existe uma categoria com esse nome.']],
                ]);
                $this->assertSame($before, $this->snapshot());
            }
            $this->patchJson('/api/admin/categories/999999', ['name' => 'Ausente'])->assertNotFound();
            $this->app->instance('env', 'testing');
            $this->flushHeaders()->withHeader('Origin', 'http://localhost:5173');

            foreach ([['Concorrência exata', 'Concorrência exata'], ['Periféricos concorrentes', 'PERIFÉRICOS CONCORRENTES'], ['  Espaços concorrentes  ', 'Espaços concorrentes']] as $index => $names) {
                $left = Category::create(['name' => 'Origem A '.$index]);
                $right = Category::create(['name' => 'Origem B '.$index, 'is_active' => false]);
                $this->ticket(['category_id' => $left->id]);
                $this->ticket(['category_id' => $right->id]);
                $this->assertConcurrentUpdates($connection, $admin, [$left, $right], $names, [200, 422]);
            }
            $single = Category::create(['name' => 'Mesmo registro']);
            $this->ticket(['category_id' => $single->id]);
            $this->assertConcurrentUpdates($connection, $admin, [$single, $single], ['Nome repetido', 'Nome repetido'], [200, 200]);
        } finally {
            if (DB::transactionLevel() > 0) {
                DB::rollBack();
            }
            DB::disconnect();
        }
    }

    private function assertConcurrentUpdates(array $connection, User $admin, array $categories, array $names, array $expectedStatuses): void
    {
        $before = $this->snapshot();
        $originals = [];
        foreach ($categories as $category) {
            $originals[$category->id] = $category->fresh()->getAttributes();
        }
        $sequence = (array) DB::selectOne('SELECT last_value,is_called FROM categories_id_seq');
        $this->travel(1)->minutes();
        $workers = [];
        try {
            DB::beginTransaction();
            DB::statement('LOCK TABLE categories IN SHARE MODE');
            foreach ($categories as $index => $category) {
                $worker = new Process([PHP_BINARY, base_path('tests/Support/category-update-worker.php')], base_path(), input: json_encode([
                    'connection' => $connection, 'user_id' => $admin->id, 'category_id' => $category->id,
                    'name' => $names[$index], 'now' => now()->toISOString(),
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
                $waiting = DB::selectOne("SELECT COUNT(*) AS total FROM pg_stat_activity WHERE datname='flowdesk_category_update_test' AND application_name='flowdesk_category_update_worker' AND wait_event_type='Lock' AND query LIKE '%categories%'");
                if ((int) $waiting->total === 2) {
                    break;
                }
                usleep(20_000);
            } while (microtime(true) < $deadline);
            $this->assertSame(2, (int) $waiting->total, 'Ambos os kernels devem estar bloqueados antes da disputa.');
            DB::commit();
            $results = [];
            foreach ($workers as $worker) {
                $worker->wait();
                $this->assertSame(0, $worker->getExitCode(), $worker->getErrorOutput().$worker->getOutput());
                $results[] = json_decode(trim($worker->getOutput()), true, flags: JSON_THROW_ON_ERROR);
            }
            $statuses = array_column($results, 'status');
            sort($statuses);
            $this->assertSame($expectedStatuses, $statuses);
            foreach ($results as $index => $result) {
                $fresh = $categories[$index]->fresh();
                if ($result['status'] === 422) {
                    $this->assertSame(['message' => 'Já existe uma categoria com esse nome.', 'errors' => ['name' => ['Já existe uma categoria com esse nome.']]], $result['body']);
                    $this->assertSame($originals[$fresh->id], $fresh->getAttributes());
                } else {
                    $this->assertSame(['data' => ['id' => $fresh->id, 'name' => $fresh->name, 'is_active' => $fresh->is_active, 'tickets_count' => 1]], $result['body']);
                    foreach ($originals[$fresh->id] as $field => $value) {
                        if (! in_array($field, ['name', 'updated_at'], true)) {
                            $this->assertSame($value, $fresh->getAttributes()[$field]);
                        }
                    }
                }
            }
            $this->assertSame(1, Category::whereRaw('LOWER(BTRIM(name)) = LOWER(?)', [trim($names[0])])->count());
            $after = $this->snapshot();
            $this->assertSame(count(json_decode($before['categories'], true)), Category::count());
            unset($before['categories'], $after['categories']);
            $this->assertSame($before, $after);
            $this->assertSame($sequence, (array) DB::selectOne('SELECT last_value,is_called FROM categories_id_seq'));
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
