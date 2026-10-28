<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Http\Requests\StoreTicketRequest;
use App\Models\Category;
use App\Models\SlaPolicy;
use App\Models\Ticket;
use App\Models\TicketActivity;
use App\Models\TicketStatus;
use App\Models\User;
use Database\Seeders\CategorySeeder;
use Database\Seeders\SlaPolicySeeder;
use Database\Seeders\TicketStatusSeeder;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Schema;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\TestCase;

class StoreTicketTest extends TestCase
{
    private User $user;

    private Category $category;

    protected function setUp(): void
    {
        parent::setUp();

        $this->assertSame('sqlite', config('database.default'));
        $this->assertSame(':memory:', config('database.connections.sqlite.database'));

        $migration = require database_path('migrations/0001_01_01_000000_create_users_table.php');
        $migration->up();
        Schema::table('users', function (Blueprint $table) {
            $table->string('role', 20)->default('requester');
            $table->timestampTz('disabled_at')->nullable();
        });

        $migration = require database_path('migrations/2026_10_19_194356_create_categories_table.php');
        $migration->up();

        // Espelha as tabelas sem os ALTER TABLE ... ADD CONSTRAINT exclusivos do PostgreSQL.
        Schema::create('ticket_statuses', function (Blueprint $table) {
            $table->id();
            $table->string('code', 30)->unique();
            $table->string('name', 80);
            $table->integer('position');
            $table->timestampsTz();
        });
        Schema::create('sla_policies', function (Blueprint $table) {
            $table->id();
            $table->string('priority', 10)->unique();
            $table->integer('first_response_minutes');
            $table->integer('resolution_minutes');
            $table->timestampsTz();
        });
        Schema::create('tickets', function (Blueprint $table) {
            $table->id();
            $table->foreignId('requester_id')->constrained('users')->restrictOnDelete();
            $table->foreignId('assigned_to')->nullable()->constrained('users')->restrictOnDelete();
            $table->foreignId('category_id')->constrained('categories')->restrictOnDelete();
            $table->foreignId('status_id')->constrained('ticket_statuses')->restrictOnDelete();
            $table->foreignId('sla_policy_id')->constrained('sla_policies')->restrictOnDelete();
            $table->string('title', 200);
            $table->text('description');
            $table->string('priority', 10)->default('medium');
            $table->timestampTz('first_response_due_at');
            $table->timestampTz('resolution_due_at');
            $table->timestampTz('first_responded_at')->nullable();
            $table->timestampTz('resolved_at')->nullable();
            $table->timestampTz('closed_at')->nullable();
            $table->timestampsTz();
        });
        (require database_path('migrations/2026_10_22_180000_expand_ticket_title_length.php'))->up();

        $migration = require database_path('migrations/2026_10_19_200056_create_ticket_activities_table.php');
        $migration->up();

        $this->seed([TicketStatusSeeder::class, SlaPolicySeeder::class, CategorySeeder::class]);
        $this->user = User::factory()->create(['role' => 'requester']);
        $this->category = Category::firstOrFail();
        $this->travelTo(Carbon::parse('2026-10-23 23:50:00', 'UTC'));
        config(['sanctum.stateful' => ['localhost:5173']]);
        $this->withHeader('Origin', 'http://localhost:5173');
    }

