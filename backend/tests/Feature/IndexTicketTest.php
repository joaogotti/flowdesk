<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Models\Category;
use App\Models\SlaPolicy;
use App\Models\Ticket;
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
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class IndexTicketTest extends TestCase
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

        $migration = require database_path('migrations/2026_10_19_200056_create_ticket_activities_table.php');
        $migration->up();

        $this->seed([TicketStatusSeeder::class, SlaPolicySeeder::class, CategorySeeder::class]);
        $this->user = User::factory()->create(['role' => 'requester']);
        $this->category = Category::firstOrFail();
        $this->travelTo(Carbon::parse('2026-10-23 23:50:00', 'UTC'));
        config(['sanctum.stateful' => ['localhost:5173']]);
        $this->withHeader('Origin', 'http://localhost:5173');
    }

    public function test_requester_sees_only_own_tickets_and_scoped_totals(): void
    {
        $other = User::factory()->create(['role' => 'requester']);
        $own = $this->ticket();
        $this->ticket(['requester_id' => $other->id]);
        $second = $this->ticket();

        $this->listing($this->user, ['per_page' => 1])->assertOk()
            ->assertJsonPath('total', 2)->assertJsonPath('last_page', 2)->assertJsonPath('data.0.id', $second->id);
        $this->listing($this->user, ['page' => 2, 'per_page' => 1])->assertOk()
            ->assertJsonPath('data.0.id', $own->id);
    }

    public function test_technician_sees_own_assignments_and_unassigned_but_not_other_assignments(): void
    {
        $tech = User::factory()->create(['role' => 'technician']);
        $otherTech = User::factory()->create(['role' => 'technician']);
        $assigned = $this->ticket(['assigned_to' => $tech->id]);
        $unassigned = $this->ticket();
        $this->ticket(['assigned_to' => $otherTech->id]);
        // Mesmo sendo solicitante, o técnico não vê um chamado atribuído a outro técnico.
        $this->ticket(['requester_id' => $tech->id, 'assigned_to' => $otherTech->id]);

        $response = $this->listing($tech)->assertOk()->assertJsonPath('total', 2);
        $this->assertSame([$unassigned->id, $assigned->id], array_column($response->json('data'), 'id'));
        $response->assertJsonPath('data.0.assignee', null)
            ->assertJsonPath('data.1.assignee', ['id' => $tech->id, 'name' => $tech->name]);
    }

    public function test_admin_sees_all_tickets_and_can_filter_by_technician(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $tech = User::factory()->create(['role' => 'technician']);
        $other = User::factory()->create(['role' => 'requester']);
        $assigned = $this->ticket(['assigned_to' => $tech->id]);
        $this->ticket(['requester_id' => $other->id]);

        $this->listing($admin)->assertOk()->assertJsonPath('total', 2);
        $this->listing($admin, ['assigned_to' => $tech->id])->assertOk()
            ->assertJsonPath('total', 1)->assertJsonPath('data.0.id', $assigned->id);
    }

    #[DataProvider('nonAdminRoles')]
    public function test_non_admin_cannot_use_assigned_to_filter(string $role): void
    {
        $this->user->update(['role' => $role]);
        $tech = User::factory()->create(['role' => 'technician']);
        $this->listing($this->user, ['assigned_to' => $tech->id])
            ->assertUnprocessable()->assertJsonValidationErrors('assigned_to');
        $this->listing($this->user, ['assigned_to' => ''])
            ->assertUnprocessable()->assertJsonValidationErrors('assigned_to');
    }

    public static function nonAdminRoles(): array
    {
        return [['requester'], ['technician']];
    }

    #[DataProvider('individualFilters')]
    public function test_individual_filters(string $field, string $value): void
    {
        $target = $this->ticket(['priority' => 'high']);
        $otherCategory = Category::where('id', '!=', $this->category->id)->firstOrFail();
        $this->ticket([
            'priority' => 'low',
            'status_id' => TicketStatus::where('code', 'in_progress')->sole()->id,
            'category_id' => $otherCategory->id,
        ]);
        $filter = $field === 'category_id' ? $this->category->id : $value;

        $this->listing($this->user, [$field => $filter])->assertOk()
            ->assertJsonPath('total', 1)->assertJsonPath('data.0.id', $target->id);
    }

    public static function individualFilters(): array
    {
        return [['status', 'open'], ['priority', 'high'], ['category_id', 'first']];
    }

    public function test_filters_combine_using_and_without_escaping_technician_scope(): void
    {
        $tech = User::factory()->create(['role' => 'technician']);
        $otherTech = User::factory()->create(['role' => 'technician']);
        $target = $this->ticket(['priority' => 'high', 'title' => 'Falha de rede']);
        $this->ticket(['priority' => 'high', 'title' => 'Falha de rede', 'assigned_to' => $otherTech->id]);
        $this->ticket(['priority' => 'low', 'title' => 'Falha de rede', 'assigned_to' => $tech->id]);
        $this->ticket(['priority' => 'high', 'title' => 'Falha de rede', 'status_id' => TicketStatus::where('code', 'closed')->sole()->id]);
        $this->ticket(['priority' => 'high', 'title' => 'Falha de rede', 'category_id' => Category::where('id', '!=', $this->category->id)->firstOrFail()->id]);

        $this->listing($tech, ['status' => 'open', 'priority' => 'high', 'category_id' => $this->category->id, 'search' => 'REDE'])
            ->assertOk()->assertJsonPath('total', 1)->assertJsonPath('data.0.id', $target->id);
    }

    public function test_admin_can_combine_assignment_with_other_filters(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $tech = User::factory()->create(['role' => 'technician']);
        $target = $this->ticket(['assigned_to' => $tech->id, 'priority' => 'urgent']);
        $this->ticket(['assigned_to' => $tech->id, 'priority' => 'low']);
        $this->ticket(['priority' => 'urgent']);
        $this->listing($admin, ['assigned_to' => $tech->id, 'priority' => 'urgent', 'status' => 'open'])
            ->assertOk()->assertJsonPath('total', 1)->assertJsonPath('data.0.id', $target->id);
    }

    public function test_title_or_description_search_does_not_escape_requester_scope(): void
    {
        $other = User::factory()->create(['role' => 'requester']);
        $title = $this->ticket(['title' => 'Falha na impressora']);
        $description = $this->ticket(['description' => 'A impressora nao responde.']);
        $this->ticket(['requester_id' => $other->id, 'description' => 'impressora']);
        $this->ticket(['title' => 'Sem correspondencia']);

        $response = $this->listing($this->user, ['search' => 'IMPRESS'])->assertOk()->assertJsonPath('total', 2);
        $this->assertSame([$description->id, $title->id], array_column($response->json('data'), 'id'));
    }

    #[DataProvider('specialSearches')]
    public function test_search_is_bound_and_wildcards_are_literal(string $search): void
    {
        $target = $this->ticket(['title' => 'Texto '.$search.' final']);
        $this->ticket(['title' => 'Outro texto qualquer']);
        $this->listing($this->user, ['search' => $search])->assertOk()
            ->assertJsonPath('total', 1)->assertJsonPath('data.0.id', $target->id);
    }

    public static function specialSearches(): array
    {
        return [["' OR 1=1 --"], ['%'], ['_'], ['!'], ['\\']];
    }

    public function test_unknown_parameters_cannot_override_visibility_or_sort(): void
    {
        $other = User::factory()->create(['role' => 'requester']);
        $own = $this->ticket();
        $this->ticket(['requester_id' => $other->id]);
        $this->listing($this->user, ['requester_id' => $other->id, 'role' => 'admin', 'sort' => 'id', 'include' => 'requester.password'])
            ->assertOk()->assertJsonPath('total', 1)->assertJsonPath('data.0.id', $own->id);
    }

    public function test_default_pagination_and_stable_creation_date_order(): void
    {
        $ids = [];
        for ($index = 0; $index < 17; $index++) {
            $ids[] = $this->ticket()->id;
        }
        $older = $this->ticket();
        $older->created_at = now()->subDay();
        $older->save();

        $response = $this->listing($this->user)->assertOk()->assertJsonCount(15, 'data')
            ->assertJsonPath('current_page', 1)->assertJsonPath('per_page', 15)
            ->assertJsonPath('total', 18)->assertJsonPath('last_page', 2);
        $this->assertSame(array_slice(array_reverse($ids), 0, 15), array_column($response->json('data'), 'id'));
        $response = $this->listing($this->user, ['page' => 2])->assertOk()->assertJsonCount(3, 'data');
        $this->assertSame([$ids[1], $ids[0], $older->id], array_column($response->json('data'), 'id'));
        $this->listing($this->user, ['page' => 3])->assertOk()->assertJsonCount(0, 'data')->assertJsonPath('total', 18);
    }

    public function test_per_page_maximum_is_accepted_and_filters_survive_pagination_links(): void
    {
        for ($index = 0; $index < 101; $index++) {
            $this->ticket();
        }
        $response = $this->listing($this->user, ['per_page' => 100, 'priority' => 'medium'])->assertOk()
            ->assertJsonCount(100, 'data')->assertJsonPath('total', 101)->assertJsonPath('last_page', 2);
        parse_str(parse_url($response->json('next_page_url'), PHP_URL_QUERY), $query);
        ksort($query);
        $this->assertSame(['page' => '2', 'per_page' => '100', 'priority' => 'medium'], $query);
    }

    public function test_empty_listing_returns_native_pagination_metadata(): void
    {
        $this->listing($this->user)->assertOk()->assertJsonPath('data', [])
            ->assertJsonPath('current_page', 1)->assertJsonPath('last_page', 1)->assertJsonPath('total', 0);
    }

    public function test_inactive_categories_and_disabled_assignees_can_filter_historical_tickets(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $tech = User::factory()->create(['role' => 'technician', 'disabled_at' => now()]);
        $this->category->update(['is_active' => false]);
        $target = $this->ticket(['assigned_to' => $tech->id]);
        $this->listing($admin, ['assigned_to' => $tech->id, 'category_id' => $this->category->id])->assertOk()
            ->assertJsonPath('total', 1)->assertJsonPath('data.0.id', $target->id);
    }

    #[DataProvider('invalidFilters')]
    public function test_invalid_parameters_return_422(array $filters, string $field): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $this->listing($admin, $filters)->assertUnprocessable()->assertJsonValidationErrors($field);
    }

    public static function invalidFilters(): array
    {
        return [
            [['status' => 'unknown'], 'status'],
            [['status' => ['open']], 'status'],
            [['status' => ''], 'status'],
            [['priority' => 'critical'], 'priority'],
            [['priority' => ['high']], 'priority'],
            [['category_id' => 999], 'category_id'],
            [['category_id' => -1], 'category_id'],
            [['category_id' => 'text'], 'category_id'],
            [['assigned_to' => 999], 'assigned_to'],
            [['assigned_to' => -1], 'assigned_to'],
            [['assigned_to' => 'text'], 'assigned_to'],
            [['search' => ['text']], 'search'],
            [['search' => str_repeat('a', 256)], 'search'],
            [['search' => ''], 'search'],
            [['page' => 0], 'page'],
            [['page' => -1], 'page'],
            [['page' => '1.5'], 'page'],
            [['page' => ['1']], 'page'],
            [['per_page' => 0], 'per_page'],
            [['per_page' => 101], 'per_page'],
            [['per_page' => 'many'], 'per_page'],
            [['per_page' => ['15']], 'per_page'],
        ];
    }

    public function test_assignment_filter_requires_a_technician_not_just_an_existing_user(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        foreach ([$admin, $this->user] as $nonTechnician) {
            $this->listing($admin, ['assigned_to' => $nonTechnician->id])
                ->assertUnprocessable()->assertJsonValidationErrors('assigned_to');
        }
    }

    public function test_response_contains_only_public_fields_with_no_n_plus_one_queries(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $tech = User::factory()->create(['role' => 'technician', 'remember_token' => 'private']);
        $tickets = [];
        for ($index = 0; $index < 5; $index++) {
            $requester = User::factory()->create(['role' => 'requester', 'remember_token' => 'private']);
            $tickets[] = $this->ticket(['requester_id' => $requester->id, 'assigned_to' => $tech->id]);
        }
        DB::enableQueryLog();
        $response = $this->listing($admin, ['per_page' => 1])->assertOk();
        $firstQueryCount = count(DB::getQueryLog());
        DB::flushQueryLog();
        $allResponse = $this->listing($admin, ['per_page' => 5])->assertOk();
        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        $this->assertSame($firstQueryCount, count($queries));
        $ticket = $tickets[4];
        $this->assertSame([
            'id' => $ticket->id,
            'title' => $ticket->title,
            'priority' => $ticket->priority,
            'status' => $ticket->status->only(['id', 'code', 'name']),
            'category' => $ticket->category->only(['id', 'name']),
            'requester' => $ticket->requester->only(['id', 'name']),
            'assignee' => ['id' => $tech->id, 'name' => $tech->name],
            'created_at' => $ticket->created_at->toISOString(),
            'first_response_due_at' => $ticket->first_response_due_at->toISOString(),
            'resolution_due_at' => $ticket->resolution_due_at->toISOString(),
        ], $response->json('data.0'));
        foreach ($allResponse->json('data') as $item) {
            $this->assertSame(['id', 'name'], array_keys($item['requester']));
            $this->assertSame(['id', 'name'], array_keys($item['assignee']));
        }
        foreach ($queries as $query) {
            $this->assertDoesNotMatchRegularExpression('/^\s*(insert|update|delete|replace|create|alter|drop|truncate)\b/i', $query['query']);
            $this->assertStringNotContainsString('personal_access_tokens', $query['query']);
        }
        $this->assertFalse(Schema::hasTable('personal_access_tokens'));
    }

    public function test_guest_and_disabled_users_cannot_list_even_with_invalid_filters(): void
    {
        $this->getJson('/api/tickets?per_page=101')->assertUnauthorized();
        $this->user->update(['disabled_at' => now()]);
        $this->listing($this->user, ['per_page' => 101])->assertForbidden()
            ->assertExactJson(['message' => 'Acesso não permitido.']);
    }

    public function test_user_disabled_after_login_loses_listing_access(): void
    {
        $this->postJson('/api/login', ['email' => $this->user->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $this->user->update(['disabled_at' => now()]);
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)->getJson('/api/tickets')->assertForbidden();
    }

    public function test_existing_session_can_list_without_changing_records_or_rotating_session(): void
    {
        $ticket = $this->ticket();
        $this->postJson('/api/login', ['email' => $this->user->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $csrfToken = session()->token();
        $before = [];
        foreach (['users', 'tickets', 'ticket_activities', 'categories', 'ticket_statuses', 'sla_policies'] as $table) {
            $before[$table] = DB::table($table)->orderBy('id')->get()->toJson();
        }
        Auth::forgetGuards();

        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)->getJson('/api/tickets')
            ->assertOk()->assertJsonPath('data.0.id', $ticket->id);

        foreach ($before as $table => $snapshot) {
            $this->assertSame($snapshot, DB::table($table)->orderBy('id')->get()->toJson());
        }
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($csrfToken, session()->token());
    }

    public function test_unknown_role_cannot_list(): void
    {
        $this->user->update(['role' => 'unknown']);
        $this->listing($this->user)->assertForbidden();
    }

    public function test_route_uses_sanctum_before_the_active_user_middleware(): void
    {
        $route = Route::getRoutes()->match(Request::create('/api/tickets', 'GET'));
        $middleware = Route::gatherRouteMiddleware($route);
        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(
            array_search(EnsureUserIsActive::class, $middleware, true),
            array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true),
        );
    }

    private function ticket(array $overrides = []): Ticket
    {
        return Ticket::create(array_replace([
            'requester_id' => $this->user->id,
            'assigned_to' => null,
            'category_id' => $this->category->id,
            'status_id' => TicketStatus::where('code', 'open')->sole()->id,
            'sla_policy_id' => SlaPolicy::where('priority', 'medium')->sole()->id,
            'title' => 'Solicitacao de suporte',
            'description' => 'Descricao do chamado',
            'priority' => 'medium',
            'first_response_due_at' => now()->addMinutes(240),
            'resolution_due_at' => now()->addMinutes(1440),
        ], $overrides));
    }

    private function listing(User $user, array $filters = []): TestResponse
    {
        return $this->actingAs($user, 'web')->getJson('/api/tickets?'.http_build_query($filters));
    }
}
