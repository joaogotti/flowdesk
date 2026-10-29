<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Models\User;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Http\Request;
use Illuminate\Session\Store;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class EnsureUserIsActiveTest extends TestCase
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

    public function test_active_user_can_access_the_protected_route(): void
    {
        $user = User::factory()->create(['role' => 'requester']);
        $this->loginUsingSession($user);

        $this->getJson('/api/user')->assertOk()->assertExactJson([
            'id' => $user->id,
            'name' => $user->name,
            'email' => $user->email,
            'role' => $user->role,
        ]);
    }

    public function test_disabled_authenticated_user_is_forbidden(): void
    {
        $user = User::factory()->create(['disabled_at' => now()]);

        $this->actingAs($user, 'web')->getJson('/api/user')->assertForbidden();
    }

    public function test_user_disabled_after_login_loses_access_on_the_next_request(): void
    {
        $user = User::factory()->create();
        $this->loginUsingSession($user);
        $this->getJson('/api/user')->assertOk();
        $user->update(['disabled_at' => now()]);
        Auth::forgetGuards();

        $this->getJson('/api/user')->assertForbidden();
    }

    public function test_disabled_user_can_still_logout(): void
    {
        $user = User::factory()->create();
        $this->loginUsingSession($user);
        $user->update(['disabled_at' => now()]);
        Auth::forgetGuards();
        $this->getJson('/api/user')->assertForbidden();

        $this->postJson('/api/logout')->assertNoContent()->assertContent('');
        $this->assertGuest('web');
        $sessionId = session()->getId();
        Auth::forgetGuards();

        $this->withCookie(config('session.cookie'), $sessionId)
            ->getJson('/api/user')->assertUnauthorized();
    }

    public function test_guest_receives_401_before_the_active_user_check(): void
    {
        $this->getJson('/api/user')->assertUnauthorized();
    }

    public function test_login_remains_public(): void
    {
        $user = User::factory()->create();
        $this->assertGuest('web');

        $this->postJson('/api/login', ['email' => $user->email, 'password' => 'password'])
            ->assertOk()->assertJsonPath('id', $user->id);
    }

    public function test_health_remains_public(): void
    {
        $this->getJson('/api/health')->assertOk()->assertExactJson([
            'status' => 'ok',
            'application' => 'Flowdesk',
        ]);
        $this->assertGuest('web');
    }

    public function test_forbidden_response_contains_only_a_generic_json_message(): void
    {
        $user = User::factory()->create(['disabled_at' => now()]);

        $this->actingAs($user, 'web')->get('/api/user', ['Accept' => 'text/html'])
            ->assertForbidden()
            ->assertHeader('Content-Type', 'application/json')
            ->assertExactJson(['message' => 'Acesso não permitido.']);
    }

    public function test_blocking_does_not_modify_users_tokens_or_existing_sessions(): void
    {
        $user = User::factory()->create();
        $this->loginUsingSession($user);
        $user->update(['disabled_at' => now()]);
        Auth::forgetGuards();
        $sessionId = session()->getId();
        $csrfToken = session()->token();
        $otherSession = new Store(
            config('session.cookie'), session()->getHandler(), null, config('session.serialization', 'php'),
        );
        $otherSession->start();
        $otherSession->put(Auth::guard('web')->getName(), $user->id);
        $otherSession->save();
        $otherSessionData = session()->getHandler()->read($otherSession->getId());
        $before = DB::table('users')->orderBy('id')->get()->toJson();
        DB::enableQueryLog();

        $this->getJson('/api/user')->assertForbidden();

        $queries = DB::getQueryLog();
        DB::disableQueryLog();
        foreach ($queries as $query) {
            $this->assertDoesNotMatchRegularExpression(
                '/^\s*(insert|update|delete|replace|create|alter|drop|truncate)\b/i', $query['query'],
            );
            $this->assertStringNotContainsString('personal_access_tokens', $query['query']);
        }

        $this->assertSame($before, DB::table('users')->orderBy('id')->get()->toJson());
        $this->assertFalse(Schema::hasTable('personal_access_tokens'));
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($csrfToken, session()->token());
        $this->assertSame($otherSessionData, session()->getHandler()->read($otherSession->getId()));
        $this->assertAuthenticatedAs($user, 'web');
    }

    public function test_alias_is_registered_and_runs_after_sanctum_authentication(): void
    {
        $this->assertSame(EnsureUserIsActive::class, Route::getMiddleware()['user.active']);
        $route = Route::getRoutes()->match(Request::create('/api/user', 'GET'));
        $middleware = Route::gatherRouteMiddleware($route);

        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(
            array_search(EnsureUserIsActive::class, $middleware, true),
            array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true),
        );

        foreach ([['POST', '/api/login'], ['GET', '/api/health'], ['POST', '/api/logout']] as [$method, $uri]) {
            $route = Route::getRoutes()->match(Request::create($uri, $method));
            $this->assertNotContains(EnsureUserIsActive::class, Route::gatherRouteMiddleware($route));
        }
    }

    public function test_middleware_can_protect_another_route_without_controller_checks(): void
    {
        Route::get('/api/test-active-user', fn () => response()->noContent())
            ->middleware(['api', 'auth:sanctum', 'user.active']);
        $user = User::factory()->create();
        $this->loginUsingSession($user);
        $this->getJson('/api/test-active-user')->assertNoContent();
        $user->update(['disabled_at' => now()]);
        Auth::forgetGuards();

        $this->getJson('/api/test-active-user')->assertForbidden();
    }

    private function loginUsingSession(User $user): void
    {
        $this->postJson('/api/login', ['email' => $user->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        Auth::forgetGuards();

        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId);
    }
}
