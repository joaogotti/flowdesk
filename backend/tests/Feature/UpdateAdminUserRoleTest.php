<?php

namespace Tests\Feature;

use App\Http\Requests\UpdateAdminUserRoleRequest;
use App\Models\TicketStatus;
use App\Models\User;
use App\Models\UserRoleChange;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\UserRoleFixtures;
use Tests\TestCase;

class UpdateAdminUserRoleTest extends TestCase
{
    use UserRoleFixtures;

    private User $admin;

    private User $target;

    protected function setUp(): void
    {
        parent::setUp();
        $this->configureRolePostgresql();
        if (DB::connection()->getDriverName() === 'sqlite') {
            $this->assertSame(':memory:', DB::connection()->getDatabaseName());
        } else {
            $this->assertSame('flowdesk_role_test', DB::connection()->getDatabaseName());
        }
        DB::beginTransaction();
        $this->createRoleFixtures();
        $this->admin = User::factory()->create(['role' => 'admin']);
        $this->target = User::factory()->create(['role' => 'requester']);
        $this->actingAs($this->admin, 'web');
    }

    protected function tearDown(): void
    {
        try {
            if ($this->app) {
                while (DB::transactionLevel() > 0) {
                    DB::rollBack();
                }
            }
        } finally {
            parent::tearDown();
        }
    }

    private function endpoint(?int $id = null): string
    {
        return '/api/admin/users/'.($id ?? $this->target->id).'/role';
    }

    public static function transitions(): iterable
    {
        foreach (['requester', 'technician', 'admin'] as $from) {
            foreach (['requester', 'technician', 'admin'] as $to) {
                if ($from !== $to) {
                    yield "$from -> $to" => [$from, $to];
                }
            }
        }
    }

    #[DataProvider('transitions')]
    public function test_all_six_transitions_return_exact_public_contract_and_atomic_audit(string $from, string $to): void
    {
        $this->target->update(['role' => $from]);
        $before = $this->target->fresh()->getAttributes();
        $snapshot = $this->roleSnapshot();
        $this->travel(5)->minutes();
        $response = $this->patchJson($this->endpoint(), ['role' => $to, 'expected_role' => $from])->assertOk();
        $fresh = $this->target->fresh();
        $response->assertExactJson(['data' => [
            'id' => $fresh->id, 'name' => $fresh->name, 'email' => $fresh->email, 'role' => $to,
            'disabled_at' => null, 'created_at' => $fresh->created_at->toISOString(),
        ]]);
        foreach ($before as $field => $value) {
            if (! in_array($field, ['role', 'updated_at'], true)) {
                $this->assertSame($value, $fresh->getAttributes()[$field]);
            }
        }
        $this->assertNotSame($before['updated_at'], $fresh->getAttributes()['updated_at']);
        $audit = UserRoleChange::sole();
        $this->assertSame($this->admin->id, $audit->actor_id);
        $this->assertSame($this->target->id, $audit->target_user_id);
        $this->assertSame($from, $audit->previous_role);
        $this->assertSame($to, $audit->new_role);
        $this->assertTrue($audit->created_at->equalTo($fresh->updated_at));
        $this->assertSame($this->admin->id, $audit->actor->id);
        $this->assertSame($this->target->id, $audit->targetUser->id);
        $after = $this->roleSnapshot();
        unset($snapshot['users'], $snapshot['user_role_changes'], $after['users'], $after['user_role_changes']);
        $this->assertSame($snapshot, $after);
    }

    public static function forbiddenActors(): array
    {
        return [['requester', false], ['technician', false], ['admin', true], ['requester', true], ['technician', true]];
    }

    #[DataProvider('forbiddenActors')]
    public function test_only_active_administrators_can_change_roles(string $role, bool $disabled): void
    {
        $actor = User::factory()->create(['role' => $role, 'disabled_at' => $disabled ? now() : null]);
        Auth::forgetGuards();
        $this->actingAs($actor, 'web');
        $before = $this->roleSnapshot();
        $this->patchJson($this->endpoint(), [])->assertForbidden();
        $this->patchJson('/api/admin/users/999999/role', [])->assertForbidden();
        $this->assertSame($before, $this->roleSnapshot());
    }