    #[DataProvider('roles')]
    public function test_each_allowed_role_can_create_using_the_existing_session(string $role): void
    {
        $this->user->update(['role' => $role]);
        $this->postJson('/api/login', ['email' => $this->user->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        Auth::forgetGuards();

        $response = $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
            ->postJson('/api/tickets', $this->payload())->assertCreated();

        $ticket = Ticket::sole();
        $this->assertSame($this->user->id, $ticket->requester_id);
        $this->assertSame('open', $ticket->status->code);
        $this->assertSame($this->category->id, $ticket->category_id);
        $this->assertNull($ticket->assigned_to);
        $this->assertNull($ticket->first_responded_at);
        $this->assertNull($ticket->resolved_at);
        $this->assertNull($ticket->closed_at);
        $response->assertExactJson([
            'id' => $ticket->id,
            'title' => 'Sem acesso ao sistema',
            'description' => 'O sistema apresenta uma falha ao abrir.',
            'priority' => 'medium',
            'requester' => ['id' => $this->user->id, 'name' => $this->user->name],
            'category' => ['id' => $this->category->id, 'name' => $this->category->name],
            'status' => ['id' => $ticket->status->id, 'code' => 'open', 'name' => 'Aberto'],
            'created_at' => '2026-10-23T23:50:00.000000Z',
            'first_response_due_at' => '2026-10-24T03:50:00.000000Z',
            'resolution_due_at' => '2026-10-24T23:50:00.000000Z',
        ]);
        $activity = TicketActivity::sole();
        $this->assertSame($ticket->id, $activity->ticket_id);
        $this->assertSame($this->user->id, $activity->actor_id);
        $this->assertSame('ticket_created', $activity->action);
        $this->assertNull($activity->changes);
        $this->assertTrue($activity->created_at->equalTo($ticket->created_at));
    }

    public static function roles(): array
    {
        return [['requester'], ['technician'], ['admin']];
    }

    #[DataProvider('priorities')]
    public function test_sla_uses_the_matching_policy_and_continuous_minutes(string $priority, int $first, int $resolution): void
    {
        $this->actingAs($this->user, 'web')->postJson('/api/tickets', $this->payload(['priority' => $priority]))
            ->assertCreated();

        $ticket = Ticket::sole();
        $this->assertSame(SlaPolicy::where('priority', $priority)->sole()->id, $ticket->sla_policy_id);
        $this->assertTrue($ticket->first_response_due_at->equalTo(now()->addMinutes($first)));
        $this->assertTrue($ticket->resolution_due_at->equalTo(now()->addMinutes($resolution)));
    }

    public static function priorities(): array
    {
        return [['low', 480, 4320], ['medium', 240, 1440], ['high', 60, 480], ['urgent', 15, 240]];
    }

    #[DataProvider('forbiddenFields')]
    public function test_client_cannot_set_internal_attributes(string $field): void
    {
        $before = $this->snapshot();
        $this->actingAs($this->user, 'web')->postJson('/api/tickets', $this->payload([$field => null]))
            ->assertUnprocessable()->assertJsonValidationErrors('payload');
        $this->assertSame($before, $this->snapshot());
    }

    public static function forbiddenFields(): array
    {
        return array_map(fn ($field) => [$field], [
            'id', 'requester_id', 'assigned_to', 'status', 'status_id', 'sla_policy_id', 'sla',
            'first_response_due_at', 'resolution_due_at', 'first_responded_at', 'resolved_at', 'closed_at',
            'created_at', 'updated_at', 'activities', 'comments', 'actor_id', 'user_id', 'changes', 'unknown',
        ]);
    }

    #[DataProvider('invalidInput')]
    public function test_invalid_input_is_rejected(array $input, string $field): void
    {
        $this->actingAs($this->user, 'web')->postJson('/api/tickets', $this->payload($input))
            ->assertUnprocessable()->assertJsonValidationErrors($field);
        $this->assertDatabaseCount('tickets', 0);
        $this->assertDatabaseCount('ticket_activities', 0);
    }

    public static function invalidInput(): array
    {
        return [
            'title missing' => [['title' => null], 'title'],
            'title too long' => [['title' => str_repeat('á', 256)], 'title'],
            'title blank after trim' => [['title' => " \t\n "], 'title'],
            'title not a string' => [['title' => []], 'title'],
            'title numeric' => [['title' => 123], 'title'],
            'description missing' => [['description' => null], 'description'],
            'description blank after trim' => [['description' => " \r\n\t "], 'description'],
            'description too long' => [['description' => str_repeat('á', 10001)], 'description'],
            'description not a string' => [['description' => []], 'description'],
            'description boolean' => [['description' => true], 'description'],
            'category missing' => [['category_id' => null], 'category_id'],
            'category nonexistent' => [['category_id' => 999], 'category_id'],
            'category not an integer' => [['category_id' => 'invalid'], 'category_id'],
            'category numeric string' => [['category_id' => '1'], 'category_id'],
            'category zero' => [['category_id' => 0], 'category_id'],
            'category negative' => [['category_id' => -1], 'category_id'],
            'category boolean' => [['category_id' => true], 'category_id'],
            'priority missing' => [['priority' => null], 'priority'],
            'priority invalid' => [['priority' => 'critical'], 'priority'],
            'priority uppercase' => [['priority' => 'HIGH'], 'priority'],
            'priority not a string' => [['priority' => []], 'priority'],
        ];
    }

    public function test_all_required_fields_are_reported_for_empty_input(): void
    {
        $this->actingAs($this->user, 'web')->postJson('/api/tickets', [])
            ->assertUnprocessable()->assertJsonValidationErrors(['title', 'description', 'category_id', 'priority']);
        $this->assertDatabaseCount('tickets', 0);
        $this->assertDatabaseCount('ticket_activities', 0);
    }

    public function test_normalized_title_and_description_accept_the_exact_unicode_limits(): void
    {
        $title = str_repeat('á', 255);
        $description = str_repeat('ç', 10000);
        $this->actingAs($this->user, 'web')->postJson('/api/tickets', $this->payload(['title' => "  $title \n", 'description' => "\t $description \r\n"]))
            ->assertCreated()->assertJsonPath('title', $title)->assertJsonPath('description', $description);
        $this->assertSame($title, Ticket::sole()->title);
        $this->assertSame($description, Ticket::sole()->description);
    }

    public function test_numeric_json_category_with_fraction_is_not_an_integer_id(): void
    {
        $before = $this->snapshot();
        $this->actingAs($this->user, 'web')->postJson('/api/tickets', $this->payload(['category_id' => (float) $this->category->id]), [], JSON_PRESERVE_ZERO_FRACTION)
            ->assertUnprocessable()->assertJsonValidationErrors('category_id');
        $this->assertSame($before, $this->snapshot());
    }

    #[DataProvider('roles')]
    public function test_session_author_cannot_be_overridden_by_any_role(string $role): void
    {
        $this->user->update(['role' => $role]);
        $other = User::factory()->create(['role' => 'requester']);
        $this->postJson('/api/login', ['email' => $this->user->email, 'password' => 'password'])->assertOk();
        $id = session()->getId();
        Auth::forgetGuards();
        $before = $this->snapshot();
        $this->withCredentials()->withCookie(config('session.cookie'), $id)->postJson('/api/tickets', $this->payload(['requester_id' => $other->id]))->assertUnprocessable()->assertJsonValidationErrors('payload');
        $this->assertSame($before, $this->snapshot());
    }

    public function test_inactive_category_is_rejected(): void
    {
        $this->category->update(['is_active' => false]);
        $this->actingAs($this->user, 'web')->postJson('/api/tickets', $this->payload())
            ->assertUnprocessable()->assertJsonValidationErrors('category_id');
        $this->assertDatabaseCount('tickets', 0);
        $this->assertDatabaseCount('ticket_activities', 0);
    }

    public function test_guest_is_unauthorized_even_with_invalid_input(): void
    {
        $this->postJson('/api/tickets', [])->assertUnauthorized();
        $this->assertDatabaseCount('tickets', 0);
    }

    public function test_disabled_user_is_forbidden_before_validation(): void
    {
        $this->user->update(['disabled_at' => now()]);
        $this->actingAs($this->user, 'web')->postJson('/api/tickets', [])
            ->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
        $this->assertDatabaseCount('tickets', 0);
        $this->assertDatabaseCount('ticket_activities', 0);
    }

    public function test_unknown_role_is_not_authorized(): void
    {
        $this->user->update(['role' => 'unknown']);
        $this->actingAs($this->user, 'web')->postJson('/api/tickets', $this->payload())->assertForbidden();
        $this->assertDatabaseCount('tickets', 0);
    }

    public function test_user_disabled_after_login_cannot_create_a_ticket(): void
    {
        $this->postJson('/api/login', ['email' => $this->user->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $this->user->update(['disabled_at' => now()]);
        Auth::forgetGuards();

        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
            ->postJson('/api/tickets', $this->payload())->assertForbidden();
        $this->assertDatabaseCount('tickets', 0);
        $this->assertDatabaseCount('ticket_activities', 0);
    }

    public function test_stateful_creation_requires_csrf_outside_the_test_bypass(): void
    {
        $this->postJson('/api/login', ['email' => $this->user->email, 'password' => 'password'])->assertOk();
        $csrfToken = session()->token();
        $this->app->instance('env', 'local');

        $this->postJson('/api/tickets', $this->payload())->assertStatus(419);
        $this->assertDatabaseCount('tickets', 0);
        $this->assertDatabaseCount('ticket_activities', 0);

        $this->withHeader('X-CSRF-TOKEN', $csrfToken)->postJson('/api/tickets', $this->payload())->assertCreated();
    }

    #[DataProvider('requiredConfiguration')]
    public function test_missing_configuration_fails_safely_without_partial_records(string $model): void
    {
        if ($model === TicketStatus::class) {
            TicketStatus::where('code', 'open')->delete();
        } else {
            SlaPolicy::where('priority', 'medium')->delete();
        }
        $this->actingAs($this->user, 'web')->postJson('/api/tickets', $this->payload())
            ->assertStatus(503)->assertExactJson(['message' => 'Não foi possível criar o chamado no momento.']);
        $this->assertDatabaseCount('tickets', 0);
        $this->assertDatabaseCount('ticket_activities', 0);
    }

    public static function requiredConfiguration(): array
    {
        return [[TicketStatus::class], [SlaPolicy::class]];
    }

    #[DataProvider('writeFailures')]
    public function test_failures_roll_back_both_inserts_and_preserve_existing_records(string $model, string $event): void
    {
        $this->actingAs($this->user, 'web')->postJson('/api/tickets', $this->payload())->assertCreated();
        $before = $this->snapshot();
        $this->withoutExceptionHandling();
        $model::$event(function (): void {
            throw new RuntimeException('Simulated creation failure');
        });

        try {
            $this->actingAs($this->user, 'web')->postJson('/api/tickets', $this->payload());
            $this->fail('Expected an activity failure.');
        } catch (RuntimeException $exception) {
            $this->assertSame('Simulated creation failure', $exception->getMessage());
        } finally {
            $model::flushEventListeners();
        }

        $this->assertSame($before, $this->snapshot());
        $this->assertSame(0, DB::transactionLevel());
    }

    public static function writeFailures(): array
    {
        return [[Ticket::class, 'creating'], [Ticket::class, 'created'], [TicketActivity::class, 'creating'], [TicketActivity::class, 'created']];
    }

    #[DataProvider('stateChanges')]
    public function test_user_and_category_are_rechecked_inside_the_transaction(string $change, int $http): void
    {
        $before = null;
        $this->app->afterResolving(StoreTicketRequest::class, function () use ($change, &$before): void {
            match ($change) {
                'disabled' => $this->user->update(['disabled_at' => now()]),
                'role' => $this->user->update(['role' => 'unknown']),
                'category' => $this->category->update(['is_active' => false]),
                'deleted_category' => $this->category->delete(),
            };
            $before = $this->snapshot();
        });
        $this->actingAs($this->user, 'web')->postJson('/api/tickets', $this->payload())->assertStatus($http);
        $this->assertNotNull($before);
        $this->assertSame($before, $this->snapshot());
    }

    public static function stateChanges(): array
    {
        return [['disabled', 403], ['role', 403], ['category', 422], ['deleted_category', 422]];
    }

    public function test_creation_preserves_users_configuration_and_other_records(): void
    {
        $this->actingAs($this->user, 'web')->postJson('/api/tickets', $this->payload())->assertCreated();
        $before = [];
        foreach (['users', 'categories', 'ticket_statuses', 'sla_policies', 'tickets', 'ticket_activities'] as $table) {
            $before[$table] = DB::table($table)->orderBy('id')->get()->toJson();
        }

        $this->postJson('/api/tickets', $this->payload())->assertCreated();

        foreach ($before as $table => $snapshot) {
            $query = DB::table($table)->orderBy('id');
            if (in_array($table, ['tickets', 'ticket_activities'], true)) {
                $query->where('id', 1);
            }
            $this->assertSame($snapshot, $query->get()->toJson());
        }
        $this->assertDatabaseCount('tickets', 2);
        $this->assertDatabaseCount('ticket_activities', 2);
        $this->assertFalse(Schema::hasTable('personal_access_tokens'));
    }

    public function test_route_uses_sanctum_before_the_active_user_middleware(): void
    {
        $route = Route::getRoutes()->match(Request::create('/api/tickets', 'POST'));
        $middleware = Route::gatherRouteMiddleware($route);
        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(
            array_search(EnsureUserIsActive::class, $middleware, true),
            array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true),
        );
    }

    private function payload(array $overrides = []): array
    {
        return array_replace([
            'title' => 'Sem acesso ao sistema',
            'description' => 'O sistema apresenta uma falha ao abrir.',
            'category_id' => $this->category->id,
            'priority' => 'medium',
        ], $overrides);
    }

    private function snapshot(): array
    {
        $snapshot = [];
        foreach (['users', 'categories', 'ticket_statuses', 'sla_policies', 'tickets', 'ticket_activities', 'sessions'] as $table) {
            $snapshot[$table] = DB::table($table)->orderBy('id')->get()->toJson();
        }

        return $snapshot;
    }
}
