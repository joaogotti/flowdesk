<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Models\Category;
use App\Models\SlaPolicy;
use App\Models\Ticket;
use App\Models\TicketActivity;
use App\Models\TicketComment;
use App\Models\TicketStatus;
use App\Models\User;
use Database\Seeders\CategorySeeder;
use Database\Seeders\SlaPolicySeeder;
use Database\Seeders\TicketStatusSeeder;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Schema;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class ShowTicketTest extends TestCase
{
    private User $requester;

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
            $table->bigInteger('session_version')->default(0);
        });
        $migration = require database_path('migrations/2026_10_19_194356_create_categories_table.php');
        $migration->up();

        // Segue a suíte existente: espelha as tabelas sem os CHECKs exclusivos do PostgreSQL.
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
        foreach (['2026_10_19_195904_create_ticket_comments_table.php', '2026_10_19_200056_create_ticket_activities_table.php'] as $file) {
            $migration = require database_path('migrations/'.$file);
            $migration->up();
        }
        $this->seed([TicketStatusSeeder::class, SlaPolicySeeder::class, CategorySeeder::class]);
        $this->requester = User::factory()->create(['role' => 'requester']);
        $this->travelTo(now()->startOfSecond());
        config(['sanctum.stateful' => ['localhost:5173']]);
        $this->withHeader('Origin', 'http://localhost:5173');
    }

    public function test_owner_gets_exact_ticket_fields_with_null_optional_dates_and_empty_relations(): void
    {
        $ticket = $this->ticket();

        $this->show($this->requester, $ticket)->assertOk()
            ->assertHeader('Content-Type', 'application/json')
            ->assertExactJson($this->expectedTicket($ticket));
    }

    #[DataProvider('assignmentStates')]
    public function test_technician_can_read_assigned_and_unassigned_tickets(bool $assigned): void
    {
        $technician = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket(['assigned_to' => $assigned ? $technician->id : null]);

        $this->show($technician, $ticket)->assertOk()->assertExactJson($this->expectedTicket($ticket));
    }

    public static function assignmentStates(): array
    {
        return [[true], [false]];
    }

    public function test_admin_gets_complete_ticket_with_persisted_dates_comments_and_activities(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $technician = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket([
            'assigned_to' => $technician->id,
            'first_response_due_at' => now()->subHours(3),
            'resolution_due_at' => now()->addHours(8),
            'first_responded_at' => now()->subHours(4),
            'resolved_at' => now()->subHours(2),
            'closed_at' => now()->subHour(),
            'status_id' => TicketStatus::where('code', 'closed')->sole()->id,
        ]);
        $ticket->updated_at = now()->addMinute();
        $ticket->save();
        $comment = $this->comment($ticket, $technician, true);
        $activity = $this->activity($ticket, null, 'administrative_action', ['internal' => 'secret-changes']);
        $expected = $this->expectedTicket($ticket);
        $expected['comments'] = [[
            'id' => $comment->id, 'author' => $technician->only(['id', 'name']),
            'body' => $comment->body, 'is_internal' => true, 'created_at' => $comment->created_at->toISOString(),
        ]];
        $expected['activities'] = [[
            'id' => $activity->id, 'action' => $activity->action, 'actor' => null,
            'created_at' => $activity->created_at->toISOString(),
        ]];

        $this->show($admin, $ticket)->assertOk()->assertExactJson($expected);
    }

    public function test_requester_cannot_read_another_ticket_even_when_they_are_a_comment_author_or_actor(): void
    {
        $other = User::factory()->create(['role' => 'requester']);
        $ticket = $this->ticket(['requester_id' => $other->id]);
        $this->comment($ticket, $this->requester);
        $this->activity($ticket, $this->requester, 'created');
        DB::enableQueryLog();

        $this->show($this->requester, $ticket)->assertNotFound()
            ->assertExactJson(['message' => 'Chamado não encontrado.']);

        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        foreach ($queries as $query) {
            $this->assertStringNotContainsString('ticket_comments', $query['query']);
            $this->assertStringNotContainsString('ticket_activities', $query['query']);
        }
    }

    #[DataProvider('assignmentStates')]
    public function test_technician_cannot_read_another_assignment_even_if_they_are_the_requester(bool $isRequester): void
    {
        $technician = User::factory()->create(['role' => 'technician']);
        $other = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket([
            'assigned_to' => $other->id,
            'requester_id' => $isRequester ? $technician->id : $this->requester->id,
        ]);

        $this->show($technician, $ticket)->assertNotFound()
            ->assertExactJson(['message' => 'Chamado não encontrado.']);
    }

    #[DataProvider('roles')]
    public function test_nonexistent_ticket_returns_the_same_generic_404(string $role): void
    {
        $user = User::factory()->create(['role' => $role]);

        $this->actingAs($user, 'web')->getJson('/api/tickets/999999')->assertNotFound()
            ->assertExactJson(['message' => 'Chamado não encontrado.']);
    }

    public static function roles(): array
    {
        return [['requester'], ['technician'], ['admin']];
    }

    public function test_guest_is_unauthorized_for_existing_and_missing_tickets(): void
    {
        $ticket = $this->ticket();

        $this->getJson('/api/tickets/'.$ticket->id)->assertUnauthorized()->assertJsonMissingPath('id');
        $this->getJson('/api/tickets/999999')->assertUnauthorized()->assertJsonMissingPath('id');
    }

    #[DataProvider('roles')]
    public function test_disabled_user_is_forbidden_for_existing_and_missing_tickets(string $role): void
    {
        $user = User::factory()->create(['role' => $role, 'disabled_at' => now()]);
        $ticket = $this->ticket(['requester_id' => $user->id]);

        $this->show($user, $ticket)->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
        $this->actingAs($user, 'web')->getJson('/api/tickets/999999')->assertForbidden()
            ->assertExactJson(['message' => 'Acesso não permitido.']);
    }

    public function test_unknown_role_has_no_ticket_visibility(): void
    {
        $user = User::factory()->create(['role' => 'unknown']);
        $ticket = $this->ticket(['requester_id' => $user->id]);

        $this->show($user, $ticket)->assertNotFound();
    }

    #[DataProvider('invalidIds')]
    public function test_invalid_and_out_of_range_ids_return_404(string $id): void
    {
        $this->actingAs($this->requester, 'web')->getJson('/api/tickets/'.$id)->assertNotFound();
    }

    public static function invalidIds(): array
    {
        return [['0'], ['-1'], ['abc'], ['1.5'], ['9223372036854775808'], [str_repeat('9', 50)], ['1%20OR%201=1']];
    }

    public function test_client_parameters_cannot_bypass_ticket_or_relation_visibility(): void
    {
        $other = User::factory()->create(['role' => 'requester']);
        $hidden = $this->ticket(['requester_id' => $other->id]);
        $own = $this->ticket();
        $this->comment($own, $other, true);
        $this->activity($own, $other, 'administrative_action');
        $params = http_build_query([
            'role' => 'admin', 'requester_id' => $this->requester->id, 'assigned_to' => $this->requester->id,
            'include' => 'comments.user.password,activities.changes', 'is_internal' => true, 'id' => $own->id,
        ]);

        $this->actingAs($this->requester, 'web')->getJson('/api/tickets/'.$hidden->id.'?'.$params)->assertNotFound();
        $this->actingAs($this->requester, 'web')->getJson('/api/tickets/'.$own->id.'?'.$params)
            ->assertOk()->assertJsonPath('comments', [])->assertJsonPath('activities', []);
    }

    #[DataProvider('roles')]
    public function test_comment_visibility_and_chronological_order_with_id_tiebreaker(string $role): void
    {
        $user = $role === 'requester' ? $this->requester : User::factory()->create(['role' => $role]);
        $ticket = $this->ticket(['assigned_to' => $role === 'technician' ? $user->id : null]);
        $first = $this->comment($ticket, $this->requester);
        $second = $this->comment($ticket, $user);
        $older = $this->comment($ticket, $user, false, now()->subHour());
        $internal = $this->comment($ticket, $user, true, now()->subHours(2));
        $this->comment($this->ticket(), $user);

        $response = $this->show($user, $ticket)->assertOk();
        $expectedIds = $role === 'requester'
            ? [$older->id, $first->id, $second->id]
            : [$internal->id, $older->id, $first->id, $second->id];
        $this->assertSame($expectedIds, array_column($response->json('comments'), 'id'));
        foreach ($response->json('comments') as $comment) {
            $this->assertSame(['id', 'name'], array_keys($comment['author']));
            if ($role === 'requester') {
                $this->assertArrayNotHasKey('is_internal', $comment);
                $this->assertNotSame($internal->body, $comment['body']);
            } else {
                $this->assertIsBool($comment['is_internal']);
            }
        }
    }

    #[DataProvider('roles')]
    public function test_activity_visibility_order_and_projection_never_exposes_changes(string $role): void
    {
        $user = $role === 'requester' ? $this->requester : User::factory()->create(['role' => $role]);
        $ticket = $this->ticket();
        $first = $this->activity($ticket, $this->requester, 'created');
        $second = $this->activity($ticket, null, 'created');
        $older = $this->activity($ticket, $user, 'created', null, now()->subHour());
        $private = $this->activity($ticket, $user, 'internal_comment_added', ['body' => 'secret-changes'], now()->subHours(2));
        $unknown = $this->activity($ticket, $user, 'future_unknown_action');
        $createdWithChanges = $this->activity($ticket, $user, 'created', ['internal' => true]);
        $this->activity($this->ticket(), $user, 'created');

        $response = $this->show($user, $ticket)->assertOk();
        $expectedIds = $role === 'requester'
            ? [$older->id, $first->id, $second->id]
            : [$private->id, $older->id, $first->id, $second->id, $unknown->id, $createdWithChanges->id];
        $this->assertSame($expectedIds, array_column($response->json('activities'), 'id'));
        foreach ($response->json('activities') as $activity) {
            $this->assertSame(['id', 'action', 'actor', 'created_at'], array_keys($activity));
            if ($activity['actor'] !== null) {
                $this->assertSame(['id', 'name'], array_keys($activity['actor']));
            }
        }
        $this->assertNull($response->json('activities.'.array_search($second->id, $expectedIds, true).'.actor'));
        $this->assertStringNotContainsString('secret-changes', $response->getContent());
    }

    public function test_response_does_not_expose_sensitive_attributes_even_for_admin(): void
    {
        $admin = User::factory()->create(['role' => 'admin', 'remember_token' => 'secret-token']);
        $ticket = $this->ticket(['assigned_to' => $admin->id]);
        $this->comment($ticket, $admin, true);
        $this->activity($ticket, $admin, 'created', ['password' => 'secret-changes']);

        $response = $this->show($admin, $ticket)->assertOk();
        foreach (['email', 'password', 'remember_token', 'changes', 'sla_policy_id', 'disabled_at', 'description'] as $field) {
            if ($field !== 'description') {
                $response->assertJsonMissingPath($field);
            }
            foreach (['requester', 'assignee', 'category', 'status', 'comments.0.author', 'activities.0.actor'] as $path) {
                $response->assertJsonMissingPath($path.'.'.$field);
            }
        }
        foreach ([$admin->email, $admin->password, 'secret-token', 'secret-changes'] as $secret) {
            $this->assertStringNotContainsString($secret, $response->getContent());
        }
    }

    public function test_relation_query_count_is_constant_when_comments_and_activities_grow(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket(['assigned_to' => $admin->id]);
        $this->comment($ticket, $this->requester);
        $this->activity($ticket, $this->requester, 'created');
        DB::enableQueryLog();
        $this->show($admin, $ticket)->assertOk();
        $initialQueryCount = count(DB::getQueryLog());
        DB::disableQueryLog();
        for ($index = 0; $index < 10; $index++) {
            $author = User::factory()->create(['role' => 'technician']);
            $this->comment($ticket, $author, true);
            $this->activity($ticket, $author, 'internal_action', ['secret' => true]);
        }
        DB::flushQueryLog();
        DB::enableQueryLog();

        $this->show($admin, $ticket)->assertOk()->assertJsonCount(11, 'comments')->assertJsonCount(11, 'activities');

        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        $this->assertSame($initialQueryCount, count($queries));
        $this->assertLessThanOrEqual(10, count($queries));
    }

    #[DataProvider('staffRoles')]
    public function test_staff_receive_only_allowed_transitions_with_inactive_historical_references(string $role): void
    {
        $user = User::factory()->create(['role' => $role]);
        $previous = User::factory()->create(['role' => 'technician', 'disabled_at' => now()]);
        $next = User::factory()->create(['role' => 'technician']);
        $inactive = Category::create(['name' => 'Categoria inativa', 'is_active' => false]);
        $category = Category::create(['name' => 'Categoria atual', 'is_active' => true]);
        $ticket = $this->ticket(['assigned_to' => $user->id]);
        $cases = [
            ['assignment_changed', ['assigned_to' => ['from' => null, 'to' => $previous->id]],
                ['assignee' => ['from' => null, 'to' => $previous->only(['id', 'name'])]]],
            ['assignment_changed', ['assigned_to' => ['from' => $previous->id, 'to' => $next->id]],
                ['assignee' => ['from' => $previous->only(['id', 'name']), 'to' => $next->only(['id', 'name'])]]],
            ['assignment_changed', ['assigned_to' => ['from' => $next->id, 'to' => null]],
                ['assignee' => ['from' => $next->only(['id', 'name']), 'to' => null]]],
            ['status_changed', ['status' => ['from' => 'open', 'to' => 'in_progress']],
                ['status' => ['from' => 'open', 'to' => 'in_progress']]],
            ['details_changed', ['category_id' => ['from' => $inactive->id, 'to' => $category->id], 'priority' => ['from' => 'medium', 'to' => 'high']],
                ['category' => ['from' => $inactive->only(['id', 'name']), 'to' => $category->only(['id', 'name'])], 'priority' => ['from' => 'medium', 'to' => 'high']]],
            ['details_changed', ['priority' => ['from' => 'low', 'to' => 'urgent']],
                ['priority' => ['from' => 'low', 'to' => 'urgent']]],
        ];
        $expected = [];
        foreach ($cases as [$action, $changes, $details]) {
            $changes['private'] = 'secret-history-marker';
            foreach (array_keys($changes) as $field) {
                if (is_array($changes[$field])) {
                    $changes[$field]['private'] = 'secret-history-marker';
                }
            }
            $activity = $this->activity($ticket, $user, $action, $changes);
            $expected[] = [
                'id' => $activity->id, 'action' => $action, 'actor' => $user->only(['id', 'name']),
                'created_at' => $activity->created_at->toISOString(), 'details' => $details,
            ];
        }

        $response = $this->show($user, $ticket)->assertOk()->assertJsonPath('activities', $expected);
        foreach ([$previous->email, $next->email, $previous->password, 'secret-history-marker'] as $secret) {
            $this->assertStringNotContainsString($secret, $response->getContent());
        }
        foreach ($response->json('activities') as $activity) {
            $this->assertArrayNotHasKey('changes', $activity);
        }
    }

    public static function staffRoles(): array
    {
        return [['technician'], ['admin']];
    }

    public function test_partial_transitions_distinguish_absent_null_and_missing_references(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket();
        $cases = [
            ['assignment_changed', ['assigned_to' => ['to' => null]], ['assignee' => ['to' => null]]],
            ['assignment_changed', ['assigned_to' => ['from' => null]], ['assignee' => ['from' => null]]],
            ['assignment_changed', ['assigned_to' => ['from' => null, 'to' => 999999]], ['assignee' => ['from' => null, 'to' => ['id' => 999999, 'name' => null]]]],
            ['details_changed', ['category_id' => ['from' => 999998]], ['category' => ['from' => ['id' => 999998, 'name' => null]]]],
            ['details_changed', ['category_id' => ['from' => null, 'to' => 999999]], ['category' => ['from' => null, 'to' => ['id' => 999999, 'name' => null]]]],
            ['status_changed', ['status' => ['to' => 'resolved']], ['status' => ['to' => 'resolved']]],
            ['status_changed', ['status' => ['from' => 'waiting_requester', 'to' => 'cancelled']], ['status' => ['from' => 'waiting_requester', 'to' => 'cancelled']]],
            ['status_changed', ['status' => ['from' => 'resolved', 'to' => 'closed']], ['status' => ['from' => 'resolved', 'to' => 'closed']]],
            ['details_changed', ['priority' => ['from' => 'high', 'to' => null]], ['priority' => ['from' => 'high', 'to' => null]]],
            ['status_changed', ['status' => ['from' => null, 'to' => 'in_progress']], ['status' => ['from' => null, 'to' => 'in_progress']]],
            ['assignment_changed', ['assigned_to' => ['from' => 'invalid', 'to' => null]], ['assignee' => ['to' => null]]],
        ];
        foreach ($cases as [$action, $changes]) {
            $this->activity($ticket, null, $action, $changes);
        }

        $activities = $this->show($admin, $ticket)->assertOk()->json('activities');
        foreach ($cases as $index => [, , $expected]) {
            $this->assertSame($expected, $activities[$index]['details']);
            $this->assertNull($activities[$index]['actor']);
            $this->assertArrayNotHasKey('changes', $activities[$index]);
        }
    }

    #[DataProvider('invalidActivityDetails')]
    public function test_legacy_invalid_or_unauthorized_metadata_preserves_the_original_contract(string $action, mixed $changes): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket();
        $activity = $this->activity($ticket, null, $action);
        // Exercise legacy JSON scalars as well as array-shaped metadata.
        DB::table('ticket_activities')->where('id', $activity->id)->update(['changes' => $changes === null ? null : json_encode($changes, JSON_THROW_ON_ERROR)]);

        $response = $this->show($admin, $ticket)->assertOk()->assertJsonPath('activities', [[
            'id' => $activity->id, 'action' => $action, 'actor' => null, 'created_at' => $activity->created_at->toISOString(),
        ]]);
        $this->assertStringNotContainsString('secret-history-marker', $response->getContent());
    }

    public static function invalidActivityDetails(): array
    {
        return [
            ['assignment_changed', null], ['status_changed', []], ['details_changed', null],
            ['assignment_changed', 'secret-history-marker'], ['assignment_changed', 123], ['details_changed', false],
            ['assignment_changed', ['assigned_to' => 'secret-history-marker']],
            ['assignment_changed', ['assigned_to' => ['from' => true, 'to' => '1']]],
            ['assignment_changed', ['assigned_to' => ['from' => -1, 'to' => 1.5]]],
            ['assignment_changed', ['assigned_to' => ['from' => [], 'to' => ['id' => 1, 'name' => 'secret-history-marker']]]],
            ['assignment_changed', ['priority' => ['from' => 'low', 'to' => 'urgent']]],
            ['status_changed', ['status' => ['from' => 'invalid', 'to' => 'secret-history-marker']]],
            ['status_changed', ['status' => ['from' => ['code' => 'open'], 'to' => false]]],
            ['details_changed', ['category_id' => ['from' => 0, 'to' => false], 'priority' => ['from' => 'secret-history-marker', 'to' => 1]]],
            ['details_changed', ['assigned_to' => ['from' => null, 'to' => 1], 'status' => ['from' => 'open', 'to' => 'closed']]],
            ['created', ['assigned_to' => ['from' => null, 'to' => 1]]],
            ['ticket_created', ['priority' => ['from' => 'low', 'to' => 'high']]],
            ['future_action', ['status' => ['from' => 'open', 'to' => 'closed']]],
            ['comment_added', ['comment_id' => 1, 'is_internal' => true, 'body' => 'secret-history-marker', 'assigned_to' => ['from' => null, 'to' => 1]]],
        ];
    }

    public function test_requester_filter_is_unchanged_and_hidden_events_do_not_trigger_reference_queries(): void
    {
        $ticket = $this->ticket();
        $created = $this->activity($ticket, $this->requester, 'created');
        foreach (['assignment_changed', 'status_changed', 'details_changed', 'comment_added', 'ticket_created', 'future_action', 'created'] as $action) {
            $this->activity($ticket, $this->requester, $action, [
                'assigned_to' => ['from' => null, 'to' => 999999], 'category_id' => ['from' => 999998, 'to' => 999999],
                'status' => ['from' => 'open', 'to' => 'closed'], 'is_internal' => true, 'private' => 'secret-history-marker',
            ]);
        }
        $internal = $this->comment($ticket, $this->requester, true);
        $other = $this->ticket(['requester_id' => User::factory()->create()->id]);
        $this->activity($other, $this->requester, 'created');
        DB::flushQueryLog();
        DB::enableQueryLog();

        $response = $this->show($this->requester, $ticket)->assertOk()->assertJsonCount(1, 'activities')
            ->assertJsonPath('activities.0.id', $created->id)->assertJsonMissingPath('activities.0.details')->assertJsonPath('comments', []);

        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        foreach ($queries as $query) {
            $this->assertNotContains(999999, $query['bindings']);
            $this->assertNotContains(999998, $query['bindings']);
        }
        $this->assertStringNotContainsString('secret-history-marker', $response->getContent());
        $this->assertStringNotContainsString($internal->body, $response->getContent());
        $this->show($this->requester, $other)->assertNotFound();
    }

    public function test_historical_reference_queries_are_batched_and_read_only_as_events_grow(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket();
        $append = function () use ($ticket, $admin): void {
            $technician = User::factory()->create(['role' => 'technician', 'disabled_at' => now()]);
            $category = Category::create(['name' => 'Categoria '.bin2hex(random_bytes(4)), 'is_active' => false]);
            $this->activity($ticket, $admin, 'assignment_changed', ['assigned_to' => ['from' => null, 'to' => $technician->id]]);
            $this->activity($ticket, $admin, 'details_changed', ['category_id' => ['from' => $ticket->category_id, 'to' => $category->id]]);
        };
        $append();
        DB::flushQueryLog();
        DB::enableQueryLog();
        $this->show($admin, $ticket)->assertOk()->assertJsonCount(2, 'activities');
        $initialQueries = DB::getQueryLog();
        DB::disableQueryLog();
        for ($index = 0; $index < 15; $index++) {
            $append();
        }
        $tables = ['users', 'categories', 'tickets', 'ticket_activities', 'ticket_comments', 'ticket_statuses', 'sla_policies', 'sessions'];
        $before = [];
        foreach ($tables as $table) {
            $before[$table] = DB::table($table)->orderBy('id')->get()->toJson();
        }
        DB::flushQueryLog();
        DB::enableQueryLog();

        $this->show($admin, $ticket)->assertOk()->assertJsonCount(32, 'activities');

        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        $this->assertCount(count($initialQueries), $queries);
        $this->assertLessThanOrEqual(12, count($queries));
        $historicalQueries = array_filter($queries, fn (array $query): bool => str_starts_with($query['query'], 'select "id", "name" from') && str_contains($query['query'], 'where "id" in'));
        $this->assertCount(2, $historicalQueries);
        foreach ($queries as $query) {
            $this->assertDoesNotMatchRegularExpression('/^\s*(insert|update|delete|replace|create|alter|drop|truncate)\b/i', $query['query']);
        }
        foreach ($before as $table => $snapshot) {
            $this->assertSame($snapshot, DB::table($table)->orderBy('id')->get()->toJson());
        }
    }

    public function test_real_login_session_can_read_without_writes_or_session_rotation(): void
    {
        $ticket = $this->ticket();
        $this->comment($ticket, $this->requester);
        $this->activity($ticket, $this->requester, 'created');
        $this->postJson('/api/login', ['email' => $this->requester->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $csrfToken = session()->token();
        $tables = ['users', 'tickets', 'ticket_comments', 'ticket_activities', 'categories', 'ticket_statuses', 'sla_policies', 'sessions'];
        $before = [];
        foreach ($tables as $table) {
            $before[$table] = DB::table($table)->orderBy('id')->get()->toJson();
        }
        Auth::forgetGuards();
        DB::enableQueryLog();

        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
            ->getJson('/api/tickets/'.$ticket->id)->assertOk()->assertJsonPath('id', $ticket->id);

        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        foreach ($queries as $query) {
            $this->assertDoesNotMatchRegularExpression('/^\s*(insert|update|delete|replace|create|alter|drop|truncate)\b/i', $query['query']);
            $this->assertStringNotContainsString('personal_access_tokens', $query['query']);
        }
        foreach ($before as $table => $snapshot) {
            $this->assertSame($snapshot, DB::table($table)->orderBy('id')->get()->toJson());
        }
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($csrfToken, session()->token());
        $this->assertFalse(Schema::hasTable('personal_access_tokens'));
    }

    public function test_user_disabled_after_login_loses_detail_access(): void
    {
        $ticket = $this->ticket();
        $this->postJson('/api/login', ['email' => $this->requester->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $this->requester->update(['disabled_at' => now()]);
        Auth::forgetGuards();

        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
            ->getJson('/api/tickets/'.$ticket->id)->assertForbidden();
    }

    public function test_route_uses_sanctum_before_active_user_check_without_unscoped_model_binding(): void
    {
        $route = Route::getRoutes()->match(Request::create('/api/tickets/8', 'GET'));
        $middleware = Route::gatherRouteMiddleware($route);
        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(
            array_search(EnsureUserIsActive::class, $middleware, true),
            array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true),
        );
        $this->assertSame(['id'], $route->parameterNames());
    }

    private function ticket(array $overrides = []): Ticket
    {
        return Ticket::create(array_replace([
            'requester_id' => $this->requester->id,
            'assigned_to' => null,
            'category_id' => Category::firstOrFail()->id,
            'status_id' => TicketStatus::where('code', 'open')->sole()->id,
            'sla_policy_id' => SlaPolicy::where('priority', 'medium')->sole()->id,
            'title' => 'Solicitação de suporte',
            'description' => 'Descrição persistida do chamado',
            'priority' => 'medium',
            'first_response_due_at' => now()->addHours(4),
            'resolution_due_at' => now()->addDay(),
        ], $overrides));
    }

    private function comment(Ticket $ticket, User $author, bool $internal = false, mixed $createdAt = null): TicketComment
    {
        $comment = new TicketComment([
            'user_id' => $author->id, 'body' => ($internal ? 'Interno ' : 'Público ').bin2hex(random_bytes(4)),
            'is_internal' => $internal,
        ]);
        $comment->created_at = $createdAt ?? now();
        $ticket->comments()->save($comment);

        return $comment;
    }

    private function activity(Ticket $ticket, ?User $actor, string $action, ?array $changes = null, mixed $createdAt = null): TicketActivity
    {
        $activity = new TicketActivity([
            'actor_id' => $actor?->id, 'action' => $action, 'changes' => $changes,
        ]);
        $activity->created_at = $createdAt ?? now();
        $ticket->activities()->save($activity);

        return $activity;
    }

    private function show(User $user, Ticket $ticket): TestResponse
    {
        return $this->actingAs($user, 'web')->getJson('/api/tickets/'.$ticket->id);
    }

    private function expectedTicket(Ticket $ticket): array
    {
        $ticket->refresh();

        return [
            'id' => $ticket->id, 'title' => $ticket->title, 'description' => $ticket->description, 'priority' => $ticket->priority,
            'requester' => $ticket->requester->only(['id', 'name']),
            'assignee' => $ticket->assignee?->only(['id', 'name']),
            'category' => $ticket->category->only(['id', 'name']),
            'status' => $ticket->status->only(['id', 'code', 'name']),
            'created_at' => $ticket->created_at->toISOString(), 'updated_at' => $ticket->updated_at->toISOString(),
            'first_response_due_at' => $ticket->first_response_due_at->toISOString(),
            'resolution_due_at' => $ticket->resolution_due_at->toISOString(),
            'first_responded_at' => $ticket->first_responded_at?->toISOString(),
            'resolved_at' => $ticket->resolved_at?->toISOString(), 'closed_at' => $ticket->closed_at?->toISOString(),
            'comments' => [], 'activities' => [],
        ];
    }
}