    public function test_guests_receive_401(): void
    {
        Auth::forgetGuards();
        $before = $this->roleSnapshot();
        $this->patchJson($this->endpoint(), [])->assertUnauthorized();
        $this->assertSame($before, $this->roleSnapshot());
    }

    public function test_self_changes_are_forbidden_even_for_the_last_active_admin(): void
    {
        User::factory()->create(['role' => 'admin', 'disabled_at' => now()]);
        $before = $this->roleSnapshot();
        foreach (['requester', 'technician', 'admin'] as $role) {
            $this->patchJson($this->endpoint($this->admin->id), ['role' => $role, 'expected_role' => 'admin'])
                ->assertForbidden()->assertExactJson(['message' => 'Não é permitido alterar o próprio perfil.']);
        }
        $this->assertSame(1, User::where('role', 'admin')->whereNull('disabled_at')->count());
        $this->assertSame($before, $this->roleSnapshot());
    }

    public function test_disabled_target_is_a_conflict_including_noop(): void
    {
        $this->target->update(['disabled_at' => now()]);
        $before = $this->roleSnapshot();
        foreach (['technician', 'requester'] as $role) {
            $this->patchJson($this->endpoint(), ['role' => $role, 'expected_role' => 'requester'])->assertConflict()->assertJsonPath('code', 'target_disabled');
        }
        $this->assertSame($before, $this->roleSnapshot());
    }

    public function test_expected_role_prevents_stale_changes_including_destination_already_current(): void
    {
        $before = $this->roleSnapshot();
        foreach (['admin', 'requester'] as $role) {
            $this->patchJson($this->endpoint(), ['role' => $role, 'expected_role' => 'technician'])->assertConflict()->assertJsonPath('code', 'role_changed');
        }
        $this->assertSame($before, $this->roleSnapshot());
    }

    public static function unchangedRoles(): array
    {
        return [['requester'], ['technician'], ['admin']];
    }

    #[DataProvider('unchangedRoles')]
    public function test_noop_does_not_update_user_or_create_audit_even_with_pending_assignments(string $role): void
    {
        $this->target->update(['role' => $role]);
        if ($role === 'technician') {
            $this->ticket(['assigned_to' => $this->target->id]);
        }
        $before = $this->roleSnapshot();
        DB::enableQueryLog();
        DB::flushQueryLog();
        try {
            $this->patchJson($this->endpoint(), ['role' => $role, 'expected_role' => $role])->assertOk()->assertJsonPath('data.role', $role);
            foreach (DB::getQueryLog() as $query) {
                $this->assertDoesNotMatchRegularExpression('/^\s*(insert|update|delete)\b/i', $query['query']);
            }
        } finally {
            DB::disableQueryLog();
        }
        $this->assertSame($before, $this->roleSnapshot());
    }

    public static function blockingAssignments(): iterable
    {
        foreach (['open', 'in_progress', 'waiting_requester', 'resolved'] as $status) {
            foreach (['requester', 'admin'] as $role) {
                yield "$status -> $role" => [$status, $role];
            }
        }
    }

    #[DataProvider('blockingAssignments')]
    public function test_technician_exit_is_blocked_without_reassigning_or_modifying_any_data(string $status, string $role): void
    {
        $this->target->update(['role' => 'technician']);
        $this->ticket(['assigned_to' => $this->target->id, 'status_id' => TicketStatus::where('code', $status)->sole()->id]);
        $before = $this->roleSnapshot();
        $this->patchJson($this->endpoint(), ['role' => $role, 'expected_role' => 'technician'])->assertConflict()->assertJsonPath('code', 'active_assignments');
        $this->assertSame($before, $this->roleSnapshot());
    }

