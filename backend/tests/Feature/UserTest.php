<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class UserTest extends TestCase
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

    public function test_active_user_can_be_retrieved_using_the_existing_login_session(): void
    {
        $user = User::factory()->create();
        $this->loginUsingSession($user);

        $this->getJson('/api/user')->assertOk();

        $this->assertAuthenticatedAs($user, 'web');
    }

    public function test_response_contains_only_the_four_allowed_fields(): void
    {
        $user = User::factory()->create([
            'role' => 'technician',
            'email_verified_at' => now(),
            'remember_token' => 'private-remember-token',
        ]);
        $this->loginUsingSession($user);

        $this->getJson('/api/user')
            ->assertOk()
            ->assertExactJson([
                'id' => $user->id,
                'name' => $user->name,
                'email' => $user->email,
                'role' => 'technician',
            ]);
    }

    public function test_guest_cannot_retrieve_the_current_user(): void
    {
        $this->getJson('/api/user')->assertUnauthorized();

        $this->assertGuest('web');
    }

    public function test_disabled_authenticated_user_is_forbidden(): void
    {
        $user = User::factory()->create(['disabled_at' => now()]);

        $this->actingAs($user, 'web')
            ->getJson('/api/user')
            ->assertForbidden()
            ->assertJsonMissingPath('email')
            ->assertJsonMissingPath('disabled_at');
    }

    public function test_user_disabled_after_login_cannot_retrieve_the_current_user(): void
    {
        $user = User::factory()->create();
        $this->loginUsingSession($user);
        $this->getJson('/api/user')->assertOk();

        $user->update(['disabled_at' => now()]);
        Auth::forgetGuards();

        $this->getJson('/api/user')->assertForbidden();
    }

    public function test_user_route_uses_sanctum_authentication(): void
    {
        $route = Route::getRoutes()->match(Request::create('/api/user', 'GET'));

        $this->assertContains('auth:sanctum', $route->gatherMiddleware());
    }

    public function test_endpoint_does_not_modify_records_create_tokens_or_rotate_the_session(): void
    {
        $user = User::factory()->create();
        $this->loginUsingSession($user);
        $sessionId = session()->getId();
        $csrfToken = session()->token();
        $before = DB::table('users')->orderBy('id')->get()->toJson();
        DB::enableQueryLog();

        $this->getJson('/api/user')->assertOk();

        $queries = DB::getQueryLog();
        DB::disableQueryLog();

        foreach ($queries as $query) {
            $this->assertDoesNotMatchRegularExpression(
                '/^\s*(insert|update|delete|replace|create|alter|drop|truncate)\b/i',
                $query['query'],
            );
        }

        $this->assertSame($before, DB::table('users')->orderBy('id')->get()->toJson());
        $this->assertDatabaseCount('sessions', 0);
        $this->assertDatabaseCount('password_reset_tokens', 0);
        $this->assertFalse(Schema::hasTable('personal_access_tokens'));
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($csrfToken, session()->token());
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
