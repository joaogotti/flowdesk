<?php

namespace Tests\Feature;

use App\Http\Requests\UpdateAdminUserStatusRequest;
use App\Models\TicketStatus;
use App\Models\User;
use App\Models\UserStatusChange;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\UserStatusFixtures;
use Tests\TestCase;

class UpdateAdminUserStatusTest extends TestCase
{
    use UserStatusFixtures;

    private User $admin;

    private User $target;

    protected function setUp(): void
    {
        parent::setUp();
        $this->configureStatusPostgresql();
        $this->assertContains(DB::connection()->getDatabaseName(), [':memory:', 'flowdesk_user_status_test']);
        DB::beginTransaction();
        $this->createStatusFixtures();
        $this->admin = User::factory()->create(['role' => 'admin']);
        $this->target = User::factory()->create(['role' => 'requester']);
        $this->actingAs($this->admin, 'web');
    }

    protected function tearDown(): void
    {
        try {
            while ($this->app && DB::transactionLevel() > 0) {
                DB::rollBack();
            }
        } finally {
            parent::tearDown();
        }
    }

    private function endpoint(?User $user = null): string
    {
        return '/api/admin/users/'.($user ?? $this->target)->id.'/status';
    }

    private function sessionRow(User $user): string
    {
        $id = bin2hex(random_bytes(20));
        DB::table('sessions')->insert(['id' => $id, 'user_id' => $user->id, 'payload' => 'isolated-marker', 'last_activity' => time()]);

        return $id;
    }

    public static function transitions(): iterable
    {
        foreach (['requester', 'technician', 'admin'] as $role) {
            foreach ([true, false] as $active) {
                yield "$role from ".($active ? 'active' : 'disabled') => [$role, $active];
            }
        }
    }

    #[DataProvider('transitions')]
    public function test_changes_are_audited_with_safe_response_and_sessions_revoked(string $role, bool $active): void
    {
        $this->target->forceFill(['role' => $role, 'disabled_at' => $active ? null : now()->subDay(), 'session_version' => 4])->save();
        $before = $this->target->fresh();
        $first = $this->sessionRow($this->target);
        $second = $this->sessionRow($this->target);
        $other = $this->sessionRow($this->admin);
        $this->patchJson($this->endpoint(), ['is_active' => ! $active, 'expected_is_active' => $active])
            ->assertOk()->assertJsonPath('data.id', $this->target->id)->assertJsonPath('data.role', $role)
            ->assertJsonStructure(['data' => ['id', 'name', 'email', 'role', 'disabled_at', 'created_at']])
            ->assertJsonCount(6, 'data');
        $after = $this->target->fresh();
        $this->assertSame(! $active, $after->disabled_at === null);
        $this->assertSame(5, $after->session_version);
        $this->assertSame($before->only(['id', 'name', 'email', 'password', 'role', 'remember_token']), $after->only(['id', 'name', 'email', 'password', 'role', 'remember_token']));
        $this->assertSame($before->getRawOriginal('created_at'), $after->getRawOriginal('created_at'));
        $this->assertFalse(DB::table('sessions')->whereIn('id', [$first, $second])->exists());
        $this->assertTrue(DB::table('sessions')->where('id', $other)->exists());
        $audit = UserStatusChange::sole();
        $this->assertSame($this->admin->id, $audit->actor->id);
        $this->assertSame($after->id, $audit->targetUser->id);
        $this->assertSame($before->disabled_at?->toISOString(), $audit->previous_disabled_at?->toISOString());
        $this->assertSame($after->disabled_at?->toISOString(), $audit->new_disabled_at?->toISOString());
        $this->assertSame($after->updated_at->toISOString(), $audit->created_at->toISOString());
        $this->assertSame(0, DB::table('user_role_changes')->count());
    }

    #[DataProvider('transitions')]
    public function test_noop_preserves_every_record_and_session(string $role, bool $active): void
    {
        $this->target->forceFill(['role' => $role, 'disabled_at' => $active ? null : now()->subDay(), 'session_version' => 7])->save();
        $this->sessionRow($this->target);
        if ($role === 'technician') {
            $this->ticket(['assigned_to' => $this->target->id]);
        }
        $before = $this->statusSnapshot();
        $this->patchJson($this->endpoint(), ['is_active' => $active, 'expected_is_active' => $active])->assertOk();
        $this->assertSame($before, $this->statusSnapshot());
    }