    public function test_closed_and_cancelled_assignments_authorship_comments_history_credentials_and_sla_are_preserved(): void
    {
        $this->target->update(['role' => 'technician']);
        $this->target->forceFill(['remember_token' => 'private-token', 'email_verified_at' => now()])->save();
        foreach (['closed', 'cancelled'] as $status) {
            $ticket = $this->ticket(['requester_id' => $this->target->id, 'assigned_to' => $this->target->id, 'status_id' => TicketStatus::where('code', $status)->sole()->id]);
            $ticket->comments()->create(['user_id' => $this->target->id, 'body' => 'Preservar.', 'is_internal' => true]);
            $ticket->activities()->create(['actor_id' => $this->target->id, 'action' => 'ticket_created']);
        }
        $before = $this->roleSnapshot();
        $attributes = $this->target->fresh()->getAttributes();
        $this->patchJson($this->endpoint(), ['role' => 'requester', 'expected_role' => 'technician'])->assertOk();
        $after = $this->roleSnapshot();
        unset($before['users'], $before['user_role_changes'], $after['users'], $after['user_role_changes']);
        $this->assertSame($before, $after);
        foreach ($attributes as $field => $value) {
            if (! in_array($field, ['role', 'updated_at'], true)) {
                $this->assertSame($value, $this->target->fresh()->getAttributes()[$field]);
            }
        }
        $this->assertSame(2, $this->target->assignedTickets()->count());
        $this->assertSame(2, $this->target->requestedTickets()->count());
    }

    public static function invalidPayloads(): iterable
    {
        yield 'empty' => [[], ['role', 'expected_role']];
        yield 'missing role' => [['expected_role' => 'requester'], ['role']];
        yield 'missing expected role' => [['role' => 'technician'], ['expected_role']];
        foreach (['role', 'expected_role'] as $field) {
            foreach ([null, '', [], 1, true, 'owner', "ad\0min"] as $index => $value) {
                yield "$field $index" => [array_replace(['role' => 'technician', 'expected_role' => 'requester'], [$field => $value]), [$field]];
            }
        }
        foreach (['name', 'email', 'id', 'password', 'disabled_at', 'created_at', 'unknown'] as $field) {
            yield "extra $field" => [['role' => 'technician', 'expected_role' => 'requester', $field => null], ['payload']];
        }
    }

    #[DataProvider('invalidPayloads')]
    public function test_invalid_payloads_return_422_without_writes(array $payload, array $fields): void
    {
        $before = $this->roleSnapshot();
        $this->patchJson($this->endpoint(), $payload)->assertUnprocessable()->assertJsonValidationErrors($fields);
        $this->assertSame($before, $this->roleSnapshot());
    }

    public function test_query_parameters_are_rejected_and_name_email_patch_still_rejects_role(): void
    {
        $before = $this->roleSnapshot();
        $this->patchJson($this->endpoint().'?role=admin', ['role' => 'technician', 'expected_role' => 'requester'])->assertUnprocessable()->assertJsonValidationErrors('payload');
        $this->patchJson('/api/admin/users/'.$this->target->id, ['name' => 'Não salvar', 'role' => 'admin'])->assertUnprocessable()->assertJsonValidationErrors('payload');
        $this->assertSame($before, $this->roleSnapshot());
    }

    public function test_missing_and_out_of_range_users_return_404(): void
    {
        $before = $this->roleSnapshot();
        foreach (['999999', '0', '-1', 'abc', '9999999999999999999999999'] as $id) {
            $this->patchJson('/api/admin/users/'.$id.'/role', ['role' => 'admin', 'expected_role' => 'requester'])->assertNotFound();
        }
        $this->assertSame($before, $this->roleSnapshot());
    }

    public static function revokedActors(): array
    {
        return [[['role' => 'technician']], [['disabled_at' => '2026-01-01']]];
    }

    #[DataProvider('revokedActors')]
    public function test_actor_is_revalidated_inside_transaction(array $changes): void
    {
        $before = null;
        $this->app->afterResolving(UpdateAdminUserRoleRequest::class, function () use ($changes, &$before): void {
            DB::table('users')->where('id', $this->admin->id)->update($changes);
            $before = $this->roleSnapshot();
        });
        $this->patchJson($this->endpoint(), ['role' => 'admin', 'expected_role' => 'requester'])->assertForbidden();
        $this->assertSame($before, $this->roleSnapshot());
    }

    public function test_target_profile_and_active_state_are_revalidated_inside_transaction(): void
    {
        $this->app->afterResolving(UpdateAdminUserRoleRequest::class, function (): void {
            DB::table('users')->where('id', $this->target->id)->update(['disabled_at' => now()]);
        });
        $this->patchJson($this->endpoint(), ['role' => 'admin', 'expected_role' => 'requester'])->assertConflict()->assertJsonPath('code', 'target_disabled');
        $this->assertDatabaseCount('user_role_changes', 0);
    }

