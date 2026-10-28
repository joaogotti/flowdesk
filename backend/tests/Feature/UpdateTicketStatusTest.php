<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Http\Requests\UpdateTicketStatusRequest;
use App\Models\Ticket;
use App\Models\TicketActivity;
use App\Models\TicketStatus;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class UpdateTicketStatusTest extends TestCase
{
    use AssignmentFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertSame('sqlite', config('database.default'));
        $this->createAssignmentFixtures();
    }

    #[DataProvider('transitionMatrix')]
    public function test_complete_transition_matrix_and_exact_response(string $role, string $from, string $to, int $expectedHttp): void
    {
        $user = User::factory()->create(['role' => $role]);
        $assignee = $role === 'technician' ? $user : User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticketAt($from, $assignee->id);
        $ticket->comments()->create(['user_id' => $this->requester->id, 'body' => 'Comentário preexistente.', 'is_internal' => false]);
        $other = $this->ticket();
        $otherBefore = $other->fresh()->getAttributes();
        $before = $ticket->fresh()->getAttributes();
        $snapshot = $this->snapshot();
        $this->travel(5)->minutes();

        $response = $this->change($user, $ticket, ['status' => $to])->assertStatus($expectedHttp);
        if ($expectedHttp === 409) {
            $response->assertExactJson(['message' => 'Esta transição de status não é permitida.']);
            $this->assertSame($snapshot, $this->snapshot());

            return;
        }
        $status = TicketStatus::where('code', $to)->sole();
        $fresh = $ticket->fresh();
        $response->assertHeader('Content-Type', 'application/json')->assertExactJson([
            'id' => $ticket->id, 'status' => $status->only(['id', 'code', 'name']),
            'resolved_at' => $fresh->resolved_at?->toISOString(),
            'closed_at' => $fresh->closed_at?->toISOString(),
            'updated_at' => $fresh->updated_at->toISOString(),
        ]);
        if ($from === $to) {
            $this->assertSame($snapshot, $this->snapshot());

            return;
        }
        $expected = $before;
        $expected['status_id'] = $status->id;
        $expected['updated_at'] = now()->toDateTimeString();
        if ($to === 'resolved') {
            $expected['resolved_at'] = now()->toDateTimeString();
        } elseif ($from === 'resolved' && $to === 'in_progress') {
            $expected['resolved_at'] = null;
        }
        if ($to === 'closed') {
            $expected['closed_at'] = now()->toDateTimeString();
        }
        $this->assertSame($expected, $fresh->getAttributes());
        $this->assertSame($otherBefore, $other->fresh()->getAttributes());
        $activity = TicketActivity::sole();
        $this->assertSame($ticket->id, $activity->ticket_id);
        $this->assertSame($user->id, $activity->actor_id);
        $this->assertSame('status_changed', $activity->action);
        $this->assertSame(['status' => ['from' => $from, 'to' => $to]], $activity->changes);
        $this->assertTrue($activity->created_at->equalTo(now()));
        $after = $this->snapshot();
        unset($snapshot['tickets'], $snapshot['ticket_activities'], $after['tickets'], $after['ticket_activities']);
        $this->assertSame($snapshot, $after);
    }

    public static function transitionMatrix(): array
    {
        // Tabela de negócio explícita: todas as 36 combinações para os dois papéis.
        $allowed = [
            'open' => ['in_progress', 'cancelled'],
            'in_progress' => ['waiting_requester', 'resolved', 'cancelled'],
            'waiting_requester' => ['in_progress', 'cancelled'],
            'resolved' => ['in_progress', 'closed'],
            'closed' => [], 'cancelled' => [],
        ];
        $cases = [];
        foreach (['admin', 'technician'] as $role) {
            foreach ($allowed as $from => $targets) {
                foreach (array_keys($allowed) as $to) {
                    $cases[$role.' '.$from.' -> '.$to] = [$role, $from, $to, $from === $to || in_array($to, $targets, true) ? 200 : 409];
                }
            }
        }

        return $cases;
    }

    public function test_resolve_reopen_resolve_and_close_use_server_dates_and_preserve_sla(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticketAt('in_progress', null);
        $original = $ticket->fresh()->getAttributes();
        $this->change($admin, $ticket, ['status' => 'resolved'])->assertOk()->assertJsonPath('resolved_at', now()->toISOString());
        $firstResolution = now()->toISOString();
        $this->travel(10)->minutes();
        $this->change($admin, $ticket, ['status' => 'resolved'])->assertOk()->assertJsonPath('resolved_at', $firstResolution);
        $this->assertSame(1, TicketActivity::count());
        $this->change($admin, $ticket, ['status' => 'in_progress'])->assertOk()->assertJsonPath('resolved_at', null);
        $this->travel(10)->minutes();
        $secondResolution = now()->toISOString();
        $this->change($admin, $ticket, ['status' => 'resolved'])->assertOk()->assertJsonPath('resolved_at', $secondResolution);
        $this->travel(10)->minutes();
        $closedAt = now()->toISOString();
        $this->change($admin, $ticket, ['status' => 'closed'])->assertOk()
            ->assertJsonPath('resolved_at', $secondResolution)->assertJsonPath('closed_at', $closedAt);
        $before = $this->snapshot();
        $this->travel(10)->minutes();
        $this->change($admin, $ticket, ['status' => 'closed'])->assertOk()->assertJsonPath('closed_at', $closedAt);
        $this->assertSame($before, $this->snapshot());
        $current = $ticket->fresh()->getAttributes();
        unset($original['status_id'], $original['resolved_at'], $original['closed_at'], $original['updated_at'], $current['status_id'], $current['resolved_at'], $current['closed_at'], $current['updated_at']);
        $this->assertSame($original, $current);
        $this->assertSame(4, TicketActivity::count());
    }

    public function test_resolving_does_not_invent_first_response(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticketAt('in_progress', null);
        $ticket->update(['first_responded_at' => null]);

        $this->change($admin, $ticket, ['status' => 'resolved'])->assertOk();
        $this->assertNull($ticket->fresh()->first_responded_at);
    }

    public function test_requester_is_forbidden_before_validation_even_for_owned_ticket(): void
    {
        $ticket = $this->ticket();
        $before = $this->snapshot();
        foreach ([[], ['status' => 'in_progress'], ['status' => 'open']] as $payload) {
            $this->change($this->requester, $ticket, $payload)->assertForbidden();
        }
        $this->assertSame($before, $this->snapshot());
    }

    public function test_unknown_role_is_forbidden(): void
    {
        $user = User::factory()->create(['role' => 'unknown']);
        $ticket = $this->ticket();
        $before = $this->snapshot();
        $this->change($user, $ticket, ['status' => 'in_progress'])->assertForbidden();
        $this->assertSame($before, $this->snapshot());
    }

    public function test_technician_cannot_change_unassigned_ticket_even_idempotently(): void
    {
        $technician = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket();
        $before = $this->snapshot();
        foreach ([[], ['status' => 'in_progress'], ['status' => 'open']] as $payload) {
            $this->change($technician, $ticket, $payload)->assertForbidden();
        }
        $this->assertSame($before, $this->snapshot());
    }

    public function test_technician_cannot_access_another_assignment_even_when_requester(): void
    {
        $technician = User::factory()->create(['role' => 'technician']);
        $other = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket(['requester_id' => $technician->id, 'assigned_to' => $other->id]);
        $before = $this->snapshot();
        foreach ([[], ['status' => 'open'], ['status' => 'in_progress']] as $payload) {
            $this->change($technician, $ticket, $payload)->assertNotFound()->assertExactJson(['message' => 'Chamado não encontrado.']);
        }
        $this->assertSame($before, $this->snapshot());
    }

    #[DataProvider('invalidIds')]
    public function test_missing_or_invalid_ticket_returns_404(string $role, string $id): void
    {
        $user = User::factory()->create(['role' => $role]);
        $before = $this->snapshot();
        $this->actingAs($user, 'web')->patchJson('/api/tickets/'.$id.'/status', [])->assertNotFound();
        $this->assertSame($before, $this->snapshot());
    }

    public static function invalidIds(): array
    {
        $cases = [];
        foreach (['admin', 'technician'] as $role) {
            foreach (['999999', '0', '-1', 'abc', '9223372036854775808'] as $id) {
                $cases[] = [$role, $id];
            }
        }

        return $cases;
    }

    #[DataProvider('invalidPayloads')]
    public function test_invalid_payload_is_422_and_never_writes(array $payload): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket();
        $before = $this->snapshot();
        $this->change($admin, $ticket, $payload)->assertUnprocessable();
        $this->assertSame($before, $this->snapshot());
    }

    public static function invalidPayloads(): array
    {
        $cases = [[[]], [['status' => null]], [['status' => '']], [['status' => '   ']],
            [['status' => 1]], [['status' => true]], [['status' => false]], [['status' => []]],
            [['status' => ['code' => 'in_progress']]], [['status' => 'unknown']], [['status' => 'OPEN']]];
        foreach (['status_id', 'actor_id', 'user_id', 'assigned_to', 'resolved_at', 'closed_at', 'updated_at', 'first_responded_at', 'first_response_due_at', 'resolution_due_at', 'priority', 'category_id', 'changes'] as $field) {
            $cases[] = [['status' => 'in_progress', $field => 1]];
        }

        return $cases;
    }

    public function test_guest_is_401_and_disabled_roles_are_403(): void
    {
        $ticket = $this->ticket();
        $this->patchJson('/api/tickets/'.$ticket->id.'/status', [])->assertUnauthorized();
        foreach (['admin', 'technician', 'requester'] as $role) {
            $user = User::factory()->create(['role' => $role, 'disabled_at' => now()]);
            $before = $this->snapshot();
            $this->change($user, $ticket, ['status' => 'in_progress'])->assertForbidden();
            $this->assertSame($before, $this->snapshot());
        }
    }

    #[DataProvider('writeFailures')]
    public function test_ticket_and_activity_rollback_together(string $model, string $event): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticketAt('in_progress', null);
        $before = $this->snapshot();
        $this->withoutExceptionHandling();
        $model::$event(function (): void {
            throw new RuntimeException('Status write failure');
        });
        try {
            $this->change($admin, $ticket, ['status' => 'resolved']);
            $this->fail('Expected atomic write failure.');
        } catch (RuntimeException $exception) {
            $this->assertSame('Status write failure', $exception->getMessage());
        } finally {
            $model::flushEventListeners();
        }
        $this->assertSame($before, $this->snapshot());
        $this->assertSame(0, DB::transactionLevel());
    }

    public static function writeFailures(): array
    {
        return [[Ticket::class, 'updated'], [TicketActivity::class, 'creating'], [TicketActivity::class, 'created']];
    }

    #[DataProvider('stateChanges')]
    public function test_permissions_and_state_are_rechecked_after_initial_authorization(string $change, int $expected): void
    {
        $technician = User::factory()->create(['role' => 'technician']);
        $other = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticketAt('in_progress', $technician->id);
        $this->app->afterResolving(UpdateTicketStatusRequest::class, function () use ($change, $technician, $other, $ticket): void {
            if ($change === 'disabled') {
                $technician->update(['disabled_at' => now()]);
            } elseif ($change === 'role') {
                $technician->update(['role' => 'requester']);
            } elseif ($change === 'other') {
                $ticket->update(['assigned_to' => $other->id]);
            } elseif ($change === 'unassigned') {
                $ticket->update(['assigned_to' => null]);
            } else {
                $ticket->update(['status_id' => TicketStatus::where('code', 'cancelled')->sole()->id]);
            }
        });
        $this->change($technician, $ticket, ['status' => 'resolved'])->assertStatus($expected);
        $this->assertNull($ticket->fresh()->resolved_at);
        $this->assertSame(0, TicketActivity::count());
    }

    public static function stateChanges(): array
    {
        return [['disabled', 403], ['role', 403], ['other', 404], ['unassigned', 403], ['status', 409]];
    }

    public function test_status_history_does_not_broaden_requester_visibility(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $technician = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticketAt('open', $technician->id);
        $ticket->activities()->create(['actor_id' => $this->requester->id, 'action' => 'created', 'changes' => null]);
        $ticket->comments()->create(['user_id' => $technician->id, 'body' => 'Nota interna privada.', 'is_internal' => true]);
        $this->change($admin, $ticket, ['status' => 'in_progress'])->assertOk();
        Auth::forgetGuards();
        $this->actingAs($this->requester, 'web')->getJson('/api/tickets/'.$ticket->id)->assertOk()
            ->assertJsonCount(1, 'activities')->assertJsonPath('activities.0.action', 'created')->assertJsonCount(0, 'comments');
        Auth::forgetGuards();
        $detail = $this->actingAs($technician, 'web')->getJson('/api/tickets/'.$ticket->id)->assertOk()->json();
        $this->assertCount(2, $detail['activities']);
        $this->assertSame('status_changed', $detail['activities'][1]['action']);
        $this->assertArrayNotHasKey('changes', $detail['activities'][1]);
        $this->assertSame(['status' => ['from' => 'open', 'to' => 'in_progress']], $detail['activities'][1]['details']);
        $this->assertSame('Nota interna privada.', $detail['comments'][0]['body']);
    }

    public function test_real_session_csrf_and_middleware_order_are_preserved(): void
    {
        $route = Route::getRoutes()->match(Request::create('/api/tickets/8/status', 'PATCH'));
        $middleware = Route::gatherRouteMiddleware($route);
        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(array_search(EnsureUserIsActive::class, $middleware, true), array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true));
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket();
        $this->postJson('/api/login', ['email' => $admin->email, 'password' => 'password'])->assertOk();
        $id = session()->getId();
        $token = session()->token();
        $this->app->instance('env', 'local');
        Auth::forgetGuards();
        $before = $this->snapshot();
        $this->withCredentials()->withCookie(config('session.cookie'), $id)->patchJson('/api/tickets/'.$ticket->id.'/status', ['status' => 'in_progress'])->assertStatus(419);
        $this->assertSame($before, $this->snapshot());
        $this->withHeader('X-CSRF-TOKEN', $token)->patchJson('/api/tickets/'.$ticket->id.'/status', ['status' => 'in_progress'])->assertOk();
        $this->assertSame($id, session()->getId());
        $this->assertSame($token, session()->token());
    }

    private function ticketAt(string $code, ?int $assignee): Ticket
    {
        return $this->ticket([
            'assigned_to' => $assignee, 'status_id' => TicketStatus::where('code', $code)->sole()->id,
            'created_at' => now()->subDay(), 'first_responded_at' => now()->subHours(2),
            'resolved_at' => in_array($code, ['resolved', 'closed'], true) ? now()->subHour() : null,
            'closed_at' => $code === 'closed' ? now()->subMinutes(30) : null,
        ]);
    }

    private function change(User $user, Ticket $ticket, array $payload): TestResponse
    {
        Auth::forgetGuards();

        return $this->actingAs($user, 'web')->patchJson('/api/tickets/'.$ticket->id.'/status', $payload);
    }
}
