<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Http\Requests\UpdateCategoryStatusRequest;
use App\Models\Category;
use App\Models\TicketStatus;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\DataProviderExternal;
use RuntimeException;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class UpdateCategoryStatusTest extends TestCase
{
    use AssignmentFixtures;

    private User $admin;

    private Category $category;

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertSame('sqlite', config('database.default'));
        $this->assertSame(':memory:', config('database.connections.sqlite.database'));
        $this->createAssignmentFixtures();
        $this->admin = User::factory()->create(['role' => 'admin']);
        $this->category = Category::create(['name' => 'Equipamentos', 'description' => 'Preservar.']);
        $this->actingAs($this->admin, 'web');
    }

    private function endpoint(): string
    {
        return '/api/admin/categories/'.$this->category->id.'/status';
    }

    public static function states(): array
    {
        return [[true], [false]];
    }

    #[DataProvider('states')]
    public function test_change_preserves_category_identity_and_all_related_data(bool $active): void
    {
        $this->category->update(['is_active' => ! $active]);
        foreach (TicketStatus::all() as $status) {
            $ticket = $this->ticket(['category_id' => $this->category->id, 'status_id' => $status->id]);
            $ticket->comments()->create(['user_id' => $this->requester->id, 'body' => 'Preservar.', 'is_internal' => true]);
            DB::table('ticket_activities')->insert(['ticket_id' => $ticket->id, 'actor_id' => $this->admin->id, 'action' => 'ticket_created', 'created_at' => now()]);
        }
        $this->ticket();
        $before = $this->snapshot();
        $original = $this->category->fresh()->getAttributes();
        $this->travel(5)->minutes();

        $this->patchJson($this->endpoint(), ['is_active' => $active])->assertOk()->assertExactJson(['data' => [
            'id' => $this->category->id, 'name' => $this->category->name, 'is_active' => $active, 'tickets_count' => 6,
        ]]);
        $fresh = $this->category->fresh();
        foreach ($original as $field => $value) {
            if (! in_array($field, ['is_active', 'updated_at'], true)) {
                $this->assertSame($value, $fresh->getAttributes()[$field]);
            }
        }
        $this->assertSame($active, $fresh->is_active);
        $this->assertNotSame($original['updated_at'], $fresh->getAttributes()['updated_at']);
        $after = $this->snapshot();
        unset($before['categories'], $after['categories']);
        $this->assertSame($before, $after);
        $this->assertSame(0, DB::transactionLevel());
    }

    #[DataProvider('states')]
    public function test_repeated_state_does_not_change_updated_at_or_any_data(bool $active): void
    {
        $this->category->update(['is_active' => $active]);
        $before = $this->snapshot();
        $this->travel(10)->minutes();
        $this->patchJson($this->endpoint(), ['is_active' => $active])->assertOk()->assertJsonPath('data.is_active', $active);
        $this->assertSame($before, $this->snapshot());
    }

    public static function invalidPayloads(): array
    {
        return [
            'missing' => [[], 'is_active'], 'null' => [['is_active' => null], 'is_active'],
            'empty' => [['is_active' => ''], 'is_active'], 'string true' => [['is_active' => 'true'], 'is_active'],
            'string false' => [['is_active' => 'false'], 'is_active'], 'string zero' => [['is_active' => '0'], 'is_active'],
            'string one' => [['is_active' => '1'], 'is_active'], 'zero' => [['is_active' => 0], 'is_active'],
            'one' => [['is_active' => 1], 'is_active'], 'float' => [['is_active' => 1.0], 'is_active'],
            'array' => [['is_active' => []], 'is_active'], 'object' => [['is_active' => ['value' => false]], 'is_active'],
            'id' => [['is_active' => false, 'id' => 123], 'payload'],
            'name' => [['is_active' => false, 'name' => 'Renomeada'], 'payload'],
            'timestamp' => [['is_active' => false, 'updated_at' => '2026-01-01'], 'payload'],
            'relationship' => [['is_active' => false, 'tickets' => []], 'payload'],
        ];
    }

    #[DataProvider('invalidPayloads')]
    public function test_strict_boolean_and_exclusive_payload_without_writes(array $payload, string $field): void
    {
        $before = $this->snapshot();
        $this->patchJson($this->endpoint(), $payload)->assertUnprocessable()->assertJsonValidationErrors($field);
        $this->assertSame($before, $this->snapshot());
    }

    public function test_missing_or_invalid_category_returns_404(): void
    {
        $before = $this->snapshot();
        foreach (['999999', '0', '-1', 'invalid', '9999999999999999999999'] as $id) {
            $this->patchJson('/api/admin/categories/'.$id.'/status', ['is_active' => false])->assertNotFound();
        }
        $this->assertSame($before, $this->snapshot());
    }

    #[DataProviderExternal(StoreCategoryTest::class, 'forbiddenRoles')]
    public function test_non_admin_cannot_change_existing_or_missing_category(string $role): void
    {
        Auth::forgetGuards();
        $this->actingAs(User::factory()->create(['role' => $role]), 'web');
        $before = $this->snapshot();
        foreach ([$this->category->id, 999999] as $id) {
            $this->patchJson('/api/admin/categories/'.$id.'/status', ['is_active' => false])->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
        }
        $this->assertSame($before, $this->snapshot());
    }

    #[DataProviderExternal(StoreCategoryTest::class, 'roles')]
    public function test_disabled_users_are_forbidden(string $role): void
    {
        Auth::forgetGuards();
        $this->actingAs(User::factory()->create(['role' => $role, 'disabled_at' => now()]), 'web');
        $before = $this->snapshot();
        $this->patchJson($this->endpoint(), ['is_active' => false])->assertForbidden();
        $this->assertSame($before, $this->snapshot());
    }

    public function test_guest_is_unauthorized(): void
    {
        Auth::forgetGuards();
        $before = $this->snapshot();
        $this->patchJson($this->endpoint(), ['is_active' => false])->assertUnauthorized();
        $this->assertSame($before, $this->snapshot());
    }

    public function test_session_cookie_and_csrf_are_required(): void
    {
        Auth::forgetGuards();
        $this->postJson('/api/login', ['email' => $this->admin->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $token = session()->token();
        $before = $this->snapshot();
        $this->app->instance('env', 'local');
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
            ->patchJson($this->endpoint(), ['is_active' => false])->assertStatus(419);
        $this->withHeader('X-CSRF-TOKEN', 'invalid')->patchJson($this->endpoint(), ['is_active' => false])->assertStatus(419);
        $this->assertSame($before, $this->snapshot());
        $this->withHeader('X-CSRF-TOKEN', $token)->patchJson($this->endpoint(), ['is_active' => false])->assertOk()->assertJsonPath('data.is_active', false);
    }

    public function test_deactivation_and_reactivation_integrate_with_existing_ticket_endpoints(): void
    {
        $old = $this->ticket(['category_id' => $this->category->id]);
        $before = $old->fresh()->getAttributes();
        $payload = ['title' => 'Novo chamado', 'description' => 'Descrição.', 'category_id' => $this->category->id, 'priority' => 'medium'];
        $this->patchJson($this->endpoint(), ['is_active' => false])->assertOk();
        $this->getJson('/api/categories')->assertOk()->assertJsonMissing(['id' => $this->category->id]);
        $this->postJson('/api/tickets', $payload)->assertUnprocessable()->assertJsonValidationErrors('category_id');
        $this->patchJson('/api/tickets/'.$old->id.'/details', ['category_id' => $this->category->id])->assertUnprocessable()->assertJsonValidationErrors('category_id');
        $this->getJson('/api/tickets/'.$old->id)->assertOk()->assertJsonPath('category', ['id' => $this->category->id, 'name' => $this->category->name]);
        $this->getJson('/api/admin/categories')->assertOk()->assertJsonFragment([
            'id' => $this->category->id, 'name' => $this->category->name, 'is_active' => false, 'tickets_count' => 1,
        ]);
        $this->assertSame($before, $old->fresh()->getAttributes());
        $this->patchJson($this->endpoint(), ['is_active' => true])->assertOk();
        $this->getJson('/api/categories')->assertOk()->assertJsonFragment(['id' => $this->category->id, 'name' => $this->category->name]);
        $this->postJson('/api/tickets', $payload)->assertCreated()->assertJsonPath('category.id', $this->category->id);
        $other = $this->ticket();
        $this->patchJson('/api/tickets/'.$other->id.'/details', ['category_id' => $this->category->id])->assertOk()->assertJsonPath('category.id', $this->category->id);
        $this->assertSame($before, $old->fresh()->getAttributes());
    }

    public function test_admin_authorization_is_rechecked_inside_transaction(): void
    {
        $this->app->afterResolving(UpdateCategoryStatusRequest::class, function (): void {
            User::whereKey($this->admin->id)->update(['role' => 'technician']);
        });
        $before = $this->category->fresh()->getAttributes();
        $this->patchJson($this->endpoint(), ['is_active' => false])->assertForbidden();
        $this->assertSame($before, $this->category->fresh()->getAttributes());
    }

    public function test_observer_failure_rolls_back_change(): void
    {
        $before = $this->snapshot();
        Category::updated(function (): void {
            throw new RuntimeException('Falha após alteração.');
        });
        $this->withoutExceptionHandling();
        try {
            $this->patchJson($this->endpoint(), ['is_active' => false]);
            $this->fail('Era esperado rollback.');
        } catch (RuntimeException $exception) {
            $this->assertSame('Falha após alteração.', $exception->getMessage());
        } finally {
            Category::flushEventListeners();
        }
        $this->assertSame($before, $this->snapshot());
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_database_failure_returns_clean_503_and_rolls_back(): void
    {
        config(['logging.default' => 'null']);
        DB::statement("CREATE TRIGGER category_status_failure AFTER UPDATE ON categories BEGIN SELECT RAISE(ABORT, 'internal database error'); END");
        $before = $this->snapshot();
        $this->patchJson($this->endpoint(), ['is_active' => false])->assertStatus(503)->assertExactJson([
            'message' => 'Não foi possível alterar a situação da categoria no momento.',
        ]);
        $this->assertSame($before, $this->snapshot());
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_route_requires_sanctum_and_active_user_in_order(): void
    {
        $route = Route::getRoutes()->match(Request::create($this->endpoint(), 'PATCH'));
        $middleware = Route::gatherRouteMiddleware($route);
        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(array_search(EnsureUserIsActive::class, $middleware, true), array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true));
    }
}
