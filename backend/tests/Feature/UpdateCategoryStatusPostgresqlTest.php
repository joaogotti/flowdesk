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
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class UpdateCategoryStatusPostgresqlTest extends TestCase
{
    use AssignmentFixtures;

    public function test_status_changes_with_session_csrf_preservation_and_ticket_category_availability(): void
    {
        $host = getenv('FLOWDESK_CATEGORY_STATUS_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requer PostgreSQL descartável via FLOWDESK_CATEGORY_STATUS_PG_HOST.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-category-status-test-[a-f0-9]+$/', $host);
        config([
            'database.default' => 'category_status_pg',
            'database.connections.category_status_pg' => [
                'driver' => 'pgsql', 'host' => $host, 'port' => 5432,
                'database' => 'flowdesk_category_status_test', 'username' => 'postgres', 'password' => '',
                'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer',
            ],
        ]);
        $this->assertSame('flowdesk_category_status_test', DB::connection()->getDatabaseName());
        $this->assertFalse(Schema::hasTable('users'));
        $this->artisan('migrate', ['--database' => 'category_status_pg', '--force' => true])->assertSuccessful();
        $this->seed([CategorySeeder::class, TicketStatusSeeder::class, SlaPolicySeeder::class]);
        $this->requester = User::factory()->create(['role' => 'requester']);
        $admin = User::factory()->create(['role' => 'admin']);
        $this->travelTo(now()->startOfSecond());
        $category = Category::create(['name' => 'Equipamentos', 'description' => 'Preservar.']);
        $old = null;
        foreach (TicketStatus::all() as $status) {
            $ticket = $this->ticket(['category_id' => $category->id, 'status_id' => $status->id]);
            $ticket->comments()->create(['user_id' => $this->requester->id, 'body' => 'Preservar conversa.', 'is_internal' => true]);
            DB::table('ticket_activities')->insert(['ticket_id' => $ticket->id, 'actor_id' => $admin->id, 'action' => 'ticket_created', 'created_at' => now()]);
            if ($status->code === 'open') {
                $old = $ticket;
            }
        }
        config(['sanctum.stateful' => ['localhost:5173']]);
        $this->withHeader('Origin', 'http://localhost:5173');
        $endpoint = '/api/admin/categories/'.$category->id.'/status';
        try {
            $this->postJson('/api/login', ['email' => $admin->email, 'password' => 'password'])->assertOk();
            $sessionId = session()->getId();
            $token = session()->token();
            $this->app->instance('env', 'local');
            Auth::forgetGuards();
            $before = $this->snapshot();
            $sequence = (array) DB::selectOne('SELECT last_value,is_called FROM categories_id_seq');
            $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)->patchJson($endpoint, ['is_active' => false])->assertStatus(419);
            $this->withHeader('X-CSRF-TOKEN', 'invalid')->patchJson($endpoint, ['is_active' => false])->assertStatus(419);
            $this->assertSame($before, $this->snapshot());
            $this->withHeader('X-CSRF-TOKEN', $token);
            Auth::forgetGuards();
            $this->patchJson($endpoint, ['is_active' => false])->assertOk()->assertExactJson(['data' => [
                'id' => $category->id, 'name' => $category->name, 'is_active' => false, 'tickets_count' => 6,
            ]]);
            $after = $this->snapshot();
            unset($before['categories'], $after['categories']);
            $this->assertSame($before, $after);
            $unchanged = $this->snapshot();
            $this->travel(5)->minutes();
            $this->patchJson($endpoint, ['is_active' => false])->assertOk();
            $this->assertSame($unchanged, $this->snapshot());
            foreach ([0, 1, 'false', 'true', null, []] as $invalid) {
                $this->patchJson($endpoint, ['is_active' => $invalid])->assertUnprocessable()->assertJsonValidationErrors('is_active');
            }
            $this->patchJson($endpoint, ['is_active' => true, 'name' => 'Forbidden'])->assertUnprocessable();
            $this->assertSame($unchanged, $this->snapshot());
            $this->getJson('/api/categories')->assertOk()->assertJsonMissing(['id' => $category->id]);
            $this->getJson('/api/admin/categories')->assertOk()->assertJsonFragment([
                'id' => $category->id, 'name' => $category->name, 'is_active' => false, 'tickets_count' => 6,
            ]);
            $this->getJson('/api/tickets/'.$old->id)->assertOk()->assertJsonPath('category', ['id' => $category->id, 'name' => $category->name]);
            $payload = ['title' => 'Novo chamado', 'description' => 'Descrição.', 'category_id' => $category->id, 'priority' => 'medium'];
            $this->postJson('/api/tickets', $payload)->assertUnprocessable()->assertJsonValidationErrors('category_id');
            $this->patchJson('/api/tickets/'.$old->id.'/details', ['category_id' => $category->id])->assertUnprocessable()->assertJsonValidationErrors('category_id');
            $this->assertSame($unchanged, $this->snapshot());
            $this->patchJson($endpoint, ['is_active' => true])->assertOk()->assertJsonPath('data.is_active', true);
            $this->getJson('/api/categories')->assertOk()->assertJsonFragment(['id' => $category->id, 'name' => $category->name]);
            $this->assertSame($sequence, (array) DB::selectOne('SELECT last_value,is_called FROM categories_id_seq'));
            $this->postJson('/api/tickets', $payload)->assertCreated()->assertJsonPath('category.id', $category->id);
        } finally {
            while (DB::transactionLevel() > 0) {
                DB::rollBack();
            }
            DB::disconnect();
        }
    }
}