    public static function forbiddenActors(): array
    {
        return [['requester', false], ['technician', false], ['admin', true]];
    }

    #[DataProvider('forbiddenActors')]
    public function test_only_active_administrators_are_allowed(string $role, bool $disabled): void
    {
        $actor = User::factory()->create(['role' => $role, 'disabled_at' => $disabled ? now() : null]);
        $before = $this->statusSnapshot();
        $this->actingAs($actor, 'web')->patchJson($this->endpoint(), [])->assertForbidden();
        $this->assertSame($before, $this->statusSnapshot());
    }

    public function test_guest_and_revoked_actor_are_unauthorized(): void
    {
        Auth::forgetGuards();
        $this->patchJson($this->endpoint(), [])->assertUnauthorized();
        DB::table('users')->where('id', $this->admin->id)->increment('session_version');
        $this->actingAs($this->admin->fresh(), 'web')->patchJson($this->endpoint(), [])
            ->assertUnauthorized()->assertJsonPath('code', 'session_revoked');
    }

    public function test_self_disable_and_last_active_administrator_are_protected(): void
    {
        $before = $this->statusSnapshot();
        $this->patchJson($this->endpoint($this->admin), ['is_active' => false, 'expected_is_active' => true])->assertForbidden();
        $this->assertSame($before, $this->statusSnapshot());
        $this->assertSame(1, User::where('role', 'admin')->whereNull('disabled_at')->count());
        $this->patchJson($this->endpoint($this->admin), ['is_active' => true, 'expected_is_active' => true])->assertOk();
        $this->assertSame($before, $this->statusSnapshot());
    }

    #[DataProvider('transitions')]
    public function test_expected_state_mismatch_is_a_conflict_even_for_noop(string $role, bool $active): void
    {
        $this->target->update(['role' => $role, 'disabled_at' => $active ? null : now()]);
        $before = $this->statusSnapshot();
        $this->patchJson($this->endpoint(), ['is_active' => $active, 'expected_is_active' => ! $active])
            ->assertConflict()->assertJsonPath('code', 'status_changed');
        $this->assertSame($before, $this->statusSnapshot());
    }

    public static function pendingStatuses(): array
    {
        return [['open'], ['in_progress'], ['waiting_requester'], ['resolved']];
    }

    #[DataProvider('pendingStatuses')]
    public function test_technician_with_pending_assignments_cannot_be_disabled(string $status): void
    {
        $this->target->update(['role' => 'technician']);
        $this->ticket(['assigned_to' => $this->target->id, 'status_id' => TicketStatus::where('code', $status)->sole()->id]);
        $before = $this->statusSnapshot();
        $this->patchJson($this->endpoint(), ['is_active' => false, 'expected_is_active' => true])
            ->assertConflict()->assertJsonPath('code', 'active_assignments');
        $this->assertSame($before, $this->statusSnapshot());
    }

    public function test_historical_links_and_requester_pending_tickets_are_preserved(): void
    {
        $this->target->update(['role' => 'technician']);
        foreach (['closed', 'cancelled'] as $status) {
            $ticket = $this->ticket(['assigned_to' => $this->target->id, 'status_id' => TicketStatus::where('code', $status)->sole()->id]);
            $ticket->comments()->create(['user_id' => $this->target->id, 'body' => 'Histórico', 'is_internal' => false]);
            $ticket->activities()->create(['actor_id' => $this->target->id, 'action' => 'created']);
        }
        $before = $this->snapshot();
        $this->patchJson($this->endpoint(), ['is_active' => false, 'expected_is_active' => true])->assertOk();
        $after = $this->snapshot();
        unset($before['users'], $after['users']);
        $this->assertSame($before, $after);
        $requester = User::factory()->create(['role' => 'requester']);
        $ticket = $this->ticket(['requester_id' => $requester->id]);
        $record = $ticket->fresh()->getAttributes();
        $this->patchJson($this->endpoint($requester), ['is_active' => false, 'expected_is_active' => true])->assertOk();
        $this->assertSame($record, $ticket->fresh()->getAttributes());
    }

