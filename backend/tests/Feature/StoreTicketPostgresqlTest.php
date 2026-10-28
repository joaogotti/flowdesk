<?php

namespace Tests\Feature;

use App\Models\Category;
use App\Models\SlaPolicy;
use App\Models\Ticket;
use App\Models\TicketActivity;
use App\Models\User;
use Database\Seeders\CategorySeeder;
use Database\Seeders\SlaPolicySeeder;
use Database\Seeders\TicketStatusSeeder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use RuntimeException;
use Tests\TestCase;

class StoreTicketPostgresqlTest extends TestCase
{
    public function test_real_migrations_session_creation_limits_sla_and_rollback_on_disposable_postgresql(): void
    {
        $host = getenv('FLOWDESK_CREATION_PG_HOST');
        if (! $host) {
            $this->markTestSkipped('Requer PostgreSQL descartável via FLOWDESK_CREATION_PG_HOST.');
        }
        $this->assertMatchesRegularExpression('/^flowdesk-creation-test-[a-f0-9]+$/', $host);
        config(['database.default' => 'creation_pg', 'database.connections.creation_pg' => [
            'driver' => 'pgsql', 'host' => $host, 'port' => 5432,
            'database' => 'flowdesk_creation_test', 'username' => 'postgres', 'password' => '',
            'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer',
        ]]);
        $this->assertSame('flowdesk_creation_test', DB::connection()->getDatabaseName());
        $this->assertFalse(Schema::hasTable('users'));
        $this->artisan('migrate', ['--database' => 'creation_pg', '--force' => true])->assertSuccessful();
        $this->assertSame(255, DB::selectOne("select character_maximum_length as length from information_schema.columns where table_schema='public' and table_name='tickets' and column_name='title'")->length);
        $this->seed([CategorySeeder::class, TicketStatusSeeder::class, SlaPolicySeeder::class]);
        $this->travelTo(Carbon::parse('2026-10-23 23:50:00', 'UTC'));
        config(['sanctum.stateful' => ['localhost:5173']]);
        $this->withHeader('Origin', 'http://localhost:5173');
        $category = Category::firstOrFail();
        $payload = ['title' => '  '.str_repeat('á', 255).'  ', 'description' => "\n".str_repeat('ç', 10000)."\t", 'category_id' => $category->id, 'priority' => 'medium'];
        $previous = null;
        $previousTicket = null;
        $count = 0;

        try {
            foreach (['requester', 'technician', 'admin'] as $role) {
                $user = User::factory()->create(['role' => $role]);
                Auth::forgetGuards();
                $this->postJson('/api/login', ['email' => $user->email, 'password' => 'password'])->assertOk();
                $sessionId = session()->getId();
                $token = session()->token();
                $this->app->instance('env', 'local');
                Auth::forgetGuards();
                $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)->postJson('/api/tickets', $payload)->assertStatus(419);
                $this->withHeader('X-CSRF-TOKEN', $token);
                foreach (['low', 'medium', 'high', 'urgent'] as $priority) {
                    Auth::forgetGuards();
                    $response = $this->postJson('/api/tickets', array_replace($payload, ['priority' => $priority]))->assertCreated();
                    $ticket = Ticket::findOrFail($response->json('id'));
                    $policy = SlaPolicy::where('priority', $priority)->sole();
                    $this->assertSame(str_repeat('á', 255), $ticket->title);
                    $this->assertSame(str_repeat('ç', 10000), $ticket->description);
                    $this->assertSame($user->id, $ticket->requester_id);
                    $this->assertSame('open', $ticket->status->code);
                    $this->assertSame($policy->id, $ticket->sla_policy_id);
                    $this->assertTrue($ticket->created_at->equalTo(now()));
                    $this->assertTrue($ticket->first_response_due_at->equalTo(now()->addMinutes($policy->first_response_minutes)));
                    $this->assertTrue($ticket->resolution_due_at->equalTo(now()->addMinutes($policy->resolution_minutes)));
                    foreach (['assigned_to', 'first_responded_at', 'resolved_at', 'closed_at'] as $field) {
                        $this->assertNull($ticket->$field);
                    }
                    $activity = $ticket->activities()->sole();
                    $this->assertSame('ticket_created', $activity->action);
                    $this->assertSame($user->id, $activity->actor_id);
                    $this->assertNull($activity->changes);
                    $this->assertTrue($activity->created_at->equalTo($ticket->created_at));
                    $this->assertDatabaseCount('tickets', ++$count);
                    $this->assertDatabaseCount('ticket_activities', $count);
                    if ($previous !== null) {
                        $this->assertSame($previous, $previousTicket->fresh()->getAttributes());
                    }
                    $previousTicket = $ticket;
                    $previous = $ticket->fresh()->getAttributes();
                }
                $before = $this->snapshot();
                foreach ([['requester_id' => $user->id], ['title' => str_repeat('a', 256)], ['description' => str_repeat('a', 10001)]] as $invalid) {
                    $this->postJson('/api/tickets', array_replace($payload, $invalid))->assertUnprocessable();
                    $this->assertSame($before, $this->snapshot());
                }
                $this->app->instance('env', 'testing');
                $this->flushHeaders()->withHeader('Origin', 'http://localhost:5173');
            }
            $before = $this->snapshot();
            $this->withoutExceptionHandling();
            TicketActivity::created(function (): void {
                throw new RuntimeException('PostgreSQL activity failure');
            });
            try {
                $this->postJson('/api/tickets', $payload);
                $this->fail('Expected atomic PostgreSQL write failure.');
            } catch (RuntimeException $exception) {
                $this->assertSame('PostgreSQL activity failure', $exception->getMessage());
            } finally {
                TicketActivity::flushEventListeners();
            }
            $this->assertSame($before, $this->snapshot());
            $this->assertSame(0, DB::transactionLevel());
        } finally {
            DB::disconnect();
        }
    }

    private function snapshot(): array
    {
        $snapshot = [];
        foreach (['users', 'categories', 'ticket_statuses', 'sla_policies', 'tickets', 'ticket_activities', 'ticket_comments', 'sessions'] as $table) {
            $snapshot[$table] = DB::table($table)->orderBy('id')->get()->toJson();
        }

        return $snapshot;
    }
}
