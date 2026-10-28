<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Http\Requests\UpdateTicketDetailsRequest;
use App\Models\Category;
use App\Models\SlaPolicy;
use App\Models\Ticket;
use App\Models\TicketActivity;
use App\Models\TicketStatus;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class UpdateTicketDetailsTest extends TestCase
{
    use AssignmentFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertSame('sqlite', config('database.default'));
        $this->createAssignmentFixtures();
        $this->travelTo(Carbon::parse('2026-10-25 10:00:00', 'UTC'));
    }

    #[DataProvider('editableCases')]
    public function test_partial_and_joint_updates_preserve_unrelated_data(string $role, string $status, string $fields): void
    {
        $user = User::factory()->create(['role' => $role]);
        $assignee = $role === 'technician' ? $user : User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket([
            'assigned_to' => $assignee->id, 'status_id' => TicketStatus::where('code', $status)->sole()->id,
            'created_at' => now()->subDays(2), 'first_responded_at' => now()->subDay(),
            // Preservar horários efetivos, sem derivá-los da nova prioridade.
            'resolved_at' => now()->subHours(3), 'closed_at' => now()->subHours(2),
        ]);
        $ticket->comments()->create(['user_id' => $this->requester->id, 'body' => 'Comentário preexistente.', 'is_internal' => true]);
        $ticket->activities()->create(['actor_id' => $this->requester->id, 'action' => 'created', 'changes' => null]);
        $other = $this->ticket();
        $otherBefore = $other->fresh()->getAttributes();
        $category = Category::where('id', '!=', $ticket->category_id)->where('is_active', true)->firstOrFail();
        $payload = [];
        $expected = $ticket->fresh()->getAttributes();
        $changes = [];
        if ($fields !== 'priority') {
            $payload['category_id'] = $category->id;
            $changes['category_id'] = ['from' => $ticket->category_id, 'to' => $category->id];
            $expected['category_id'] = $category->id;
        }
        if ($fields !== 'category') {
            $payload['priority'] = 'high';
            $changes['priority'] = ['from' => 'medium', 'to' => 'high'];
            $policy = SlaPolicy::where('priority', 'high')->sole();
            $expected['priority'] = 'high';
            $expected['sla_policy_id'] = $policy->id;
            $expected['first_response_due_at'] = $ticket->created_at->copy()->addMinutes(60)->toDateTimeString();
            $expected['resolution_due_at'] = $ticket->created_at->copy()->addMinutes(480)->toDateTimeString();
        }
        $snapshot = $this->snapshot();
        $this->travel(5)->minutes();
        $expected['updated_at'] = now()->toDateTimeString();

        $response = $this->change($user, $ticket, $payload)->assertOk();
        $fresh = $ticket->fresh();
        $response->assertHeader('Content-Type', 'application/json')->assertExactJson([
            'id' => $ticket->id, 'category' => $fresh->category->only(['id', 'name']),
            'priority' => $fresh->priority, 'updated_at' => now()->toISOString(),
        ]);
        $this->assertSame($expected, $fresh->getAttributes());
        $this->assertSame($otherBefore, $other->fresh()->getAttributes());
        $activities = $ticket->activities()->orderBy('id')->get();
        $this->assertCount(2, $activities);
        $this->assertSame('created', $activities[0]->action);
        $activity = $activities[1];
        $this->assertSame('details_changed', $activity->action);
        $this->assertSame($ticket->id, $activity->ticket_id);
        $this->assertSame($user->id, $activity->actor_id);
        $this->assertSame($changes, $activity->changes);
        $this->assertTrue($activity->created_at->equalTo($fresh->updated_at));
        $after = $this->snapshot();
        unset($snapshot['tickets'], $snapshot['ticket_activities'], $after['tickets'], $after['ticket_activities']);
        $this->assertSame($snapshot, $after);

        $beforeRetry = $this->snapshot();
        $this->travel(10)->minutes();
        $this->change($user, $ticket, $payload)->assertOk()->assertExactJson($response->json());
        $this->assertSame($beforeRetry, $this->snapshot());
    }

    public static function editableCases(): array
    {
        $cases = [];
        foreach (['admin', 'technician'] as $role) {
            foreach (['open', 'in_progress', 'waiting_requester'] as $status) {
                foreach (['category', 'priority', 'both'] as $fields) {
                    $cases["$role $status $fields"] = [$role, $status, $fields];
                }
            }
        }

        return $cases;
    }

    #[DataProvider('priorities')]
    public function test_priority_recalculation_matches_creation_and_preserves_actual_times(string $priority, int $firstMinutes, int $resolutionMinutes): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $createdAt = Carbon::parse('2026-10-23 23:50:00', 'UTC');
        $initial = $priority === 'medium' ? 'low' : 'medium';
        $ticket = $this->ticket([
            'priority' => $initial, 'sla_policy_id' => SlaPolicy::where('priority', $initial)->sole()->id,
            'first_responded_at' => null,
        ]);
        // created_at não é mass assignable no model do chamado.
        $ticket->created_at = $createdAt;
        $ticket->save();
        $this->change($admin, $ticket, ['priority' => $priority])->assertOk();
        $fresh = $ticket->fresh();
        $this->assertSame(SlaPolicy::where('priority', $priority)->sole()->id, $fresh->sla_policy_id);
        $this->assertTrue($fresh->first_response_due_at->equalTo($createdAt->copy()->addMinutes($firstMinutes)));
        $this->assertTrue($fresh->resolution_due_at->equalTo($createdAt->copy()->addMinutes($resolutionMinutes)));
        $this->assertNull($fresh->first_responded_at);
        $this->assertNull($fresh->resolved_at);
        $this->assertNull($fresh->closed_at);
        // Comparação com o endpoint de criação real, no mesmo horário de abertura.
        $this->travelTo($createdAt);
        Auth::forgetGuards();
        $created = $this->actingAs($admin, 'web')->postJson('/api/tickets', [
            'title' => 'Comparação SLA', 'description' => 'Somente no banco de teste.',
            'category_id' => $ticket->category_id, 'priority' => $priority,
        ])->assertCreated();
        $this->assertSame($fresh->first_response_due_at->toISOString(), $created->json('first_response_due_at'));
        $this->assertSame($fresh->resolution_due_at->toISOString(), $created->json('resolution_due_at'));
    }

    public static function priorities(): array
    {
        return [['low', 480, 4320], ['medium', 240, 1440], ['high', 60, 480], ['urgent', 15, 240]];
    }

    public function test_idempotency_does_not_refresh_sla_and_history_contains_only_changed_fields(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket();
        SlaPolicy::where('priority', 'medium')->update(['first_response_minutes' => 123]);
        $before = $this->snapshot();
        foreach ([['category_id' => $ticket->category_id], ['priority' => 'medium'], ['category_id' => $ticket->category_id, 'priority' => 'medium']] as $payload) {
            $this->travel(5)->minutes();
            $this->change($admin, $ticket, $payload)->assertOk();
            $this->assertSame($before, $this->snapshot());
        }
        $category = Category::where('id', '!=', $ticket->category_id)->firstOrFail();
        $this->change($admin, $ticket, ['category_id' => $category->id, 'priority' => 'medium'])->assertOk();
        $this->assertSame(['category_id' => ['from' => $ticket->category_id, 'to' => $category->id]], TicketActivity::sole()->changes);
        $this->change($admin, $ticket, ['category_id' => $category->id, 'priority' => 'urgent'])->assertOk();
        $this->assertSame(['priority' => ['from' => 'medium', 'to' => 'urgent']], TicketActivity::orderByDesc('id')->firstOrFail()->changes);
    }

    #[DataProvider('invalidPayloads')]
    public function test_invalid_payloads_never_write(array $payload): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket();
        $before = $this->snapshot();
        $this->change($admin, $ticket, $payload)->assertUnprocessable();
        $this->assertSame($before, $this->snapshot());
    }

    public static function invalidPayloads(): array
    {
        $cases = [[[]]];
        foreach ([null, '', ' ', 0, -1, '1', 1.0, true, false, [], ['id' => 1], 999999] as $category) {
            $cases[] = [['category_id' => $category, 'priority' => 'high']];
        }
        foreach ([null, '', ' ', 1, true, false, [], ['code' => 'high'], 'HIGH', 'critical'] as $priority) {
            $cases[] = [['priority' => $priority]];
        }
        foreach (['title', 'description', 'status', 'status_id', 'actor_id', 'assigned_to', 'requester_id', 'sla_policy_id', 'first_response_due_at', 'resolution_due_at', 'first_responded_at', 'resolved_at', 'closed_at', 'created_at', 'updated_at', 'changes'] as $field) {
            $cases[] = [['priority' => 'high', $field => 1]];
        }

        return $cases;
    }

    public function test_inactive_categories_and_missing_sla_policy_are_422_without_partial_writes(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket();
        $category = Category::where('id', '!=', $ticket->category_id)->firstOrFail();
        $category->update(['is_active' => false]);
        $before = $this->snapshot();
        $this->change($admin, $ticket, ['category_id' => $category->id, 'priority' => 'high'])->assertUnprocessable()->assertJsonValidationErrors('category_id');
        $this->assertSame($before, $this->snapshot());
        $category->update(['is_active' => true]);
        SlaPolicy::where('priority', 'high')->delete();
        $before = $this->snapshot();
        $this->change($admin, $ticket, ['category_id' => $category->id, 'priority' => 'high'])->assertUnprocessable()->assertJsonValidationErrors('priority');
        $this->assertSame($before, $this->snapshot());
    }

    public function test_guest_disabled_and_unauthorized_roles_cannot_edit(): void
    {
        $ticket = $this->ticket();
        $this->patchJson('/api/tickets/'.$ticket->id.'/details', [])->assertUnauthorized();
        foreach (['admin', 'technician', 'requester'] as $role) {
            $disabled = User::factory()->create(['role' => $role, 'disabled_at' => now()]);
            $before = $this->snapshot();
            $this->change($disabled, $ticket, ['priority' => 'high'])->assertForbidden();
            $this->assertSame($before, $this->snapshot());
        }
        foreach ([$this->requester, User::factory()->create(['role' => 'unknown'])] as $user) {
            $before = $this->snapshot();
            foreach ([[], ['priority' => 'high'], ['priority' => 'medium']] as $payload) {
                $this->change($user, $ticket, $payload)->assertForbidden();
            }
            $this->assertSame($before, $this->snapshot());
        }
    }

    public function test_technician_cannot_edit_unassigned_or_another_assignment_even_when_requester(): void
    {
        $technician = User::factory()->create(['role' => 'technician']);
        $other = User::factory()->create(['role' => 'technician']);
        foreach ([null, $other->id] as $assignedTo) {
            $ticket = $this->ticket(['requester_id' => $technician->id, 'assigned_to' => $assignedTo]);
            $before = $this->snapshot();
            foreach ([[], ['priority' => 'high'], ['priority' => 'medium']] as $payload) {
                $this->change($technician, $ticket, $payload)->assertStatus($assignedTo === null ? 403 : 404);
            }
            $this->assertSame($before, $this->snapshot());
        }
    }

    #[DataProvider('missingIds')]
    public function test_invalid_or_missing_ticket_is_404_before_payload_validation(string $role, string $id): void
    {
        $user = User::factory()->create(['role' => $role]);
        $before = $this->snapshot();
        $this->actingAs($user, 'web')->patchJson('/api/tickets/'.$id.'/details', [])->assertNotFound();
        $this->assertSame($before, $this->snapshot());
    }

    public static function missingIds(): array
    {
        $cases = [];
        foreach (['admin', 'technician'] as $role) {
            foreach (['999999', '0', '-1', 'abc', '9223372036854775808'] as $id) {
                $cases[] = [$role, $id];
            }
        }

        return $cases;
    }

    #[DataProvider('finalStatuses')]
    public function test_final_states_are_409_including_idempotent_updates(string $role, string $status): void
    {
        $user = User::factory()->create(['role' => $role]);
        $ticket = $this->ticket(['assigned_to' => $role === 'technician' ? $user->id : null, 'status_id' => TicketStatus::where('code', $status)->sole()->id]);
        $before = $this->snapshot();
        foreach (['high', 'medium'] as $priority) {
            $this->change($user, $ticket, ['priority' => $priority])->assertConflict();
        }
        $this->assertSame($before, $this->snapshot());
    }

    public static function finalStatuses(): array
    {
        return [['admin', 'resolved'], ['admin', 'closed'], ['admin', 'cancelled'], ['technician', 'resolved'], ['technician', 'closed'], ['technician', 'cancelled']];
    }

    #[DataProvider('stateChanges')]
    public function test_revalidation_after_initial_authorization(string $change, int $http): void
    {
        $user = User::factory()->create(['role' => 'technician']);
        $other = User::factory()->create(['role' => 'technician']);
        $ticket = $this->ticket(['assigned_to' => $user->id]);
        $category = Category::where('id', '!=', $ticket->category_id)->firstOrFail();
        $expected = null;
        $this->app->afterResolving(UpdateTicketDetailsRequest::class, function () use ($change, $user, $other, $ticket, $category, &$expected): void {
            match ($change) {
                'disabled' => $user->update(['disabled_at' => now()]),
                'role' => $user->update(['role' => 'requester']),
                'other' => $ticket->update(['assigned_to' => $other->id]),
                'unassigned' => $ticket->update(['assigned_to' => null]),
                'status' => $ticket->update(['status_id' => TicketStatus::where('code', 'resolved')->sole()->id]),
                'category' => $category->update(['is_active' => false]),
                'deleted_category' => $category->delete(),
                'policy' => SlaPolicy::where('priority', 'high')->delete(),
                'deleted_ticket' => $ticket->delete(),
            };
            $expected = $this->snapshot();
        });
        $this->change($user, $ticket, ['category_id' => $category->id, 'priority' => 'high'])->assertStatus($http);
        $this->assertNotNull($expected);
        $this->assertSame($expected, $this->snapshot());
    }

    public static function stateChanges(): array
    {
        return [['disabled', 403], ['role', 403], ['other', 404], ['unassigned', 403], ['status', 409], ['category', 422], ['deleted_category', 422], ['policy', 422], ['deleted_ticket', 404]];
    }

    #[DataProvider('writeFailures')]
    public function test_ticket_sla_and_activity_rollback_together(string $model, string $event): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket();
        $category = Category::where('id', '!=', $ticket->category_id)->firstOrFail();
        $before = $this->snapshot();
        $this->withoutExceptionHandling();
        $model::$event(function (): void {
            throw new RuntimeException('Details write failure');
        });
        try {
            $this->change($admin, $ticket, ['category_id' => $category->id, 'priority' => 'high']);
            $this->fail('Expected atomic write failure.');
        } catch (RuntimeException $exception) {
            $this->assertSame('Details write failure', $exception->getMessage());
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

    public function test_details_history_does_not_broaden_requester_visibility(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $ticket = $this->ticket();
        $ticket->activities()->create(['actor_id' => $this->requester->id, 'action' => 'created', 'changes' => null]);
        $this->change($admin, $ticket, ['priority' => 'high'])->assertOk();
        Auth::forgetGuards();
        $this->actingAs($this->requester, 'web')->getJson('/api/tickets/'.$ticket->id)->assertOk()->assertJsonCount(1, 'activities')->assertJsonPath('activities.0.action', 'created');
        Auth::forgetGuards();
        $this->actingAs($admin, 'web')->getJson('/api/tickets/'.$ticket->id)->assertOk()->assertJsonCount(2, 'activities')
            ->assertJsonPath('activities.1.action', 'details_changed')->assertJsonMissingPath('activities.1.changes')
            ->assertJsonPath('activities.1.details', ['priority' => ['from' => 'medium', 'to' => 'high']]);
    }

    public function test_real_session_csrf_and_middleware_are_preserved(): void
    {
        $route = Route::getRoutes()->match(Request::create('/api/tickets/8/details', 'PATCH'));
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
        $this->withCredentials()->withCookie(config('session.cookie'), $id)->patchJson('/api/tickets/'.$ticket->id.'/details', ['priority' => 'high'])->assertStatus(419);
        $this->assertSame($before, $this->snapshot());
        $this->withHeader('X-CSRF-TOKEN', $token)->patchJson('/api/tickets/'.$ticket->id.'/details', ['priority' => 'high'])->assertOk();
        $this->assertSame($id, session()->getId());
        $this->assertSame($token, session()->token());
    }

    private function change(User $user, Ticket $ticket, array $payload): TestResponse
    {
        Auth::forgetGuards();

        return $this->actingAs($user, 'web')->patchJson('/api/tickets/'.$ticket->id.'/details', $payload, [], JSON_PRESERVE_ZERO_FRACTION);
    }
}
