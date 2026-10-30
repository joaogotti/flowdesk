<?php

namespace Tests\Feature;

use App\Http\Requests\StoreAdminUserRequest;
use App\Http\Requests\StoreCategoryRequest;
use App\Http\Requests\StoreTicketCommentRequest;
use App\Http\Requests\StoreTicketRequest;
use App\Http\Requests\UpdateAdminUserRequest;
use App\Http\Requests\UpdateAdminUserRoleRequest;
use App\Http\Requests\UpdateAdminUserStatusRequest;
use App\Http\Requests\UpdateCategoryRequest;
use App\Http\Requests\UpdateCategoryStatusRequest;
use App\Http\Requests\UpdateTicketAssignmentRequest;
use App\Http\Requests\UpdateTicketDetailsRequest;
use App\Http\Requests\UpdateTicketStatusRequest;
use App\Models\Category;
use App\Models\User;
use App\Support\SessionVersion;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Schema;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\UserRoleFixtures;
use Tests\TestCase;

class UserSessionVersionTest extends TestCase
{
    use UserRoleFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertSame(':memory:', DB::connection()->getDatabaseName());
        $this->createRoleFixtures();
    }

    public function test_login_stores_current_version_without_exposing_it_and_logout_still_works(): void
    {
        $user = User::factory()->create(['session_version' => 7]);
        $this->postJson('/api/login', ['email' => $user->email, 'password' => 'password'])
            ->assertOk()->assertExactJson($user->fresh()->only(['id', 'name', 'email', 'role']))
            ->assertSessionHas(SessionVersion::KEY, 7);
        $this->assertArrayNotHasKey('session_version', $user->fresh()->toArray());
        Auth::forgetGuards();
        $this->getJson('/api/user')->assertOk();
        $this->postJson('/api/logout')->assertNoContent();
        $this->assertGuest('web');
        $this->assertSame(7, $user->fresh()->session_version);
    }

    public function test_legacy_session_is_allowed_only_at_zero_without_being_upgraded(): void
    {
        $user = User::factory()->create();
        $this->actingAs($user, 'web')->getJson('/api/user')->assertOk();
        $this->assertFalse(session()->exists(SessionVersion::KEY));
        DB::table('users')->where('id', $user->id)->update(['session_version' => 2]);
        $this->getJson('/api/user')->assertUnauthorized()->assertJsonPath('code', 'session_revoked');
        $this->assertGuest('web');
        $this->assertFalse(session()->exists(SessionVersion::KEY));
    }

    public static function invalidVersions(): array
    {
        return [[null], [-1], ['0'], [0.0], [true], [[]], [1]];
    }

    #[DataProvider('invalidVersions')]
    public function test_invalid_or_stale_session_versions_require_login(mixed $version): void
    {
        $user = User::factory()->create();
        $before = $user->fresh()->getAttributes();
        $this->actingAs($user, 'web')->withSession([SessionVersion::KEY => $version])
            ->getJson('/api/user')->assertUnauthorized()->assertJsonPath('code', 'session_revoked');
        $this->assertGuest('web');
        $this->assertSame($before, $user->fresh()->getAttributes());
    }

    public function test_deactivation_reactivation_does_not_restore_old_session_and_new_login_works(): void
    {
        $user = User::factory()->create();
        $this->postJson('/api/login', ['email' => $user->email, 'password' => 'password'])->assertOk();
        $id = session()->getId();
        DB::table('users')->where('id', $user->id)->update(['disabled_at' => now(), 'session_version' => 1]);
        DB::table('users')->where('id', $user->id)->update(['disabled_at' => null, 'session_version' => 2]);
        Auth::forgetGuards();
        $this->withCookie(config('session.cookie'), $id)->getJson('/api/user')
            ->assertUnauthorized()->assertJsonPath('code', 'session_revoked');
        $this->postJson('/api/login', ['email' => $user->email, 'password' => 'password'])
            ->assertOk()->assertSessionHas(SessionVersion::KEY, 2);
        Auth::forgetGuards();
        $this->getJson('/api/user')->assertOk();
    }

    public function test_ordinary_forbidden_response_preserves_a_valid_session(): void
    {
        $this->actingAs($this->requester, 'web')->getJson('/api/admin/users')
            ->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
        $this->assertAuthenticatedAs($this->requester, 'web');
    }

    public function test_expected_revocation_is_not_logged_as_an_error(): void
    {
        Log::spy();
        $user = User::factory()->create(['session_version' => 1]);
        $this->actingAs($user, 'web')->getJson('/api/user')->assertUnauthorized()->assertJsonPath('code', 'session_revoked');
        Log::shouldNotHaveReceived('error');
        Log::shouldNotHaveReceived('log');
    }

    public function test_current_nonzero_session_can_change_roles_comment_and_assign_without_rotation(): void
    {
        $actor = User::factory()->create(['role' => 'admin', 'session_version' => 7]);
        $target = User::factory()->create(['role' => 'requester']);
        $technician = User::factory()->create(['role' => 'technician', 'session_version' => 9]);
        $ticket = $this->ticket();
        $this->postJson('/api/login', ['email' => $actor->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $csrf = session()->token();
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId);
        $this->patchJson('/api/admin/users/'.$target->id.'/role', ['role' => 'technician', 'expected_role' => 'requester'])->assertOk();
        $this->postJson('/api/tickets/'.$ticket->id.'/comments', ['body' => 'Resposta válida', 'is_internal' => false])->assertCreated();
        $this->patchJson('/api/tickets/'.$ticket->id.'/assignment', ['assigned_to' => $technician->id])->assertOk();
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($csrf, session()->token());
        $this->assertSame(7, session()->get(SessionVersion::KEY));
        $this->assertSame(7, $actor->fresh()->session_version);
        $this->assertSame(9, $technician->fresh()->session_version);
    }

    public static function routes(): array
    {
        return array_map(fn (array $route): array => $route, [
            ['GET', '/api/user'], ['POST', '/api/logout'], ['GET', '/api/admin/users'], ['GET', '/api/reports/summary'],
            ['POST', '/api/admin/users'], ['PATCH', '/api/admin/users/1'], ['PATCH', '/api/admin/users/1/role'], ['PATCH', '/api/admin/users/1/status'],
            ['GET', '/api/tickets'], ['POST', '/api/tickets'], ['GET', '/api/tickets/1'],
            ['GET', '/api/tickets/1/attachments'], ['POST', '/api/tickets/1/attachments'], ['GET', '/api/tickets/1/attachments/1/download'],
            ['POST', '/api/tickets/1/comments'], ['PATCH', '/api/tickets/1/assignment'],
            ['PATCH', '/api/tickets/1/status'], ['PATCH', '/api/tickets/1/details'],
            ['GET', '/api/dashboard/stats'], ['GET', '/api/dashboard/sla'],
            ['GET', '/api/dashboard/categories'], ['GET', '/api/dashboard/recent-tickets'],
            ['GET', '/api/categories'], ['GET', '/api/technicians'], ['GET', '/api/admin/categories'],
            ['POST', '/api/admin/categories'], ['PATCH', '/api/admin/categories/1'], ['PATCH', '/api/admin/categories/1/status'],
        ]);
    }

    #[DataProvider('routes')]
    public function test_all_authenticated_routes_reject_old_versions_before_validation(string $method, string $url): void
    {
        $admin = User::factory()->create(['role' => 'admin', 'session_version' => 1]);
        $before = $this->roleSnapshot();
        $this->actingAs($admin, 'web')->json($method, $url)->assertUnauthorized()->assertJsonPath('code', 'session_revoked');
        $this->assertSame($before, $this->roleSnapshot());
    }

    public static function mutations(): array
    {
        return [
            ['POST', '/api/admin/users', StoreAdminUserRequest::class, ['name' => 'Nova conta', 'email' => 'nova@example.invalid', 'password' => 'Test!Password123', 'password_confirmation' => 'Test!Password123', 'role' => 'requester']],
            ['PATCH', '/api/admin/users/{user}', UpdateAdminUserRequest::class, ['name' => 'Outro nome']],
            ['PATCH', '/api/admin/users/{user}/role', UpdateAdminUserRoleRequest::class, ['role' => 'technician', 'expected_role' => 'requester']],
            ['PATCH', '/api/admin/users/{user}/status', UpdateAdminUserStatusRequest::class, ['is_active' => false, 'expected_is_active' => true]],
            ['POST', '/api/admin/categories', StoreCategoryRequest::class, ['name' => 'Categoria nova']],
            ['PATCH', '/api/admin/categories/{category}', UpdateCategoryRequest::class, ['name' => 'Outra categoria']],
            ['PATCH', '/api/admin/categories/{category}/status', UpdateCategoryStatusRequest::class, ['is_active' => false]],
            ['POST', '/api/tickets', StoreTicketRequest::class, ['title' => 'Chamado novo', 'description' => 'Descrição válida', 'priority' => 'medium']],
            ['POST', '/api/tickets/{ticket}/comments', StoreTicketCommentRequest::class, ['body' => 'Comentário válido', 'is_internal' => true]],
            ['PATCH', '/api/tickets/{ticket}/assignment', UpdateTicketAssignmentRequest::class, []],
            ['PATCH', '/api/tickets/{ticket}/status', UpdateTicketStatusRequest::class, ['status' => 'in_progress']],
            ['PATCH', '/api/tickets/{ticket}/details', UpdateTicketDetailsRequest::class, ['priority' => 'high']],
        ];
    }

    #[DataProvider('mutations')]
    public function test_version_changed_after_validation_prevents_every_transactional_mutation(string $method, string $url, string $form, array $payload): void
    {
        $actor = User::factory()->create(['role' => 'admin']);
        $target = User::factory()->create(['role' => 'requester']);
        $technician = User::factory()->create(['role' => 'technician']);
        $category = Category::firstOrFail();
        $ticket = $this->ticket();
        $url = strtr($url, ['{user}' => $target->id, '{category}' => $category->id, '{ticket}' => $ticket->id]);
        if ($form === StoreTicketRequest::class) {
            $payload['category_id'] = $category->id;
        }
        if ($form === UpdateTicketAssignmentRequest::class) {
            $payload['assigned_to'] = $technician->id;
        }
        $before = null;
        $this->app->afterResolving($form, function () use ($actor, &$before): void {
            DB::table('users')->where('id', $actor->id)->increment('session_version', 2);
            $before = $this->roleSnapshot();
        });
        $this->actingAs($actor, 'web')->json($method, $url, $payload)
            ->assertUnauthorized()->assertJsonPath('code', 'session_revoked');
        $this->assertNotNull($before);
        $this->assertSame($before, $this->roleSnapshot());
    }

    public function test_login_does_not_adopt_a_version_changed_after_credential_lookup(): void
    {
        $user = User::factory()->create();
        $changed = false;
        DB::listen(function ($query) use ($user, &$changed): void {
            if (! $changed && str_starts_with($query->sql, 'select') && str_contains($query->sql, '"email" = ?')) {
                $changed = true;
                DB::table('users')->where('id', $user->id)->increment('session_version', 2);
            }
        });
        $this->postJson('/api/login', ['email' => $user->email, 'password' => 'password'])->assertUnauthorized()
            ->assertExactJson(['message' => 'Credenciais inválidas.']);
        $this->assertTrue($changed);
        $this->assertGuest('web');
        $this->assertFalse(session()->exists(SessionVersion::KEY));
    }

    public function test_missing_migration_fails_closed(): void
    {
        Schema::table('users', fn ($table) => $table->dropColumn('session_version'));
        $this->actingAs($this->requester, 'web')->getJson('/api/user')->assertStatus(503);
        Auth::forgetGuards();
        $this->postJson('/api/login', ['email' => $this->requester->email, 'password' => 'password'])->assertStatus(503);
        $this->assertGuest('web');
    }
}