    public static function invalidPayloads(): array
    {
        return [[[]], [['is_active' => false]], [['expected_is_active' => true]],
            [['is_active' => 0, 'expected_is_active' => true]], [['is_active' => false, 'expected_is_active' => 1]],
            [['is_active' => 'false', 'expected_is_active' => true]], [['is_active' => null, 'expected_is_active' => true]],
            [['is_active' => [], 'expected_is_active' => true]],
            [['is_active' => false, 'expected_is_active' => true, 'role' => 'admin']],
            [['is_active' => false, 'expected_is_active' => true, 'session_version' => 0]],
            [['is_active' => false, 'expected_is_active' => true, 'disabled_at' => null]]];
    }

    #[DataProvider('invalidPayloads')]
    public function test_payload_rejections_do_not_write(array $payload): void
    {
        $before = $this->statusSnapshot();
        $writes = [];
        DB::listen(function ($query) use (&$writes): void {
            if (preg_match('/^\s*(insert|update|delete)\b/i', $query->sql)) {
                $writes[] = $query->sql;
            }
        });
        $this->patchJson($this->endpoint(), $payload)->assertUnprocessable();
        $this->assertSame([], $writes);
        $this->assertSame($before, $this->statusSnapshot());
    }

    public function test_query_fields_missing_target_and_separate_name_email_contract(): void
    {
        $this->patchJson($this->endpoint().'?is_active=false', ['is_active' => false, 'expected_is_active' => true])->assertUnprocessable();
        $this->patchJson('/api/admin/users/999999/status', ['is_active' => false, 'expected_is_active' => true])->assertNotFound();
        $this->patchJson('/api/admin/users/'.$this->target->id, ['is_active' => false])->assertUnprocessable();
        $this->assertSame(0, UserStatusChange::count());
    }

    public function test_actor_is_revalidated_after_form_validation(): void
    {
        $this->app->afterResolving(UpdateAdminUserStatusRequest::class, function (): void {
            DB::table('users')->where('id', $this->admin->id)->update(['role' => 'technician']);
        });
        $this->patchJson($this->endpoint(), ['is_active' => false, 'expected_is_active' => true])->assertForbidden();
        $this->assertNull($this->target->fresh()->disabled_at);
        $this->assertSame(0, UserStatusChange::count());
    }

    public function test_target_state_is_revalidated_after_form_validation(): void
    {
        $this->app->afterResolving(UpdateAdminUserStatusRequest::class, function (): void {
            DB::table('users')->where('id', $this->target->id)->update(['disabled_at' => now(), 'session_version' => 1]);
        });
        $this->patchJson($this->endpoint(), ['is_active' => false, 'expected_is_active' => true])
            ->assertConflict()->assertJsonPath('code', 'status_changed');
        $this->assertSame(1, $this->target->fresh()->session_version);
        $this->assertSame(0, UserStatusChange::count());
    }

    public function test_target_deletion_after_form_validation_returns_not_found(): void
    {
        $this->app->afterResolving(UpdateAdminUserStatusRequest::class, function (): void {
            DB::table('users')->where('id', $this->target->id)->delete();
        });
        $this->patchJson($this->endpoint(), ['is_active' => false, 'expected_is_active' => true])->assertNotFound();
        $this->assertSame(0, UserStatusChange::count());
    }

    public function test_reactivation_preserves_existing_pending_assignments(): void
    {
        $this->target->update(['role' => 'technician', 'disabled_at' => now()]);
        $ticket = $this->ticket(['assigned_to' => $this->target->id]);
        $before = $ticket->fresh()->getAttributes();
        $this->patchJson($this->endpoint(), ['is_active' => true, 'expected_is_active' => false])->assertOk();
        $this->assertSame($before, $ticket->fresh()->getAttributes());
        $this->assertSame(1, $this->target->fresh()->session_version);
        $this->assertSame(1, UserStatusChange::count());
    }