    public function test_target_removed_after_validation_returns_404_without_audit(): void
    {
        $this->app->afterResolving(UpdateAdminUserRoleRequest::class, function (): void {
            DB::table('users')->where('id', $this->target->id)->delete();
        });
        $this->patchJson($this->endpoint(), ['role' => 'admin', 'expected_role' => 'requester'])->assertNotFound();
        $this->assertDatabaseCount('user_role_changes', 0);
    }

    public function test_audit_database_failure_rolls_back_role_and_timestamp(): void
    {
        if (DB::connection()->getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE user_role_changes ADD CONSTRAINT reject_test_audit CHECK (false)');
        } else {
            DB::statement("CREATE TRIGGER reject_test_audit BEFORE INSERT ON user_role_changes BEGIN SELECT RAISE(ABORT, 'audit rejected'); END");
        }
        $before = $this->roleSnapshot();
        $this->patchJson($this->endpoint(), ['role' => 'admin', 'expected_role' => 'requester'])->assertStatus(503)->assertExactJson(['message' => 'Não foi possível alterar o perfil no momento.']);
        $this->assertSame($before, $this->roleSnapshot());
        $this->assertSame(1, DB::transactionLevel());
    }

    public function test_missing_audit_table_fails_closed_until_deployment_migration_is_applied(): void
    {
        Schema::drop('user_role_changes');
        $before = $this->snapshot();
        $this->patchJson($this->endpoint(), ['role' => 'admin', 'expected_role' => 'requester'])->assertStatus(503);
        $this->assertSame($before, $this->snapshot());
    }

    public static function sessionRoleChanges(): array
    {
        return [['admin', 'requester'], ['technician', 'admin']];
    }

    #[DataProvider('sessionRoleChanges')]
    public function test_existing_session_uses_new_role_without_rotating_session_or_credentials(string $from, string $to): void
    {
        $this->target->update(['role' => $from]);
        Auth::forgetGuards();
        $this->postJson('/api/login', ['email' => $this->target->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $token = session()->token();
        Auth::forgetGuards();
        $this->actingAs($this->admin, 'web');
        $this->patchJson($this->endpoint(), ['role' => $to, 'expected_role' => $from])->assertOk();
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)->getJson('/api/user')->assertOk()->assertJsonPath('role', $to)->assertJsonPath('id', $this->target->id);
        $this->getJson('/api/admin/users')->assertStatus($to === 'admin' ? 200 : 403);
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($token, session()->token());
        $this->assertDatabaseCount('sessions', 0);
    }

    public function test_stateful_role_change_requires_valid_csrf(): void
    {
        Auth::forgetGuards();
        $this->postJson('/api/login', ['email' => $this->admin->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $token = session()->token();
        $this->app->instance('env', 'local');
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)->patchJson($this->endpoint(), ['role' => 'admin', 'expected_role' => 'requester'])->assertStatus(419);
        $this->assertDatabaseCount('user_role_changes', 0);
        Auth::forgetGuards();
        $this->withHeader('X-CSRF-TOKEN', $token)->patchJson($this->endpoint(), ['role' => 'admin', 'expected_role' => 'requester'])->assertOk();
    }

    public function test_postgresql_migration_enforces_audit_constraints_and_foreign_keys(): void
    {
        if (DB::connection()->getDriverName() !== 'pgsql') {
            $this->markTestSkipped('The actual audit migration and constraints are verified only on disposable PostgreSQL.');
        }
        foreach ([
            ['previous_role' => 'owner'], ['new_role' => 'owner'], ['new_role' => 'requester'],
            ['actor_id' => $this->target->id], ['target_user_id' => 999999], ['actor_id' => 999999],
            ['actor_id' => null], ['created_at' => null], ['previous_role' => null],
        ] as $override) {
            try {
                DB::transaction(fn () => DB::table('user_role_changes')->insert(array_replace([
                    'actor_id' => $this->admin->id, 'target_user_id' => $this->target->id,
                    'previous_role' => 'requester', 'new_role' => 'technician', 'created_at' => now(),
                ], $override)));
                $this->fail('Invalid audit entry should have been rejected.');
            } catch (QueryException) {
                $this->assertDatabaseCount('user_role_changes', 0);
            }
        }
    }
}
