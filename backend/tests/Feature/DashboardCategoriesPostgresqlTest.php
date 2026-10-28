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

class DashboardCategoriesPostgresqlTest extends TestCase
{
    use AssignmentFixtures;

    public function test_aggregate_visibility_zero_counts_and_order_on_disposable_postgresql(): void
    {
        $host = getenv('FLOWDESK_CATEGORIES_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requer PostgreSQL descartável via FLOWDESK_CATEGORIES_PG_HOST.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-categories-test-[a-f0-9]+$/', $host);
        config(['database.default' => 'categories_pg', 'database.connections.categories_pg' => [
            'driver' => 'pgsql', 'host' => $host, 'port' => 5432,
            'database' => 'flowdesk_categories_test', 'username' => 'postgres', 'password' => '',
            'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer',
        ]]);
        $this->assertSame('flowdesk_categories_test', DB::connection()->getDatabaseName());
        $this->assertFalse(Schema::hasTable('users'));
        $this->artisan('migrate', ['--database' => 'categories_pg', '--force' => true])->assertSuccessful();
        $this->seed([CategorySeeder::class, TicketStatusSeeder::class, SlaPolicySeeder::class]);
        config(['sanctum.stateful' => ['localhost:5173']]);
        $this->withHeader('Origin', 'http://localhost:5173');
        $this->requester = User::factory()->create(['role' => 'requester']);
        $technician = User::factory()->create(['role' => 'technician']);
        $otherTechnician = User::factory()->create(['role' => 'technician']);
        $admin = User::factory()->create(['role' => 'admin']);
        $alpha = Category::create(['name' => 'Alpha', 'is_active' => false]);
        $beta = Category::create(['name' => 'Beta']);

        try {
            foreach (TicketStatus::all() as $status) {
                $this->ticket(['category_id' => $alpha->id, 'status_id' => $status->id, 'assigned_to' => $technician->id]);
                $this->ticket(['category_id' => $beta->id, 'status_id' => $status->id, 'requester_id' => $otherTechnician->id]);
                $this->ticket(['category_id' => $beta->id, 'status_id' => $status->id, 'requester_id' => $technician->id, 'assigned_to' => $otherTechnician->id]);
            }
            $before = $this->snapshot();
            foreach ([[$admin, 6, 12], [$technician, 6, 6], [$this->requester, 6, 0]] as [$user, $alphaCount, $betaCount]) {
                Auth::forgetGuards();
                $response = $this->actingAs($user, 'web')->getJson('/api/dashboard/categories')->assertOk();
                $expected = Category::all()->map(fn (Category $category): array => [
                    'id' => $category->id, 'name' => $category->name,
                    'count' => $category->id === $alpha->id ? $alphaCount : ($category->id === $beta->id ? $betaCount : 0),
                ])->all();
                usort($expected, fn (array $a, array $b): int => ($b['count'] <=> $a['count']) ?: strcmp($a['name'], $b['name']) ?: ($a['id'] <=> $b['id']));
                $response->assertExactJson(['data' => $expected]);
                $this->assertSame($alphaCount + $betaCount, $this->getJson('/api/dashboard/stats')->assertOk()->json('data.total'));
            }
            $this->assertSame($before, $this->snapshot());
        } finally {
            DB::disconnect('categories_pg');
        }
    }
}
