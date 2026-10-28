<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Http\Requests\StoreTicketCommentRequest;
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
use RuntimeException;
use Tests\TestCase;

class StoreTicketCommentTest extends TestCase
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
        });
        $migration = require database_path('migrations/2026_10_19_194356_create_categories_table.php');
        $migration->up();

        // Mesmo isolamento da suíte existente, sem os CHECKs exclusivos do PostgreSQL.
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

    #[DataProvider('roles')]
    public function test_public_comment_uses_persisted_values_and_exact_safe_json(string $role): void
    {
        $user = $this->actor($role);
        $ticket = $this->ticket();
        $before = $ticket->fresh()->getAttributes();

        $response = $this->postComment($user, $ticket, ['body' => "  Já reiniciei.\nO problema continua.  "])->assertCreated();

        $comment = TicketComment::sole();
        $this->assertSame('Já reiniciei.'."\n".'O problema continua.', $comment->body);
        $this->assertFalse($comment->is_internal);
        $this->assertSame($user->id, $comment->user_id);
        $this->assertSame($ticket->id, $comment->ticket_id);
        $response->assertHeader('Content-Type', 'application/json')->assertExactJson([
            'id' => $comment->id, 'body' => $comment->body, 'is_internal' => false,
            'author' => $user->only(['id', 'name']), 'created_at' => $comment->created_at->toISOString(),
        ]);
        $activity = TicketActivity::sole();
        $this->assertSame($ticket->id, $activity->ticket_id);
        $this->assertSame($user->id, $activity->actor_id);
        $this->assertSame('comment_added', $activity->action);
        $this->assertSame(['comment_id' => $comment->id, 'is_internal' => false], $activity->changes);
        $this->assertTrue($activity->created_at->equalTo($comment->created_at));
        $this->assertStringNotContainsString($comment->body, json_encode($activity->changes));
        $after = $ticket->fresh()->getAttributes();
        if ($role === 'requester') {
            $this->assertSame($before, $after);
            $this->assertNull($ticket->fresh()->first_responded_at);
        } else {
            $this->assertTrue($ticket->fresh()->first_responded_at->equalTo(now()));
            unset($before['first_responded_at'], $before['updated_at'], $after['first_responded_at'], $after['updated_at']);
            $this->assertSame($before, $after);
        }
        $this->assertFalse(Schema::hasTable('personal_access_tokens'));
    }

    public static function roles(): array
    {
        return [['requester'], ['technician'], ['admin']];
    }

    public function test_assigned_technician_can_create_a_public_comment(): void
    {
        $technician = $this->actor('technician');
        $ticket = $this->ticket(['assigned_to' => $technician->id]);

        $this->postComment($technician, $ticket, ['body' => 'Em atendimento.', 'is_internal' => false])->assertCreated();
        $this->assertSame($technician->id, TicketComment::sole()->user_id);
        $this->assertSame($technician->id, $ticket->fresh()->assigned_to);
    }

    #[DataProvider('staffRoles')]
    public function test_staff_can_create_internal_comments_without_touching_ticket_or_first_response(string $role): void
    {
        $staff = $this->actor($role);
        $ticket = $this->ticket();
        $before = $ticket->fresh()->getAttributes();
        $this->travel(5)->minutes();

        $this->postComment($staff, $ticket, ['body' => 'Verificação interna.', 'is_internal' => true])
            ->assertCreated()->assertJsonPath('is_internal', true);

        $this->assertTrue(TicketComment::sole()->is_internal);
        $this->assertSame(['comment_id' => TicketComment::sole()->id, 'is_internal' => true], TicketActivity::sole()->changes);
        $this->assertSame($before, $ticket->fresh()->getAttributes());
    }

    public static function staffRoles(): array
    {
        return [['technician'], ['admin']];
    }

    public function test_requester_cannot_create_internal_comments_even_with_invalid_body(): void
    {
        $ticket = $this->ticket();
        $before = $this->snapshot();

        foreach (['Comentário interno.', ''] as $body) {
            $this->postComment($this->requester, $ticket, ['body' => $body, 'is_internal' => true])
                ->assertForbidden()->assertExactJson(['message' => 'Somente técnicos e administradores podem criar comentários internos.']);
        }
        $this->assertSame($before, $this->snapshot());
    }

    public function test_requester_cannot_comment_on_another_ticket_before_input_validation(): void
    {
        $other = User::factory()->create(['role' => 'requester']);
        $ticket = $this->ticket(['requester_id' => $other->id]);
        $before = $this->snapshot();

        foreach ([[], ['body' => 'Texto', 'is_internal' => true]] as $payload) {
            $this->postComment($this->requester, $ticket, $payload)->assertNotFound()
                ->assertExactJson(['message' => 'Chamado não encontrado.']);
        }
        $this->assertSame($before, $this->snapshot());
    }

    public function test_technician_cannot_comment_on_another_assignment_even_as_requester(): void
    {
        $technician = $this->actor('technician');
        $other = $this->actor('technician');
        foreach ([$this->requester->id, $technician->id] as $requesterId) {
            $ticket = $this->ticket(['requester_id' => $requesterId, 'assigned_to' => $other->id]);
            $before = $this->snapshot();
            $this->postComment($technician, $ticket, ['body' => 'Texto'])->assertNotFound();
            $this->assertSame($before, $this->snapshot());
        }
    }

    public function test_admin_can_comment_on_ticket_assigned_to_another_technician(): void
    {
        $ticket = $this->ticket(['assigned_to' => $this->actor('technician')->id]);

        $this->postComment($this->actor('admin'), $ticket, ['body' => 'Resposta pública.'])->assertCreated();
    }

    #[DataProvider('roles')]
    public function test_missing_ticket_returns_404_before_input_validation(string $role): void
    {
        $user = $this->actor($role);
        $before = $this->snapshot();

        $this->actingAs($user, 'web')->postJson('/api/tickets/999999/comments', [])
            ->assertNotFound()->assertExactJson(['message' => 'Chamado não encontrado.']);
        $this->assertSame($before, $this->snapshot());
    }

    #[DataProvider('invalidIds')]
    public function test_invalid_id_returns_404_without_writes(string $id): void
    {
        $before = $this->snapshot();
        $this->actingAs($this->requester, 'web')->postJson('/api/tickets/'.$id.'/comments', ['body' => 'Texto'])->assertNotFound();
        $this->assertSame($before, $this->snapshot());
    }

    public static function invalidIds(): array
    {
        return [['0'], ['-1'], ['abc'], ['9223372036854775808']];
    }

    public function test_guest_receives_401_even_with_invalid_input(): void
    {
        $ticket = $this->ticket();
        $before = $this->snapshot();

        $this->postJson('/api/tickets/'.$ticket->id.'/comments', [])->assertUnauthorized();
        $this->postJson('/api/tickets/999999/comments', [])->assertUnauthorized();
        $this->assertSame($before, $this->snapshot());
    }

    #[DataProvider('roles')]
    public function test_disabled_user_receives_403_before_input_validation(string $role): void
    {
        $user = $this->actor($role);
        $user->update(['disabled_at' => now()]);
        $ticket = $this->ticket(['requester_id' => $user->id]);
        $before = $this->snapshot();

        $this->postComment($user, $ticket, [])->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
        $this->assertSame($before, $this->snapshot());
    }

    public function test_unknown_role_cannot_gain_visibility_by_owning_the_ticket(): void
    {
        $user = User::factory()->create(['role' => 'unknown']);
        $ticket = $this->ticket(['requester_id' => $user->id]);
        $before = $this->snapshot();

        $this->postComment($user, $ticket, ['body' => 'Texto'])->assertNotFound();
        $this->assertSame($before, $this->snapshot());
    }

    #[DataProvider('rejectedStatuses')]
    public function test_terminal_status_returns_409_without_writes(string $role, string $status): void
    {
        $user = $this->actor($role);
        $ticket = $this->ticket(['status_id' => TicketStatus::where('code', $status)->sole()->id]);
        $before = $this->snapshot();

        $this->postComment($user, $ticket, ['body' => 'Não deve persistir.'])->assertStatus(409)
            ->assertExactJson(['message' => 'Não é possível adicionar comentários a chamados neste status.']);
        $this->assertSame($before, $this->snapshot());
    }

    public static function rejectedStatuses(): array
    {
        $cases = [];
        foreach (['requester', 'technician', 'admin'] as $role) {
            foreach (['resolved', 'closed', 'cancelled'] as $status) {
                $cases[] = [$role, $status];
            }
        }

        return $cases;
    }

    #[DataProvider('acceptingStatuses')]
    public function test_accepting_status_is_preserved_after_a_comment(string $status): void
    {
        $statusId = TicketStatus::where('code', $status)->sole()->id;
        $ticket = $this->ticket(['status_id' => $statusId]);

        $this->postComment($this->requester, $ticket, ['body' => 'Informação pública.'])->assertCreated();
        $this->assertSame($statusId, $ticket->fresh()->status_id);
    }

    public static function acceptingStatuses(): array
    {
        return [['open'], ['in_progress'], ['waiting_requester']];
    }

    #[DataProvider('invalidBodies')]
    public function test_invalid_body_is_rejected_without_writes(array $payload): void
    {
        $ticket = $this->ticket();
        $before = $this->snapshot();

        $this->postComment($this->requester, $ticket, $payload)->assertUnprocessable()->assertJsonValidationErrors('body');
        $this->assertSame($before, $this->snapshot());
    }

    public static function invalidBodies(): array
    {
        return [[[]], [['body' => null]], [['body' => '']], [['body' => " \t\n\r "]], [['body' => "\u{00a0}\u{2003}"]],
            [['body' => false]], [['body' => 123]], [['body' => ['Texto']]], [['body' => str_repeat('á', 10001)]],
            [['body' => "Texto\0inválido"]]];
    }

    public function test_body_limit_counts_characters_and_trims_unicode_whitespace(): void
    {
        $ticket = $this->ticket();
        $body = str_repeat('á', 10000);

        $this->postComment($this->requester, $ticket, ['body' => "\u{00a0}".$body."\u{2003}"])
            ->assertCreated()->assertJsonPath('body', $body);
        $this->assertSame($body, TicketComment::sole()->body);
    }

    #[DataProvider('invalidInternalFlags')]
    public function test_is_internal_accepts_only_json_booleans(mixed $value): void
    {
        $admin = $this->actor('admin');
        $ticket = $this->ticket();
        $before = $this->snapshot();

        $this->postComment($admin, $ticket, ['body' => 'Texto', 'is_internal' => $value])
            ->assertUnprocessable()->assertJsonValidationErrors('is_internal');
        $this->assertSame($before, $this->snapshot());
    }

    public static function invalidInternalFlags(): array
    {
        return [[null], [0], [1], ['0'], ['1'], ['true'], ['false'], ['yes'], [[]], [['is_internal' => true]]];
    }

    public function test_client_cannot_choose_author_ticket_or_other_controlled_fields(): void
    {
        $admin = $this->actor('admin');
        $ticket = $this->ticket();
        $other = $this->ticket();
        $before = $ticket->fresh()->getAttributes();
        $usersBefore = DB::table('users')->orderBy('id')->get()->toJson();

        $this->postComment($this->requester, $ticket, [
            'body' => 'Resposta do solicitante.', 'is_internal' => false,
            'user_id' => $admin->id, 'author_id' => $admin->id, 'actor_id' => $admin->id,
            'ticket_id' => $other->id, 'requester_id' => $admin->id, 'role' => 'admin',
            'first_responded_at' => now()->toISOString(), 'created_at' => '2000-01-01T00:00:00Z',
            'status_id' => TicketStatus::where('code', 'closed')->sole()->id, 'assigned_to' => $admin->id,
            'priority' => 'urgent', 'category_id' => 999, 'changes' => ['body' => 'Conteúdo controlado'],
        ])->assertCreated()->assertJsonPath('author.id', $this->requester->id)->assertJsonPath('created_at', now()->toISOString());

        $this->assertSame($this->requester->id, TicketComment::sole()->user_id);
        $this->assertSame($ticket->id, TicketComment::sole()->ticket_id);
        $this->assertSame($this->requester->id, TicketActivity::sole()->actor_id);
        $this->assertSame($before, $ticket->fresh()->getAttributes());
        $this->assertSame($usersBefore, DB::table('users')->orderBy('id')->get()->toJson());
        $this->assertCount(0, $other->fresh()->comments);
    }

    #[DataProvider('staffRoles')]
    public function test_only_first_public_staff_comment_sets_first_response_and_later_comments_never_overwrite_it(string $role): void
    {
        $staff = $this->actor($role);
        $ticket = $this->ticket();
        $before = $ticket->fresh()->getAttributes();
        $this->postComment($this->requester, $ticket, ['body' => 'Mais informações.'])->assertCreated();
        $this->assertNull($ticket->fresh()->first_responded_at);
        $this->travel(2)->minutes();
        $this->postComment($staff, $ticket, ['body' => 'Nota privada.', 'is_internal' => true])->assertCreated();
        $this->assertSame($before, $ticket->fresh()->getAttributes());
        $this->travel(3)->minutes();
        $firstResponse = now()->toISOString();

        $this->postComment($staff, $ticket, ['body' => 'Primeira resposta pública.'])->assertCreated()
            ->assertJsonPath('created_at', $firstResponse);
        $this->assertSame($firstResponse, $ticket->fresh()->first_responded_at->toISOString());
        $afterFirst = $ticket->fresh()->getAttributes();
        foreach ([[$staff, false], [$this->requester, false], [$staff, true]] as [$user, $internal]) {
            $this->travel(5)->minutes();
            $this->postComment($user, $ticket, ['body' => 'Comentário posterior.', 'is_internal' => $internal])->assertCreated();
            $this->assertSame($afterFirst, $ticket->fresh()->getAttributes());
        }
        unset($before['first_responded_at'], $before['updated_at'], $afterFirst['first_responded_at'], $afterFirst['updated_at']);
        $this->assertSame($before, $afterFirst);
    }

    #[DataProvider('staffRoles')]
    public function test_internal_comment_is_invisible_in_requester_detail_history_and_list_even_via_timestamps(string $role): void
    {
        $staff = $this->actor($role);
        $ticket = $this->ticket();
        $ticket->activities()->create(['actor_id' => $this->requester->id, 'action' => 'created', 'changes' => null]);
        $before = $this->detail($this->requester, $ticket)->assertOk()->json();
        $listBefore = $this->getJson('/api/tickets')->assertOk()->json();
        $this->travel(10)->minutes();

        $response = $this->postComment($staff, $ticket, ['body' => 'Conteúdo interno confidencial.', 'is_internal' => true])->assertCreated();

        $this->detail($this->requester, $ticket)->assertOk()->assertExactJson($before);
        $this->getJson('/api/tickets')->assertOk()->assertExactJson($listBefore);
        $staffDetail = $this->detail($staff, $ticket)->assertOk()
            ->assertJsonCount(1, 'comments')->assertJsonPath('comments.0.id', $response->json('id'))
            ->assertJsonPath('comments.0.is_internal', true)->assertJsonCount(2, 'activities');
        foreach ($staffDetail->json('activities') as $activity) {
            $this->assertArrayNotHasKey('changes', $activity);
        }
        $this->postComment($staff, $ticket, ['body' => 'Resposta pública visível.'])->assertCreated();
        $this->detail($this->requester, $ticket)->assertOk()
            ->assertJsonCount(1, 'comments')->assertJsonPath('comments.0.body', 'Resposta pública visível.')
            ->assertJsonMissingPath('comments.0.is_internal')->assertJsonCount(1, 'activities');
    }

    #[DataProvider('failureStages')]
    public function test_transaction_rolls_back_comment_activity_and_first_response_on_any_failure(string $model, string $event): void
    {
        $staff = $this->actor('technician');
        $ticket = $this->ticket();
        $before = $this->snapshot();
        $this->withoutExceptionHandling();
        $model::$event(function (): void {
            throw new RuntimeException('Simulated write failure');
        });

        try {
            $this->postComment($staff, $ticket, ['body' => 'Nada deve persistir.']);
            $this->fail('Expected an atomic write failure.');
        } catch (RuntimeException $exception) {
            $this->assertSame('Simulated write failure', $exception->getMessage());
        } finally {
            $model::flushEventListeners();
        }
        $this->assertSame($before, $this->snapshot());
        $this->assertSame(0, DB::transactionLevel());
    }

    public static function failureStages(): array
    {
        return [[TicketComment::class, 'created'], [TicketActivity::class, 'created'], [Ticket::class, 'updated']];
    }

    public function test_existing_login_session_can_comment_without_rotating_session_or_creating_tokens(): void
    {
        $ticket = $this->ticket();
        $this->postJson('/api/login', ['email' => $this->requester->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $csrfToken = session()->token();
        $usersBefore = DB::table('users')->orderBy('id')->get()->toJson();
        Auth::forgetGuards();

        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
            ->postJson('/api/tickets/'.$ticket->id.'/comments', ['body' => 'Comentário autenticado.'])->assertCreated();

        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($csrfToken, session()->token());
        $this->assertSame($usersBefore, DB::table('users')->orderBy('id')->get()->toJson());
        $this->assertFalse(Schema::hasTable('personal_access_tokens'));
    }

    public function test_stateful_comment_requires_csrf_outside_test_bypass(): void
    {
        $ticket = $this->ticket();
        $this->postJson('/api/login', ['email' => $this->requester->email, 'password' => 'password'])->assertOk();
        $csrfToken = session()->token();
        $this->app->instance('env', 'local');
        $before = $this->snapshot();

        $this->postJson('/api/tickets/'.$ticket->id.'/comments', ['body' => 'Texto'])->assertStatus(419);
        $this->assertSame($before, $this->snapshot());
        $this->withHeader('X-CSRF-TOKEN', $csrfToken)->postJson('/api/tickets/'.$ticket->id.'/comments', ['body' => 'Texto'])->assertCreated();
    }

    public function test_user_disabled_after_login_cannot_comment(): void
    {
        $ticket = $this->ticket();
        $this->postJson('/api/login', ['email' => $this->requester->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $this->requester->update(['disabled_at' => now()]);
        Auth::forgetGuards();
        $before = $this->snapshot();

        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
            ->postJson('/api/tickets/'.$ticket->id.'/comments', ['body' => 'Texto'])->assertForbidden();
        $this->assertSame($before, $this->snapshot());
    }

    public function test_route_uses_sanctum_before_active_user_middleware(): void
    {
        $route = Route::getRoutes()->match(Request::create('/api/tickets/8/comments', 'POST'));
        $middleware = Route::gatherRouteMiddleware($route);
        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(
            array_search(EnsureUserIsActive::class, $middleware, true),
            array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true),
        );
    }

    public static function revokedCommentPermissions(): array
    {
        return [
            'technician internal after demotion' => ['technician', 'requester', false, true, true, 403],
            'admin internal after demotion' => ['admin', 'requester', false, true, true, 403],
            'technician loses visibility' => ['technician', 'requester', false, false, false, 404],
            'admin loses visibility' => ['admin', 'requester', false, false, false, 404],
            'requester loses visibility on promotion' => ['requester', 'technician', false, true, false, 404],
            'disabled requester' => ['requester', 'requester', true, true, false, 403],
            'disabled technician' => ['technician', 'technician', true, true, false, 403],
            'disabled admin' => ['admin', 'admin', true, true, true, 403],
            'unknown role' => ['admin', 'unknown', false, true, true, 403],
        ];
    }

    #[DataProvider('revokedCommentPermissions')]
    public function test_revalidates_comment_permissions_after_request_validation(string $beforeRole, string $afterRole, bool $disabled, bool $owner, bool $internal, int $status): void
    {
        $user = $this->actor($beforeRole);
        $ticket = $this->ticket(['requester_id' => $owner ? $user->id : $this->requester->id]);
        $before = null;
        $this->app->afterResolving(StoreTicketCommentRequest::class, function () use ($user, $ticket, $beforeRole, $afterRole, $disabled, &$before): void {
            DB::table('users')->where('id', $user->id)->update(['role' => $afterRole, 'disabled_at' => $disabled ? now() : null]);
            if ($beforeRole === 'requester' && $afterRole === 'technician') {
                $other = User::factory()->create(['role' => 'technician']);
                DB::table('tickets')->where('id', $ticket->id)->update(['assigned_to' => $other->id]);
            }
            $before = $this->snapshot();
            DB::enableQueryLog();
            DB::flushQueryLog();
        });
        try {
            $response = $this->postComment($user, $ticket, ['body' => 'Permissões atuais.', 'is_internal' => $internal])->assertStatus($status);
            $response->assertExactJson(['message' => $status === 404 ? 'Chamado não encontrado.' : ($disabled || $afterRole === 'unknown' ? 'Acesso não permitido.' : 'Somente técnicos e administradores podem criar comentários internos.')]);
            foreach (DB::getQueryLog() as $query) {
                $this->assertDoesNotMatchRegularExpression('/^\s*(insert|update|delete)\b/i', $query['query']);
            }
        } finally {
            DB::disableQueryLog();
        }
        $this->assertNotNull($before);
        $this->assertSame($before, $this->snapshot());
    }

    public static function currentCommentRoles(): array
    {
        return [['technician', 'requester'], ['admin', 'requester'], ['requester', 'technician'], ['requester', 'admin']];
    }

    #[DataProvider('currentCommentRoles')]
    public function test_uses_current_role_for_public_comment_and_first_response(string $beforeRole, string $afterRole): void
    {
        $user = $this->actor($beforeRole);
        $ticket = $this->ticket(['requester_id' => $user->id]);
        $original = $ticket->fresh()->getAttributes();
        $this->app->afterResolving(StoreTicketCommentRequest::class, function () use ($user, $afterRole): void {
            DB::table('users')->where('id', $user->id)->update(['role' => $afterRole]);
        });
        $this->postComment($user, $ticket, ['body' => 'Comentário público.'])->assertCreated();
        $this->assertSame($user->id, TicketComment::sole()->user_id);
        $this->assertSame($user->id, TicketActivity::sole()->actor_id);
        if ($afterRole === 'requester') {
            $this->assertSame($original, $ticket->fresh()->getAttributes());
        } else {
            $this->assertNotNull($ticket->fresh()->first_responded_at);
            $this->assertTrue($ticket->fresh()->first_responded_at->equalTo(now()));
        }
    }

    private function actor(string $role): User
    {
        return $role === 'requester' ? $this->requester : User::factory()->create(['role' => $role]);
    }

    private function ticket(array $overrides = []): Ticket
    {
        return Ticket::create(array_replace([
            'requester_id' => $this->requester->id, 'assigned_to' => null,
            'category_id' => Category::firstOrFail()->id,
            'status_id' => TicketStatus::where('code', 'open')->sole()->id,
            'sla_policy_id' => SlaPolicy::where('priority', 'medium')->sole()->id,
            'title' => 'Solicitação de suporte', 'description' => 'Descrição do problema', 'priority' => 'medium',
            'first_response_due_at' => now()->addHours(4), 'resolution_due_at' => now()->addDay(),
        ], $overrides));
    }

    private function postComment(User $user, Ticket $ticket, array $payload): TestResponse
    {
        // Recria os guards como em requisições independentes ao alternar usuários no mesmo teste.
        Auth::forgetGuards();

        return $this->actingAs($user, 'web')->postJson('/api/tickets/'.$ticket->id.'/comments', $payload);
    }

    private function detail(User $user, Ticket $ticket): TestResponse
    {
        Auth::forgetGuards();

        return $this->actingAs($user, 'web')->getJson('/api/tickets/'.$ticket->id);
    }

    private function snapshot(): array
    {
        $result = [];
        foreach (['users', 'tickets', 'ticket_comments', 'ticket_activities', 'categories', 'ticket_statuses', 'sla_policies', 'sessions'] as $table) {
            $result[$table] = DB::table($table)->orderBy('id')->get()->toJson();
        }

        return $result;
    }
}
