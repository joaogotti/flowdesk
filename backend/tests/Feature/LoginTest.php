<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class LoginTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();

        $this->assertSame('sqlite', config('database.default'));
        $this->assertSame(':memory:', config('database.connections.sqlite.database'));

        // Os CHECKs das migrations incrementais são específicos do PostgreSQL.
        $migration = require database_path('migrations/0001_01_01_000000_create_users_table.php');
        $migration->up();

        Schema::table('users', function (Blueprint $table) {
            $table->string('role', 20)->default('requester');
            $table->timestampTz('disabled_at')->nullable();
        });

        config(['sanctum.stateful' => ['localhost:5173']]);
        $this->withHeader('Origin', 'http://localhost:5173');
    }

    public function test_active_user_can_login_with_a_safe_response_and_authenticated_session(): void
    {
        $user = User::factory()->create(['email' => 'active@example.com', 'role' => 'technician']);
        $this->withSession(['_token' => 'original-csrf-token']);
        $previousSessionId = session()->getId();

        $this->postJson('/api/login', ['email' => 'active@example.com', 'password' => 'password'])
            ->assertOk()
            ->assertExactJson([
                'id' => $user->id,
                'name' => $user->name,
                'email' => $user->email,
                'role' => 'technician',
            ])
            ->assertSessionHas(Auth::guard('web')->getName(), $user->id);

        $this->assertAuthenticatedAs($user, 'web');
        $this->assertNotSame($previousSessionId, session()->getId());
        $this->assertNotSame('original-csrf-token', session()->token());
        $this->assertFalse(Schema::hasTable('personal_access_tokens'));

        $sessionId = session()->getId();
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
            ->getJson('/api/health')->assertOk();
        $this->assertAuthenticatedAs($user, 'web');
    }

    public function test_incorrect_password_is_rejected_with_a_generic_message(): void
    {
        User::factory()->create(['email' => 'active@example.com']);

        $this->postJson('/api/login', ['email' => 'active@example.com', 'password' => 'incorrect'])
            ->assertUnauthorized()
            ->assertExactJson(['message' => 'Credenciais inválidas.']);

        $this->assertGuest('web');
    }

    public function test_nonexistent_email_has_the_same_generic_failure(): void
    {
        $this->postJson('/api/login', ['email' => 'unknown@example.com', 'password' => 'password'])
            ->assertUnauthorized()
            ->assertExactJson(['message' => 'Credenciais inválidas.']);

        $this->assertGuest('web');
    }

    public function test_disabled_user_cannot_login_even_with_the_correct_password(): void
    {
        User::factory()->create(['email' => 'disabled@example.com', 'disabled_at' => now()]);

        $this->postJson('/api/login', ['email' => 'disabled@example.com', 'password' => 'password'])
            ->assertUnauthorized()
            ->assertExactJson(['message' => 'Credenciais inválidas.']);

        $this->assertGuest('web');
    }

    public function test_invalid_input_returns_json_validation_errors(): void
    {
        $this->postJson('/api/login', [])
            ->assertUnprocessable()->assertJsonValidationErrors(['email', 'password']);
        $this->postJson('/api/login', ['email' => 'not-an-email', 'password' => ['invalid']])
            ->assertUnprocessable()->assertJsonValidationErrors(['email', 'password']);
        $this->assertGuest('web');
    }

    public function test_five_failed_attempts_block_the_next_attempt_for_one_minute(): void
    {
        User::factory()->create(['email' => 'active@example.com']);

        for ($attempt = 0; $attempt < 5; $attempt++) {
            $this->postJson('/api/login', ['email' => 'active@example.com', 'password' => 'incorrect'])
                ->assertUnauthorized();
        }

        $this->postJson('/api/login', ['email' => ' ACTIVE@EXAMPLE.COM ', 'password' => 'password'])
            ->assertTooManyRequests()->assertHeader('Retry-After');
        $this->assertGuest('web');

        $this->travel(61)->seconds();

        $this->postJson('/api/login', ['email' => 'active@example.com', 'password' => 'password'])
            ->assertOk();
    }

    public function test_successful_login_clears_previous_failed_attempts(): void
    {
        User::factory()->create(['email' => 'active@example.com']);

        for ($attempt = 0; $attempt < 4; $attempt++) {
            $this->postJson('/api/login', ['email' => 'active@example.com', 'password' => 'incorrect'])
                ->assertUnauthorized();
        }

        $this->postJson('/api/login', ['email' => 'active@example.com', 'password' => 'password'])
            ->assertOk();
        Auth::guard('web')->logout();

        for ($attempt = 0; $attempt < 5; $attempt++) {
            $this->postJson('/api/login', ['email' => 'active@example.com', 'password' => 'incorrect'])
                ->assertUnauthorized();
        }

        $this->postJson('/api/login', ['email' => 'active@example.com', 'password' => 'incorrect'])
            ->assertTooManyRequests();
    }

    public function test_limiter_separates_email_and_ip_and_ignores_untrusted_forwarded_headers(): void
    {
        for ($attempt = 0; $attempt < 5; $attempt++) {
            $this->postJson('/api/login', ['email' => 'unknown@example.com', 'password' => 'incorrect'])
                ->assertUnauthorized();
        }

        $this->withHeader('X-Forwarded-For', '203.0.113.10')
            ->postJson('/api/login', ['email' => 'unknown@example.com', 'password' => 'incorrect'])
            ->assertTooManyRequests();

        $this->postJson('/api/login', ['email' => 'another@example.com', 'password' => 'incorrect'])
            ->assertUnauthorized();

        $this->withServerVariables(['REMOTE_ADDR' => '192.0.2.10'])
            ->postJson('/api/login', ['email' => 'unknown@example.com', 'password' => 'incorrect'])
            ->assertUnauthorized();
    }

    public function test_csrf_protection_is_enforced_outside_the_test_bypass(): void
    {
        User::factory()->create(['email' => 'active@example.com']);
        $this->app->instance('env', 'local');

        $this->postJson('/api/login', ['email' => 'active@example.com', 'password' => 'password'])
            ->assertStatus(419);
        $this->assertGuest('web');

        $this->withSession(['_token' => 'valid-csrf-token'])
            ->withHeader('X-CSRF-TOKEN', 'valid-csrf-token')
            ->postJson('/api/login', ['email' => 'active@example.com', 'password' => 'password'])
            ->assertOk();
    }

    public function test_request_without_a_stateful_session_is_rejected_without_server_error(): void
    {
        $this->withoutHeader('Origin')
            ->postJson('/api/login', ['email' => 'active@example.com', 'password' => 'password'])
            ->assertStatus(419);
        $this->assertGuest('web');
    }
}
