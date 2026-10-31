<?php

namespace Tests\Feature;

use App\Http\Requests\UpdateUserProfileRequest;
use App\Models\User;
use App\Support\SessionVersion;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class UpdateUserProfileTest extends TestCase
{
    use AssignmentFixtures;

    private const URL = '/api/user/profile';

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertSame('sqlite', DB::connection()->getDriverName());
        $this->assertSame(':memory:', DB::connection()->getDatabaseName());
        $this->createAssignmentFixtures();
        config(['logging.default' => 'null']);
        $this->user = User::factory()->create(['name' => 'Nome Original', 'session_version' => 7]);
        $this->actingAs($this->user, 'web')->withSession([SessionVersion::KEY => 7]);
    }

    public static function roles(): array
    {
        return [['requester'], ['technician'], ['admin']];
    }

    #[DataProvider('roles')]
    public function test_all_active_roles_can_change_only_their_name_without_revoking_sessions(string $role): void
    {
        $this->user->forceFill(['role' => $role, 'remember_token' => 'private-token', 'email_verified_at' => now()])->save();
        $other = User::factory()->create();
        $otherBefore = $other->fresh()->getAttributes();
        $ticket = $this->ticket(['requester_id' => $this->user->id, 'assigned_to' => $this->user->id]);
        $ticket->comments()->create(['user_id' => $this->user->id, 'body' => 'Preservar', 'is_internal' => false]);
        DB::table('sessions')->insert(['id' => 'other-device', 'user_id' => $this->user->id, 'payload' => 'opaque', 'last_activity' => time()]);
        Auth::forgetGuards();
        $this->postJson('/api/login', ['email' => $this->user->email, 'password' => 'password'])->assertOk();
        $snapshot = $this->snapshot();
        $before = $this->user->fresh()->getAttributes();
        $sessionId = session()->getId();
        $csrf = session()->token();
        $this->travel(5)->minutes();
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId);
        $this->patchJson(self::URL, ['name' => " \tNovo  Nome\n\u{00a0}", 'expected_name' => 'Nome Original'])
            ->assertOk()->assertExactJson(['data' => ['id' => $this->user->id, 'name' => 'Novo  Nome', 'email' => $this->user->email, 'role' => $role]])
            ->assertHeader('Cache-Control', 'no-store, private');
        $after = $this->user->fresh()->getAttributes();
        foreach ($before as $field => $value) {
            if (! in_array($field, ['name', 'updated_at'], true)) {
                $this->assertSame($value, $after[$field], $field);
            }
        }
        $this->assertNotSame($before['updated_at'], $after['updated_at']);
        $this->assertSame($otherBefore, $other->fresh()->getAttributes());
        $afterSnapshot = $this->snapshot();
        unset($snapshot['users'], $afterSnapshot['users']);
        $this->assertSame($snapshot, $afterSnapshot);
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($csrf, session()->token());
        $this->assertSame(7, session()->get(SessionVersion::KEY));
        Auth::forgetGuards();
        $this->getJson('/api/user')->assertOk()->assertJsonPath('name', 'Novo  Nome');
    }

    public function test_noop_returns_success_without_update_events_or_timestamp_changes(): void
    {
        $before = $this->snapshot();
        $this->travel(10)->minutes();
        User::updating(fn () => throw new RuntimeException('Unexpected save'));
        DB::enableQueryLog();
        try {
            $this->patchJson(self::URL, ['name' => ' Nome Original ', 'expected_name' => 'Nome Original'])->assertOk();
            foreach (DB::getQueryLog() as $query) {
                $this->assertDoesNotMatchRegularExpression('/^\s*(insert|update|delete)\b/i', $query['query']);
            }
        } finally {
            DB::disableQueryLog();
            User::flushEventListeners();
        }
        $this->assertSame($before, $this->snapshot());
    }

    public static function invalidPayloads(): array
    {
        $cases = [[[], 'name'], [['name' => 'Novo'], 'expected_name'], [['expected_name' => 'Nome Original'], 'name']];
        foreach (['name', 'expected_name'] as $field) {
            foreach ([null, '', '   ', [], 1, false, str_repeat('é', 256), "\0Nome", "Nome\0", "a\0b"] as $value) {
                $cases[] = [array_replace(['name' => 'Novo', 'expected_name' => 'Nome Original'], [$field => $value]), $field];
            }
        }
        foreach (['email', 'role', 'password', 'password_confirmation', 'disabled_at', 'session_version', 'id', 'created_at', 'updated_at', 'email_verified_at', 'remember_token', 'expected_email', 'permissions'] as $field) {
            $cases[] = [['name' => 'Novo', 'expected_name' => 'Nome Original', $field => null], 'payload'];
        }

        return $cases;
    }

    #[DataProvider('invalidPayloads')]
    public function test_invalid_payloads_never_write(array $payload, string $field): void
    {
        $before = $this->snapshot();
        $this->patchJson(self::URL, $payload)->assertUnprocessable()->assertJsonValidationErrors($field);
        $this->assertSame($before, $this->snapshot());
    }

    public function test_query_parameters_are_rejected_even_if_they_are_allowed_body_fields(): void
    {
        $before = $this->snapshot();
        foreach (['name=Novo', 'expected_name=Nome+Original', 'role=admin'] as $query) {
            $this->patchJson(self::URL.'?'.$query, ['name' => 'Novo', 'expected_name' => 'Nome Original'])
                ->assertUnprocessable()->assertJsonValidationErrors('payload');
        }
        $this->assertSame($before, $this->snapshot());
    }

    public function test_maximum_unicode_name_and_exact_legacy_original_are_supported(): void
    {
        $this->user->update(['name' => '  Original  ']);
        $this->patchJson(self::URL, ['name' => str_repeat('é', 255), 'expected_name' => '  Original  '])
            ->assertOk()->assertJsonPath('data.name', str_repeat('é', 255));
    }

    public function test_file_uploads_are_rejected_without_changes(): void
    {
        $before = $this->snapshot();
        $this->call('PATCH', self::URL, ['name' => 'Novo Nome', 'expected_name' => 'Nome Original'],
            files: ['avatar' => UploadedFile::fake()->create('avatar.txt', 1)], server: ['HTTP_ACCEPT' => 'application/json', 'HTTP_ORIGIN' => 'http://localhost:5173'])
            ->assertUnprocessable()->assertJsonValidationErrors('payload');
        $this->assertSame($before, $this->snapshot());
    }

    public function test_stale_preconditions_conflict_even_when_replacement_equals_current_name(): void
    {
        foreach (['Novo Nome', 'Nome Original'] as $name) {
            $before = $this->snapshot();
            $this->patchJson(self::URL, ['name' => $name, 'expected_name' => 'Outro Nome'])
                ->assertConflict()->assertJsonPath('code', 'profile_changed')->assertJsonMissingPath('data');
            $this->assertSame($before, $this->snapshot());
            $this->assertSame(0, DB::transactionLevel());
        }
    }

    public function test_guest_disabled_and_revoked_sessions_are_rejected_before_validation(): void
    {
        Auth::forgetGuards();
        $this->getJson('/api/user')->assertUnauthorized();
        $this->patchJson(self::URL, [])->assertUnauthorized();
        $this->user->update(['disabled_at' => now()]);
        $this->actingAs($this->user->fresh(), 'web')->withSession([SessionVersion::KEY => 7]);
        $this->patchJson(self::URL, [])->assertForbidden();
        $this->user->update(['disabled_at' => null]);
        $this->actingAs($this->user->fresh(), 'web')->withSession([SessionVersion::KEY => 6]);
        $this->patchJson(self::URL, [])->assertUnauthorized()->assertJsonPath('code', 'session_revoked');
        $this->assertSame('Nome Original', $this->user->fresh()->name);
    }

    public static function cutovers(): array
    {
        return [[['disabled_at' => '2026-01-01'], 403], [['session_version' => 8], 401], [['name' => 'Alterado pela administração'], 409]];
    }

    #[DataProvider('cutovers')]
    public function test_state_is_revalidated_after_validation(array $changes, int $status): void
    {
        $before = null;
        $this->app->afterResolving(UpdateUserProfileRequest::class, function () use ($changes, &$before): void {
            User::whereKey($this->user->id)->update($changes);
            $before = $this->snapshot();
        });
        $response = $this->patchJson(self::URL, ['name' => 'Não salvar', 'expected_name' => 'Nome Original'])->assertStatus($status);
        if ($status === 401) {
            $response->assertJsonPath('code', 'session_revoked');
        } elseif ($status === 409) {
            $response->assertJsonPath('code', 'profile_changed');
        }
        $this->assertNotNull($before);
        $this->assertSame($before, $this->snapshot());
    }

    public function test_admin_and_self_edits_detect_stale_forms_in_both_directions(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $original = ['name' => 'Novo Nome', 'expected_name' => 'Nome Original'];
        $this->patchJson(self::URL, $original)->assertOk();
        Auth::forgetGuards();
        $this->actingAs($admin, 'web')->withSession([SessionVersion::KEY => 0]);
        $before = $this->snapshot();
        $this->patchJson('/api/admin/users/'.$this->user->id, [...$original, 'email' => 'changed@example.invalid', 'expected_email' => $this->user->email])
            ->assertConflict()->assertJsonPath('code', 'profile_changed');
        $this->assertSame($before, $this->snapshot());
        $this->patchJson('/api/admin/users/'.$this->user->id, ['name' => 'Nome do administrador', 'expected_name' => 'Novo Nome'])->assertOk();
        Auth::forgetGuards();
        $this->actingAs($this->user->fresh(), 'web')->withSession([SessionVersion::KEY => 7]);
        $before = $this->snapshot();
        $this->patchJson(self::URL, ['name' => 'Não salvar', 'expected_name' => 'Novo Nome'])->assertConflict()->assertJsonPath('code', 'profile_changed');
        $this->assertSame($before, $this->snapshot());
    }

    public function test_unrelated_administrative_changes_are_preserved_in_the_fresh_record(): void
    {
        $this->app->afterResolving(UpdateUserProfileRequest::class, function (): void {
            User::whereKey($this->user->id)->update(['email' => 'admin-change@example.invalid', 'role' => 'technician']);
        });
        $this->patchJson(self::URL, ['name' => 'Novo Nome', 'expected_name' => 'Nome Original'])->assertOk()
            ->assertJsonPath('data.email', 'admin-change@example.invalid')->assertJsonPath('data.role', 'technician');
        $this->assertSame(7, $this->user->fresh()->session_version);
    }

    public function test_account_removed_after_validation_is_rejected_as_revoked(): void
    {
        $this->app->afterResolving(UpdateUserProfileRequest::class, function (): void {
            User::whereKey($this->user->id)->delete();
        });
        $this->patchJson(self::URL, ['name' => 'Não salvar', 'expected_name' => 'Nome Original'])
            ->assertUnauthorized()->assertJsonPath('code', 'session_revoked');
        $this->assertDatabaseMissing('users', ['id' => $this->user->id]);
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_database_failure_returns_safe_503_and_rolls_back(): void
    {
        DB::statement("CREATE TRIGGER profile_failure AFTER UPDATE ON users BEGIN SELECT RAISE(ABORT, 'private database detail'); END");
        $before = $this->snapshot();
        $this->patchJson(self::URL, ['name' => 'Rollback', 'expected_name' => 'Nome Original'])
            ->assertStatus(503)->assertExactJson(['message' => 'Não foi possível alterar o nome no momento.']);
        $this->assertSame($before, $this->snapshot());
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_observer_failure_rolls_back(): void
    {
        $before = $this->snapshot();
        User::updated(fn () => throw new RuntimeException('Observer failure'));
        $this->withoutExceptionHandling();
        try {
            $this->patchJson(self::URL, ['name' => 'Rollback', 'expected_name' => 'Nome Original']);
            $this->fail('Expected observer failure');
        } catch (RuntimeException $exception) {
            $this->assertSame('Observer failure', $exception->getMessage());
        } finally {
            User::flushEventListeners();
        }
        $this->assertSame($before, $this->snapshot());
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_real_cookie_session_requires_csrf_and_preserves_session_after_success(): void
    {
        Auth::forgetGuards();
        $this->postJson('/api/login', ['email' => $this->user->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $token = session()->token();
        $this->app->instance('env', 'local');
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId);
        $payload = ['name' => 'Novo Nome', 'expected_name' => 'Nome Original'];
        $before = $this->snapshot();
        $this->patchJson(self::URL, $payload)->assertStatus(419);
        $this->withHeader('X-CSRF-TOKEN', 'invalid')->patchJson(self::URL, $payload)->assertStatus(419);
        $this->assertSame($before, $this->snapshot());
        Auth::forgetGuards();
        $this->withHeader('X-CSRF-TOKEN', $token)->patchJson(self::URL, $payload)->assertOk();
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($token, session()->token());
        $this->assertSame(7, session()->get(SessionVersion::KEY));
    }
}
