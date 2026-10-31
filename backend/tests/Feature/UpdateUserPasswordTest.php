<?php

namespace Tests\Feature;

use App\Http\Requests\UpdateUserPasswordRequest;
use App\Models\User;
use App\Services\ChangeUserPassword;
use App\Support\SessionVersion;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\Support\PasswordFixtures;
use Tests\TestCase;

class UpdateUserPasswordTest extends TestCase
{
    use PasswordFixtures;

    private const URL = '/api/user/password';

    private const CURRENT = 'Current!Password123';

    private const NEXT = 'Different!Password456';

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertSame('sqlite', DB::connection()->getDriverName());
        $this->assertSame(':memory:', DB::connection()->getDatabaseName());
        $this->createPasswordFixtures();
        config(['logging.default' => 'null', 'sanctum.stateful' => ['localhost:5173']]);
        $this->withHeader('Origin', 'http://localhost:5173');
        $this->user = User::factory()->create(['password' => self::CURRENT, 'session_version' => 4]);
        $this->actingAs($this->user, 'web')->withSession([SessionVersion::KEY => 4]);
    }

    private function payload(array $changes = []): array
    {
        return array_replace(['current_password' => self::CURRENT, 'password' => self::NEXT, 'password_confirmation' => self::NEXT], $changes);
    }

    public static function roles(): array
    {
        return [['requester'], ['technician'], ['admin']];
    }

    #[DataProvider('roles')]
    public function test_success_revokes_all_sessions_and_preserves_all_other_attributes_and_links(string $role): void
    {
        $this->user->forceFill(['role' => $role, 'remember_token' => 'unchanged-token'])->save();
        $other = User::factory()->create();
        $otherBefore = $other->fresh()->getAttributes();
        foreach (['one', 'two'] as $id) {
            DB::table('sessions')->insert(['id' => $id, 'user_id' => $this->user->id, 'payload' => 'opaque', 'last_activity' => time()]);
        }
        DB::table('sessions')->insert(['id' => 'other', 'user_id' => $other->id, 'payload' => 'opaque', 'last_activity' => time()]);
        $ticket = DB::table('tickets')->insertGetId(['requester_id' => $this->user->id, 'assigned_to' => $this->user->id, 'title' => 'Preserved']);
        DB::table('ticket_comments')->insert(['ticket_id' => $ticket, 'user_id' => $this->user->id, 'body' => 'Preserved']);
        DB::table('ticket_activities')->insert(['ticket_id' => $ticket, 'actor_id' => $this->user->id, 'action' => 'preserved']);
        $before = $this->user->fresh()->getAttributes();
        $links = $this->passwordSnapshot();
        unset($links['users'], $links['sessions']);
        $this->travel(1)->minutes();
        $response = $this->putJson(self::URL, $this->payload())->assertOk()->assertExactJson([
            'message' => 'Senha alterada. Todas as sessões foram encerradas. Entre novamente.',
            'code' => 'password_changed', 'reauthentication_required' => true,
        ])->assertHeader('Cache-Control', 'no-store, private');
        $fresh = $this->user->fresh();
        $this->assertTrue(Hash::check(self::NEXT, $fresh->password));
        $this->assertFalse(Hash::check(self::CURRENT, $fresh->password));
        $this->assertSame(5, $fresh->session_version);
        foreach ($before as $field => $value) {
            if (! in_array($field, ['password', 'session_version', 'updated_at'], true)) {
                $this->assertSame($value, $fresh->getAttributes()[$field], $field);
            }
        }
        $this->assertSame($otherBefore, $other->fresh()->getAttributes());
        $afterLinks = $this->passwordSnapshot();
        unset($afterLinks['users'], $afterLinks['sessions']);
        $this->assertSame($links, $afterLinks);
        $this->assertSame(0, DB::table('sessions')->where('user_id', $this->user->id)->count());
        $this->assertDatabaseHas('sessions', ['id' => 'other', 'user_id' => $other->id]);
        $this->assertGuest('web');
        $this->assertFalse(session()->has(SessionVersion::KEY));
        foreach ([self::CURRENT, self::NEXT, $before['password'], $fresh->password] as $secret) {
            $response->assertDontSee($secret, false);
        }
        Auth::forgetGuards();
        $this->getJson('/api/user')->assertUnauthorized();
        $this->postJson('/api/login', ['email' => $fresh->email, 'password' => self::CURRENT])->assertUnauthorized();
        $this->postJson('/api/login', ['email' => $fresh->email, 'password' => self::NEXT])->assertOk()->assertSessionHas(SessionVersion::KEY, 5);
    }

    public static function invalidPasswords(): array
    {
        $cases = [];
        foreach (['current_password', 'password', 'password_confirmation'] as $field) {
            foreach ([null, '', [], 12, false, "\0Secret", "Sec\0ret", "Secret\0", str_repeat('é', 37)] as $value) {
                $cases[] = [[$field => $value], $field];
            }
        }
        foreach (['short', 'onlylowercase123!', 'ONLYUPPERCASE123!', 'NoNumbersAllowed!', 'NoSymbolsAllowed123'] as $value) {
            $cases[] = [['password' => $value, 'password_confirmation' => $value], 'password'];
        }
        $cases[] = [['current_password' => 'Wrong!Password123'], 'current_password'];
        $cases[] = [['password_confirmation' => 'Another!Password123'], 'password'];
        $cases[] = [['password' => self::CURRENT, 'password_confirmation' => self::CURRENT], 'password'];

        return $cases;
    }

    #[DataProvider('invalidPasswords')]
    public function test_invalid_or_reused_passwords_never_change_data_or_revoke_the_session(array $changes, string $field): void
    {
        $before = $this->passwordSnapshot();
        Log::spy();
        $this->putJson(self::URL, $this->payload($changes))->assertUnprocessable()->assertJsonValidationErrors($field);
        $this->assertSame($before, $this->passwordSnapshot());
        $this->assertAuthenticatedAs($this->user, 'web');
        $this->assertSame(4, session()->get(SessionVersion::KEY));
        Log::shouldNotHaveReceived('error');
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_required_fields_extra_fields_and_query_strings_are_rejected(): void
    {
        $before = $this->passwordSnapshot();
        $this->putJson(self::URL, [])->assertUnprocessable()->assertJsonValidationErrors(['current_password', 'password', 'password_confirmation']);
        foreach (['id', 'user_id', 'name', 'email', 'role', 'disabled_at', 'session_version', 'remember_token'] as $field) {
            $this->travel(61)->seconds();
            $this->putJson(self::URL, [...$this->payload(), $field => null])->assertUnprocessable()->assertJsonValidationErrors('payload');
        }
        $this->putJson(self::URL.'?password=ignored', $this->payload())->assertUnprocessable()->assertJsonValidationErrors('payload');
        $this->assertSame($before, $this->passwordSnapshot());
    }

    public function test_spaces_are_not_trimmed_and_confirmation_must_match_exactly(): void
    {
        $this->user->update(['password' => ' '.self::CURRENT.' ']);
        $next = ' '.self::NEXT.' ';
        $this->putJson(self::URL, $this->payload(['current_password' => self::CURRENT]))->assertUnprocessable()->assertJsonValidationErrors('current_password');
        $this->putJson(self::URL, $this->payload(['current_password' => ' '.self::CURRENT.' ', 'password' => $next]))->assertUnprocessable()->assertJsonValidationErrors('password');
        $this->putJson(self::URL, $this->payload(['current_password' => ' '.self::CURRENT.' ', 'password' => $next, 'password_confirmation' => $next]))->assertOk();
        $this->assertTrue(Hash::check($next, $this->user->fresh()->password));
        $this->assertFalse(Hash::check(trim($next), $this->user->fresh()->password));
    }

    public function test_file_uploads_are_rejected(): void
    {
        $before = $this->passwordSnapshot();
        $this->call('PUT', self::URL, $this->payload(), files: ['extra' => UploadedFile::fake()->create('extra.txt', 1)],
            server: ['HTTP_ACCEPT' => 'application/json', 'HTTP_ORIGIN' => 'http://localhost:5173'])
            ->assertUnprocessable()->assertJsonValidationErrors('payload');
        $this->assertSame($before, $this->passwordSnapshot());
    }

    public function test_sessionless_authentication_is_rejected_without_password_changes(): void
    {
        config(['sanctum.stateful' => []]);
        $this->user->forceFill(['session_version' => 0])->save();
        $this->actingAs($this->user->fresh(), 'web');
        $before = $this->passwordSnapshot();
        $this->putJson(self::URL, $this->payload())->assertStatus(419);
        $this->assertSame($before, $this->passwordSnapshot());
    }

    public function test_exactly_72_bytes_is_accepted(): void
    {
        $next = 'Aa1!'.str_repeat('é', 34);
        $this->assertSame(72, strlen($next));
        $this->putJson(self::URL, $this->payload(['password' => $next, 'password_confirmation' => $next]))->assertOk();
        $this->assertTrue(Hash::check($next, $this->user->fresh()->password));
    }

    public function test_hash_shaped_input_is_hashed_as_a_literal_password(): void
    {
        $next = '$2y$12$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.';
        $this->putJson(self::URL, $this->payload(['password' => $next, 'password_confirmation' => $next]))->assertOk();
        $this->assertNotSame($next, $this->user->fresh()->password);
        $this->assertTrue(Hash::check($next, $this->user->fresh()->password));
    }

    public function test_guest_disabled_and_revoked_sessions_cannot_reach_validation(): void
    {
        Auth::forgetGuards();
        $this->putJson(self::URL, [])->assertUnauthorized();
        $this->actingAs($this->user, 'web')->withSession([SessionVersion::KEY => 3]);
        $this->putJson(self::URL, [])->assertUnauthorized()->assertJsonPath('code', 'session_revoked');
        Auth::forgetGuards();
        $this->user->update(['disabled_at' => now()]);
        $this->actingAs($this->user->fresh(), 'web')->withSession([SessionVersion::KEY => 4]);
        $this->putJson(self::URL, [])->assertForbidden();
    }

    public static function cutovers(): array
    {
        return [[['session_version' => 5], 401], [['disabled_at' => '2026-01-01'], 403], [['role' => 'unknown'], 403], [['password' => 'Another!Current123'], 422]];
    }

    #[DataProvider('cutovers')]
    public function test_fresh_state_and_hash_are_rechecked_under_lock(array $changes, int $status): void
    {
        $before = null;
        $this->app->afterResolving(UpdateUserPasswordRequest::class, function () use ($changes, &$before): void {
            $this->user->fresh()->forceFill($changes)->save();
            $before = $this->passwordSnapshot();
        });
        $response = $this->putJson(self::URL, $this->payload())->assertStatus($status);
        if ($status === 401) {
            $response->assertJsonPath('code', 'session_revoked');
        } elseif ($status === 422) {
            $response->assertJsonValidationErrors('current_password');
        }
        $this->assertNotNull($before);
        $this->assertSame($before, $this->passwordSnapshot());
    }

    public function test_version_exhaustion_changes_nothing(): void
    {
        $this->user->forceFill(['session_version' => PHP_INT_MAX])->save();
        $this->actingAs($this->user->fresh(), 'web')->withSession([SessionVersion::KEY => PHP_INT_MAX]);
        $before = $this->passwordSnapshot();
        $this->putJson(self::URL, $this->payload())->assertConflict()->assertJsonPath('code', 'session_version_exhausted');
        $this->assertSame($before, $this->passwordSnapshot());
    }

    public function test_user_rate_limit_survives_ip_changes_and_expires(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->withServerVariables(['REMOTE_ADDR' => '10.0.0.'.($i + 1)])
                ->putJson(self::URL, $this->payload(['current_password' => 'Wrong!Password123']))->assertUnprocessable();
        }
        $before = $this->passwordSnapshot();
        $this->withServerVariables(['REMOTE_ADDR' => '10.1.0.1'])->putJson(self::URL, $this->payload())
            ->assertStatus(429)->assertHeader('Retry-After');
        $this->assertSame($before, $this->passwordSnapshot());
        $this->travel(61)->seconds();
        $this->putJson(self::URL, $this->payload())->assertOk();
    }

    public function test_ip_rate_limit_covers_multiple_accounts_and_counts_invalid_payloads(): void
    {
        for ($account = 0; $account < 5; $account++) {
            Auth::forgetGuards();
            $this->flushSession();
            $user = User::factory()->create(['password' => self::CURRENT]);
            $this->actingAs($user, 'web')->withSession([SessionVersion::KEY => 0]);
            if ($account === 4) {
                $this->putJson(self::URL, [])->assertStatus(429);
            } else {
                for ($i = 0; $i < 5; $i++) {
                    $this->putJson(self::URL, [])->assertUnprocessable();
                }
            }
        }
    }

    public function test_session_deletion_failure_rolls_back_hash_version_and_sessions_with_safe_logging(): void
    {
        DB::table('sessions')->insert(['id' => 'device', 'user_id' => $this->user->id, 'payload' => 'opaque', 'last_activity' => time()]);
        DB::statement("CREATE TRIGGER password_failure BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'sensitive-internal-marker'); END");
        $before = $this->passwordSnapshot();
        Log::spy();
        $this->putJson(self::URL, $this->payload())->assertStatus(503)->assertExactJson([
            'message' => 'Não foi possível alterar a senha no momento.', 'code' => 'password_change_unavailable',
        ]);
        Log::shouldHaveReceived('error')->once()->with('Falha ao alterar senha.', ['code' => 'password_change_unavailable']);
        $this->assertSame($before, $this->passwordSnapshot());
        $this->assertAuthenticatedAs($this->user, 'web');
        $this->assertSame(4, session()->get(SessionVersion::KEY));
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_observer_failure_is_rolled_back_and_sensitive_exception_is_not_logged(): void
    {
        $before = $this->passwordSnapshot();
        User::updated(fn () => throw new RuntimeException('Sensitive '.self::NEXT.' '.$this->user->password));
        Log::spy();
        try {
            $this->putJson(self::URL, $this->payload())->assertStatus(503)->assertJsonPath('code', 'password_change_unavailable');
        } finally {
            User::flushEventListeners();
        }
        Log::shouldHaveReceived('error')->once()->with('Falha ao alterar senha.', ['code' => 'password_change_unavailable']);
        $this->assertSame($before, $this->passwordSnapshot());
    }

    public static function invalidStores(): array
    {
        return [[['session.driver' => 'file']], [['session.driver' => 'database', 'session.connection' => 'different_connection']]];
    }

    #[DataProvider('invalidStores')]
    public function test_unsupported_session_stores_are_rejected_without_opening_them(array $config): void
    {
        $request = Request::create(self::URL, 'PUT');
        $request->setUserResolver(fn () => $this->user);
        $request->setLaravelSession(session()->driver());
        SessionVersion::capture($request);
        $before = $this->passwordSnapshot();
        config($config);
        try {
            (new ChangeUserPassword)->change($request, $this->payload());
            $this->fail('Unsupported store accepted');
        } catch (HttpResponseException $exception) {
            $this->assertSame(503, $exception->getResponse()->getStatusCode());
        }
        $this->assertSame($before, $this->passwordSnapshot());
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_real_database_cookie_requires_csrf_and_current_session_is_anonymous_after_success(): void
    {
        config(['session.driver' => 'database', 'session.connection' => DB::getDefaultConnection()]);
        app('session')->forgetDrivers();
        app()->forgetInstance('session.store');
        app()->forgetInstance('auth.driver');
        Auth::forgetGuards();
        $this->postJson('/api/login', ['email' => $this->user->email, 'password' => self::CURRENT])->assertOk();
        $id = session()->getId();
        $token = session()->token();
        $this->app->instance('env', 'local');
        app()->forgetInstance('auth.driver');
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $id);
        $before = $this->passwordSnapshot();
        $this->putJson(self::URL, $this->payload())->assertStatus(419);
        $this->withHeader('X-CSRF-TOKEN', 'invalid')->putJson(self::URL, $this->payload())->assertStatus(419);
        $this->assertSame($before['users'], $this->passwordSnapshot()['users']);
        app()->forgetInstance('auth.driver');
        Auth::forgetGuards();
        $this->withHeader('X-CSRF-TOKEN', $token)->putJson(self::URL, $this->payload())->assertOk();
        $this->assertNotSame($id, session()->getId());
        $this->assertNotSame($token, session()->token());
        $this->assertFalse(session()->has(SessionVersion::KEY));
        $this->assertSame(0, DB::table('sessions')->where('user_id', $this->user->id)->count());
        Auth::forgetGuards();
        $this->getJson('/api/user')->assertUnauthorized();
    }
}
