<?php

namespace Tests\Feature;

use App\Models\Category;
use App\Models\SlaPolicy;
use App\Models\Ticket;
use App\Models\User;
use Database\Seeders\CategorySeeder;
use Database\Seeders\SlaPolicySeeder;
use Database\Seeders\TicketStatusSeeder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class DashboardSlaPostgresqlTest extends TestCase
{
    public function test_all_risk_boundaries_with_real_creation_and_aggregates_on_disposable_postgresql(): void
    {
        $host = getenv('FLOWDESK_SLA_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requer PostgreSQL descartável via FLOWDESK_SLA_PG_HOST.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-sla-test-[a-f0-9]+$/', $host);
        config(['database.default' => 'sla_pg', 'database.connections.sla_pg' => [
            'driver' => 'pgsql', 'host' => $host, 'port' => 5432,
            'database' => 'flowdesk_sla_test', 'username' => 'postgres', 'password' => '',
            'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer',
        ]]);
        $this->assertSame('flowdesk_sla_test', DB::connection()->getDatabaseName());
        $this->assertFalse(Schema::hasTable('users'));
        $this->artisan('migrate', ['--database' => 'sla_pg', '--force' => true])->assertSuccessful();
        $this->seed([CategorySeeder::class, TicketStatusSeeder::class, SlaPolicySeeder::class]);
        config(['sanctum.stateful' => ['localhost:5173']]);
        $this->withHeader('Origin', 'http://localhost:5173');
        $user = User::factory()->create(['role' => 'requester']);
        $this->actingAs($user, 'web');
        $category = Category::firstOrFail();
        $reference = Carbon::parse('2026-10-27T00:00:00Z');

        try {
            foreach (DashboardSlaTest::riskBoundaries() as $scenario => [$priority, $deadline, $elapsed, $expected]) {
                DB::beginTransaction();
                try {
                    $createdAt = $reference->copy()->subSeconds($elapsed);
                    $this->travelTo($createdAt);
                    $response = $this->postJson('/api/tickets', [
                        'title' => 'SLA '.$scenario, 'description' => 'Validação isolada de SLA.',
                        'category_id' => $category->id, 'priority' => $priority,
                    ])->assertCreated();
                    $ticket = Ticket::findOrFail($response->json('id'));
                    if ($deadline === 'resolution') {
                        $policy = SlaPolicy::where('priority', $priority)->sole();
                        $ticket->first_responded_at = $createdAt->copy()->addSeconds($policy->first_response_minutes * 30);
                        $ticket->save();
                    }
                    $before = $ticket->fresh()->getAttributes();
                    $this->travelTo($reference);
                    $this->getJson('/api/dashboard/sla')->assertOk()->assertExactJson(['data' => [
                        'on_track' => $expected === 'on_track' ? 1 : 0,
                        'at_risk' => $expected === 'at_risk' ? 1 : 0,
                        'overdue' => $expected === 'overdue' ? 1 : 0,
                    ]]);
                    $this->assertSame($before, $ticket->fresh()->getAttributes(), $scenario);
                } finally {
                    DB::rollBack();
                }
            }
            $this->assertDatabaseCount('tickets', 0);
            $this->assertDatabaseCount('ticket_activities', 0);
        } finally {
            DB::disconnect('sla_pg');
        }
    }
}
