<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Http\Request;
use Illuminate\Session\Store;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class LogoutTest extends TestCase
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
            $table->bigInteger('session_version')->default(0);
        });

        config(['sanctum.stateful' => ['localhost:5173']]);
        $this->withHeader('Origin', 'http://localhost:5173');
    }

    public function test_authenticated_user_can_logout_using_the_existing_session(): void
    {
        $this->loginUsingSession(User::factory()->create());

        $this->postJson('/api/logout')->assertNoContent();

        $this->assertGuest('web');
    }

    public function test_logout_returns_204_with_an_empty_body(): void
    {
        $this->loginUsingSession(User::factory()->create());

        $this->postJson('/api/logout')
            ->assertNoContent()
            ->assertContent('');
    }

    public function test_user_endpoint_is_unauthorized_after_logout(): void
    {
        $this->loginUsingSession(User::factory()->create());
        $this->getJson('/api/user')->assertOk();
        $this->postJson('/api/logout')->assertNoContent();
        $sessionId = session()->getId();
        Auth::forgetGuards();

        $this->withCookie(config('session.cookie'), $sessionId)
            ->getJson('/api/user')->assertUnauthorized();
    }

    public function test_guest_cannot_logout(): void
    {
        $this->postJson('/api/logout')->assertUnauthorized();

        $this->assertGuest('web');
    }

    public function test_logout_invalidates_the_session_and_destroys_its_old_data(): void
    {
        $this->loginUsingSession(User::factory()->create());
        $this->withSession(['private_data' => 'session-only-value']);
        $sessionId = session()->getId();
        $handler = session()->getHandler();
        $this->assertNotEmpty($handler->read($sessionId));

        $this->postJson('/api/logout')
            ->assertNoContent()
            ->assertSessionMissing('private_data')
            ->assertSessionMissing(Auth::guard('web')->getName());

        $this->assertNotSame($sessionId, session()->getId());
        $this->assertSame('', $handler->read($sessionId));
        Auth::forgetGuards();

        $this->withCookie(config('session.cookie'), $sessionId)
            ->getJson('/api/user')->assertUnauthorized();
    }

    public function test_logout_regenerates_the_csrf_token(): void
    {
        $this->loginUsingSession(User::factory()->create());
        $csrfToken = session()->token();
        $this->assertNotEmpty($csrfToken);

        $this->postJson('/api/logout')->assertNoContent();

        $this->assertNotEmpty(session()->token());
        $this->assertNotSame($csrfToken, session()->token());
    }

    public function test_logout_does_not_delete_or_modify_any_user_including_remember_tokens(): void
    {
        $user = User::factory()->create(['remember_token' => 'existing-remember-token']);
        User::factory()->create();
        $this->loginUsingSession($user);
        $before = DB::table('users')->orderBy('id')->get()->toJson();

        $this->postJson('/api/logout')->assertNoContent();

        $this->assertSame($before, DB::table('users')->orderBy('id')->get()->toJson());
        $this->assertDatabaseCount('users', 2);
    }

    public function test_logout_does_not_create_or_access_personal_tokens(): void
    {
        $this->loginUsingSession(User::factory()->create());
        DB::enableQueryLog();

        $this->postJson('/api/logout')->assertNoContent();

        $queries = DB::getQueryLog();
        DB::disableQueryLog();

        foreach ($queries as $query) {
            $this->assertStringNotContainsString('personal_access_tokens', $query['query']);
        }

        $this->assertFalse(Schema::hasTable('personal_access_tokens'));
    }

    public function test_logout_preserves_another_session_for_the_same_user(): void
    {
        $user = User::factory()->create();
        $this->loginUsingSession($user);
        $otherSession = new Store(
            config('session.cookie'),
            session()->getHandler(),
            null,
            config('session.serialization', 'php'),
        );
        $otherSession->start();
        $otherSession->put(Auth::guard('web')->getName(), $user->id);
        $otherSession->put('private_data', 'other-session-value');
        $otherSession->save();
        $before = session()->getHandler()->read($otherSession->getId());

        $this->postJson('/api/logout')->assertNoContent();

        $this->assertSame($before, session()->getHandler()->read($otherSession->getId()));
        Auth::forgetGuards();

        $this->withCookie(config('session.cookie'), $otherSession->getId())
            ->getJson('/api/user')
            ->assertOk()
            ->assertJsonPath('id', $user->id);
        $this->assertAuthenticatedAs($user, 'web');
    }

    public function test_logout_route_uses_sanctum_authentication(): void
    {
        $route = Route::getRoutes()->match(Request::create('/api/logout', 'POST'));

        $this->assertContains('auth:sanctum', $route->gatherMiddleware());
    }

    public function test_logout_requires_a_valid_csrf_token_outside_the_test_bypass(): void
    {
        $user = User::factory()->create();
        $this->loginUsingSession($user);
        $csrfToken = session()->token();
        $this->app->instance('env', 'local');

        $this->postJson('/api/logout')->assertStatus(419);
        $this->assertAuthenticatedAs($user, 'web');

        $this->withHeader('X-CSRF-TOKEN', $csrfToken)
            ->postJson('/api/logout')->assertNoContent();
        $this->assertGuest('web');
    }

    private function loginUsingSession(User $user): void
    {
        $this->postJson('/api/login', ['email' => $user->email, 'password' => 'password'])
            ->assertOk();

        $sessionId = session()->getId();
        Auth::forgetGuards();

        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId);
    }
}
