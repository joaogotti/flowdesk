<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Http\Requests\UpdateTicketAssignmentRequest;
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

class UpdateTicketAssignmentTest extends TestCase
{
    use AssignmentFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertSame('sqlite', config('database.default'));
        $this->createAssignmentFixtures();
    }

    public function test_admin_assigns_transfers_and_removes_with_exact_json_and_history(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $first = User::factory()->create(['role' => 'technician']);
        $second = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket(['first_responded_at' => now()->subMinute()]);
        $before = $ticket->fresh()->getAttributes();
        $usersBefore = DB::table('users')->orderBy('id')->get()->toJson();
        $previous = null;
        foreach ([$first, $second, null] as $index => $target) {
            $this->travel(1)->minutes();
            $this->assign($admin, $ticket, ['assigned_to' => $target?->id])->assertOk()->assertExactJson([
                'id' => $ticket->id, 'assignee' => $target?->only(['id', 'name']),
                'updated_at' => now()->toISOString(),
            ]);
            $fresh = $ticket->fresh();
            $this->assertSame($target?->id, $fresh->assigned_to);
            $activity = TicketActivity::orderByDesc('id')->firstOrFail();
            $this->assertSame('assignment_changed', $activity->action);
            $this->assertSame($admin->id, $activity->actor_id);
            $this->assertSame($ticket->id, $activity->ticket_id);
            $this->assertSame(['assigned_to' => ['from' => $previous, 'to' => $target?->id]], $activity->changes);
            $this->assertTrue($activity->created_at->equalTo(now()));
            $this->assertSame($index + 1, TicketActivity::count());
            $after = $fresh->getAttributes();
            unset($after['assigned_to'], $after['updated_at']);
            $original = $before;
            unset($original['assigned_to'], $original['updated_at']);
            $this->assertSame($original, $after);
            $previous = $target?->id;
        }
        $this->assertSame($usersBefore, DB::table('users')->orderBy('id')->get()->toJson());
    }

    public function test_technician_assumes_available_ticket_and_can_repeat_idempotently(): void
    {
        $technician = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket();
        $this->assign($technician, $ticket, ['assigned_to' => $technician->id])->assertOk()
            ->assertJsonPath('assignee.id', $technician->id);
        $before = $this->snapshot();
        $this->travel(10)->minutes();
        $this->assign($technician, $ticket, ['assigned_to' => $technician->id])->assertOk();
        $this->assertSame($before, $this->snapshot());
        $this->assertSame(1, TicketActivity::count());
    }

    public function test_admin_same_assignee_and_already_unassigned_are_idempotent(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $technician = User::factory()->create(['role' => 'technician']);
        foreach ([null, $technician->id] as $assignedTo) {
            $ticket = $this->ticket(['assigned_to' => $assignedTo]);
            $before = $this->snapshot();
            $this->travel(10)->minutes();
            $this->assign($admin, $ticket, ['assigned_to' => $assignedTo])->assertOk()
                ->assertJsonPath('updated_at', $ticket->updated_at->toISOString());
            $this->assertSame($before, $this->snapshot());
        }
    }

    public function test_requester_cannot_change_assignments_even_with_invalid_input(): void
    {
        $ticket = $this->ticket();
        $before = $this->snapshot();
        foreach ([[], ['assigned_to' => null], ['assigned_to' => $this->requester->id]] as $payload) {
            $this->assign($this->requester, $ticket, $payload)->assertForbidden();
        }
        $this->assertSame($before, $this->snapshot());
    }

    public function test_technician_cannot_transfer_assign_others_or_remove(): void
    {
        $technician = User::factory()->create(['role' => 'technician']);
        $other = User::factory()->create(['role' => 'technician']);
        foreach ([null, $technician->id] as $assignedTo) {
            $ticket = $this->ticket(['assigned_to' => $assignedTo]);
            $before = $this->snapshot();
            foreach ([$other->id, null] as $target) {
                $this->assign($technician, $ticket, ['assigned_to' => $target])->assertForbidden();
            }
            $this->assertSame($before, $this->snapshot());
        }
    }

    public function test_already_restricted_ticket_returns_404_before_validation(): void
    {
        $technician = User::factory()->create(['role' => 'technician']);
        $other = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket(['requester_id' => $technician->id, 'assigned_to' => $other->id]);
        $before = $this->snapshot();
        foreach ([[], ['assigned_to' => $technician->id]] as $payload) {
            $this->assign($technician, $ticket, $payload)->assertNotFound()->assertExactJson(['message' => 'Chamado não encontrado.']);
        }
        $this->assertSame($before, $this->snapshot());
    }

    #[DataProvider('invalidIds')]
    public function test_missing_or_invalid_ticket_id_returns_404(string $id): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $before = $this->snapshot();
        $this->actingAs($admin, 'web')->patchJson('/api/tickets/'.$id.'/assignment', [])->assertNotFound();
        $this->assertSame($before, $this->snapshot());
    }

    public static function invalidIds(): array
    {
        return [['999999'], ['0'], ['-1'], ['abc'], ['9223372036854775808']];
    }

    #[DataProvider('invalidPayloads')]
    public function test_invalid_payload_returns_422_without_writes(array $payload): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket();
        $before = $this->snapshot();
        $this->assign($admin, $ticket, $payload)->assertUnprocessable();
        $this->assertSame($before, $this->snapshot());
    }

    public static function invalidPayloads(): array
    {
        return [[[]], [['assigned_to' => 0]], [['assigned_to' => -1]], [['assigned_to' => 1.5]],
            [['assigned_to' => '1']], [['assigned_to' => '']], [['assigned_to' => '   ']], [['assigned_to' => true]], [['assigned_to' => false]],
            [['assigned_to' => []]], [['assigned_to' => ['id' => 1]]], [['assigned_to' => 9223372036854775808.0]],
            [['assigned_to' => null, 'status_id' => 5]], [['assigned_to' => null, 'priority' => 'urgent']],
            [['assigned_to' => null, 'first_response_due_at' => '2000-01-01']],
            [['assigned_to' => null, 'actor_id' => 1]], [['assigned_to' => null, 'role' => 'admin']]];
    }

    public function test_invalid_target_missing_disabled_requester_or_admin_returns_422(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $disabled = User::factory()->create(['role' => 'technician', 'disabled_at' => now()]);
        $ticket = $this->ticket();
        $before = $this->snapshot();
        foreach ([999999, $disabled->id, $this->requester->id, $admin->id] as $id) {
            $this->assign($admin, $ticket, ['assigned_to' => $id])->assertUnprocessable()->assertJsonValidationErrors('assigned_to');
        }
        $this->assertSame($before, $this->snapshot());
    }

    public function test_guest_is_401_and_disabled_users_are_403(): void
    {
        $ticket = $this->ticket();
        $this->patchJson('/api/tickets/'.$ticket->id.'/assignment', [])->assertUnauthorized();
        foreach (['requester', 'technician', 'admin'] as $role) {
            $user = User::factory()->create(['role' => $role, 'disabled_at' => now()]);
            $before = $this->snapshot();
            $this->assign($user, $ticket, ['assigned_to' => null])->assertForbidden();
            $this->assertSame($before, $this->snapshot());
        }
    }

    #[DataProvider('statuses')]
    public function test_assignment_respects_status_for_admin_and_technician(string $role, string $status, int $expected): void
    {
        $user = User::factory()->create(['role' => $role]);
        $target = $role === 'technician' ? $user : User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket(['status_id' => TicketStatus::where('code', $status)->sole()->id]);
        $before = $this->snapshot();
        $this->assign($user, $ticket, ['assigned_to' => $target->id])->assertStatus($expected);
        if ($expected === 409) {
            $this->assertSame($before, $this->snapshot());
        }
    }

    public static function statuses(): array
    {
        $cases = [];
        foreach (['admin', 'technician'] as $role) {
            foreach (['open', 'in_progress', 'waiting_requester', 'resolved', 'closed', 'cancelled'] as $status) {
                $cases[] = [$role, $status, in_array($status, ['open', 'in_progress', 'waiting_requester'], true) ? 200 : 409];
            }
        }

        return $cases;
    }

    #[DataProvider('failureStages')]
    public function test_transaction_rolls_back_ticket_and_history_on_failure(string $model, string $event): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $target = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket();
        $before = $this->snapshot();
        $this->withoutExceptionHandling();
        $model::$event(function (): void {
            throw new RuntimeException('Assignment failure');
        });
        try {
            $this->assign($admin, $ticket, ['assigned_to' => $target->id]);
            $this->fail('Expected write failure.');
        } catch (RuntimeException $exception) {
            $this->assertSame('Assignment failure', $exception->getMessage());
        } finally {
            $model::flushEventListeners();
        }
        $this->assertSame($before, $this->snapshot());
        $this->assertSame(0, DB::transactionLevel());
    }

    public static function failureStages(): array
    {
        return [[Ticket::class, 'updated'], [TicketActivity::class, 'creating'], [TicketActivity::class, 'created']];
    }

    public function test_losing_claim_after_initial_visibility_check_is_409_not_overwrite(): void
    {
        $technician = User::factory()->create(['role' => 'technician']);
        $winner = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket();
        // Simula a mudança entre a autorização inicial e a consulta com bloqueio.
        $this->app->afterResolving(UpdateTicketAssignmentRequest::class, function () use ($ticket, $winner): void {
            Ticket::whereKey($ticket->id)->update(['assigned_to' => $winner->id]);
        });
        $this->assign($technician, $ticket, ['assigned_to' => $technician->id])->assertConflict();
        $this->assertSame($winner->id, $ticket->fresh()->assigned_to);
        $this->assertSame(0, TicketActivity::count());
    }

    public function test_destination_is_revalidated_after_initial_validation(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $target = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket();
        $before = $ticket->fresh()->getAttributes();
        $this->app->afterResolving(UpdateTicketAssignmentRequest::class, function () use ($target): void {
            $target->update(['disabled_at' => now()]);
        });
        $this->assign($admin, $ticket, ['assigned_to' => $target->id])->assertUnprocessable()->assertJsonValidationErrors('assigned_to');
        $this->assertSame($before, $ticket->fresh()->getAttributes());
        $this->assertSame(0, TicketActivity::count());
    }

    public function test_assignment_history_remains_hidden_from_requesters(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $target = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket();
        $ticket->activities()->create(['actor_id' => $this->requester->id, 'action' => 'created', 'changes' => null]);
        $this->assign($admin, $ticket, ['assigned_to' => $target->id])->assertOk();
        Auth::forgetGuards();
        $this->actingAs($this->requester, 'web')->getJson('/api/tickets/'.$ticket->id)->assertOk()
            ->assertJsonCount(1, 'activities')->assertJsonPath('activities.0.action', 'created');
        Auth::forgetGuards();
        $data = $this->actingAs($target, 'web')->getJson('/api/tickets/'.$ticket->id)->assertOk()->json();
        $this->assertCount(2, $data['activities']);
        $this->assertSame('assignment_changed', $data['activities'][1]['action']);
        $this->assertArrayNotHasKey('changes', $data['activities'][1]);
        $this->assertSame(['assignee' => ['from' => null, 'to' => $target->only(['id', 'name'])]], $data['activities'][1]['details']);
        $this->assertArrayNotHasKey('email', $data['assignee']);
    }

    #[DataProvider('concurrentStateChanges')]
    public function test_actor_and_ticket_state_are_revalidated_after_initial_authorization(string $change, int $status): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $target = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket();
        $this->app->afterResolving(UpdateTicketAssignmentRequest::class, function () use ($change, $admin, $ticket): void {
            if ($change === 'disabled') {
                $admin->update(['disabled_at' => now()]);
            } elseif ($change === 'role') {
                $admin->update(['role' => 'requester']);
            } else {
                $ticket->update(['status_id' => TicketStatus::where('code', 'closed')->sole()->id]);
            }
        });
        $this->assign($admin, $ticket, ['assigned_to' => $target->id])->assertStatus($status);
        $this->assertNull($ticket->fresh()->assigned_to);
        $this->assertSame(0, TicketActivity::count());
    }

    public static function concurrentStateChanges(): array
    {
        return [['disabled', 403], ['role', 403], ['status', 409]];
    }

    public function test_route_middleware_session_and_csrf_are_preserved(): void
    {
        $route = Route::getRoutes()->match(Request::create('/api/tickets/8/assignment', 'PATCH'));
        $middleware = Route::gatherRouteMiddleware($route);
        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(array_search(EnsureUserIsActive::class, $middleware, true), array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true));
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket();
        $this->postJson('/api/login', ['email' => $admin->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $csrf = session()->token();
        $this->app->instance('env', 'local');
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
            ->patchJson('/api/tickets/'.$ticket->id.'/assignment', ['assigned_to' => null])->assertStatus(419);
        $this->withHeader('X-CSRF-TOKEN', $csrf)->patchJson('/api/tickets/'.$ticket->id.'/assignment', ['assigned_to' => null])->assertOk();
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($csrf, session()->token());
    }

    private function assign(User $user, Ticket $ticket, array $payload): TestResponse
    {
        Auth::forgetGuards();

        return $this->actingAs($user, 'web')->patchJson('/api/tickets/'.$ticket->id.'/assignment', $payload);
    }
}