    public function test_noop_executes_no_business_write(): void
    {
        $writes = [];
        DB::listen(function ($query) use (&$writes): void {
            if (preg_match('/^\s*(insert|update|delete)\b/i', $query->sql)) {
                $writes[] = $query->sql;
            }
        });
        $this->patchJson($this->endpoint(), ['is_active' => true, 'expected_is_active' => true])->assertOk();
        $this->assertSame([], $writes);
    }

    public function test_session_storage_on_another_connection_is_rejected(): void
    {
        $before = $this->statusSnapshot();
        config(['database.connections.another_database' => ['driver' => 'sqlite', 'database' => ':memory:'],
            'session.driver' => 'database', 'session.connection' => 'another_database']);
        Schema::connection('another_database')->create('sessions', function ($table): void {
            $table->string('id')->primary();
            $table->unsignedBigInteger('user_id')->nullable();
            $table->string('ip_address')->nullable();
            $table->text('user_agent')->nullable();
            $table->text('payload');
            $table->integer('last_activity');
        });
        $this->patchJson($this->endpoint(), ['is_active' => false, 'expected_is_active' => true])->assertStatus(503);
        $this->assertSame($before, $this->statusSnapshot());
        DB::purge('another_database');
    }

    public function test_session_version_overflow_is_rejected(): void
    {
        $this->target->forceFill(['session_version' => PHP_INT_MAX])->save();
        $this->patchJson($this->endpoint(), ['is_active' => false, 'expected_is_active' => true])
            ->assertConflict()->assertJsonPath('code', 'session_version_exhausted');
        $this->assertSame(PHP_INT_MAX, $this->target->fresh()->session_version);
    }

    public function test_audit_failure_rolls_back_state_version_and_deleted_sessions(): void
    {
        $id = $this->sessionRow($this->target);
        $before = $this->target->fresh()->getAttributes();
        Schema::drop('user_status_changes');
        $this->patchJson($this->endpoint(), ['is_active' => false, 'expected_is_active' => true])->assertStatus(503);
        $this->assertSame($before, $this->target->fresh()->getAttributes());
        $this->assertTrue(DB::table('sessions')->where('id', $id)->exists());
    }

    public function test_unsupported_session_driver_is_rejected_without_mutation(): void
    {
        $before = $this->statusSnapshot();
        config(['session.driver' => 'file']);
        $this->patchJson($this->endpoint(), ['is_active' => false, 'expected_is_active' => true])->assertStatus(503);
        $this->assertSame($before, $this->statusSnapshot());
    }

    public function test_existing_cookie_is_permanently_revoked_after_disable_and_reactivate(): void
    {
        Auth::forgetGuards();
        $this->postJson('/api/login', ['email' => $this->target->email, 'password' => 'password'])->assertOk();
        $id = session()->getId();
        Auth::forgetGuards();
        $this->actingAs($this->admin, 'web');
        $this->patchJson($this->endpoint(), ['is_active' => false, 'expected_is_active' => true])->assertOk();
        $this->patchJson($this->endpoint(), ['is_active' => true, 'expected_is_active' => false])->assertOk();
        $this->assertSame(2, $this->target->fresh()->session_version);
        $this->assertSame(2, UserStatusChange::count());
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $id)->getJson('/api/user')
            ->assertUnauthorized()->assertJsonPath('code', 'session_revoked');
        $this->postJson('/api/login', ['email' => $this->target->email, 'password' => 'password'])->assertOk()
            ->assertSessionHas('auth_session_version', 2);
    }

    public function test_csrf_is_required_for_stateful_requests(): void
    {
        Auth::forgetGuards();
        $this->postJson('/api/login', ['email' => $this->admin->email, 'password' => 'password'])->assertOk();
        $id = session()->getId();
        $token = session()->token();
        $this->app->instance('env', 'local');
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $id)
            ->patchJson($this->endpoint(), ['is_active' => false, 'expected_is_active' => true])->assertStatus(419);
        $this->withHeader('X-CSRF-TOKEN', $token)->patchJson($this->endpoint(), ['is_active' => false, 'expected_is_active' => true])->assertOk();
    }
}
