<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Http\Requests\UpdateCategoryRequest;
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

class UpdateCategoryTest extends TestCase
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
        (require database_path('migrations/2026_10_26_220000_add_normalized_category_name_unique_index.php'))->up();
        $this->admin = User::factory()->create(['role' => 'admin']);
        $this->category = Category::create(['name' => 'Equipamentos', 'description' => 'Preservar descrição.']);
        $this->actingAs($this->admin, 'web');
    }

    private function endpoint(): string
    {
        return '/api/admin/categories/'.$this->category->id;
    }

    public static function activityStates(): array
    {
        return [[true], [false]];
    }

    #[DataProvider('activityStates')]
    public function test_rename_preserves_identity_activation_all_tickets_comments_activities_and_sla(bool $active): void
    {
        $this->category->update(['is_active' => $active]);
        foreach (TicketStatus::all() as $status) {
            $ticket = $this->ticket(['category_id' => $this->category->id, 'status_id' => $status->id]);
            $ticket->comments()->create(['user_id' => $this->requester->id, 'body' => 'Preservar comentário.', 'is_internal' => true]);
            DB::table('ticket_activities')->insert(['ticket_id' => $ticket->id, 'actor_id' => $this->admin->id, 'action' => 'ticket_created', 'created_at' => now()]);
        }
        $this->ticket();
        $before = $this->snapshot();
        $original = $this->category->fresh()->getAttributes();
        $this->travel(5)->minutes();

        $this->patchJson($this->endpoint(), ['name' => " \tPeriféricos\n\u{00a0}"])->assertOk()->assertExactJson(['data' => [
            'id' => $this->category->id, 'name' => 'Periféricos', 'is_active' => $active, 'tickets_count' => 6,
        ]]);
        $fresh = $this->category->fresh();
        foreach ($original as $field => $value) {
            if (! in_array($field, ['name', 'updated_at'], true)) {
                $this->assertSame($value, $fresh->getAttributes()[$field]);
            }
        }
        $this->assertNotSame($original['updated_at'], $fresh->getAttributes()['updated_at']);
        $after = $this->snapshot();
        unset($before['categories'], $after['categories']);
        $this->assertSame($before, $after);
        $this->assertSame(6, $fresh->tickets()->count());
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_normalized_current_name_is_idempotent_without_changing_updated_at(): void
    {
        $before = $this->snapshot();
        $this->travel(10)->minutes();
        $this->patchJson($this->endpoint(), ['name' => " \tEquipamentos\n"])->assertOk()->assertExactJson(['data' => [
            'id' => $this->category->id, 'name' => 'Equipamentos', 'is_active' => true, 'tickets_count' => 0,
        ]]);
        $this->assertSame($before, $this->snapshot());
    }

    public function test_case_only_and_unicode_names_on_the_same_record_are_allowed(): void
    {
        foreach (['EQUIPAMENTOS', 'equipamentos', 'Periféricos', 'PERIFÉRICOS', str_repeat('é', 100)] as $name) {
            $this->patchJson($this->endpoint(), ['name' => $name])->assertOk()->assertJsonPath('data.id', $this->category->id)->assertJsonPath('data.name', $name);
            $this->assertSame($name, $this->category->fresh()->name);
        }
    }

    #[DataProviderExternal(StoreCategoryTest::class, 'invalidPayloads')]
    public function test_name_validation_matches_creation_without_writes(array $payload, string $field): void
    {
        $before = $this->snapshot();
        $this->patchJson($this->endpoint(), $payload)->assertUnprocessable()->assertJsonValidationErrors($field);
        $this->assertSame($before, $this->snapshot());
    }

    #[DataProviderExternal(StoreCategoryTest::class, 'duplicates')]
    public function test_other_category_name_conflicts_return_clean_422_without_partial_changes(string $name): void
    {
        $before = $this->snapshot();
        $this->patchJson($this->endpoint(), ['name' => $name])->assertUnprocessable()->assertExactJson([
            'message' => 'Já existe uma categoria com esse nome.', 'errors' => ['name' => ['Já existe uma categoria com esse nome.']],
        ]);
        $this->assertSame($before, $this->snapshot());
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_inactive_other_category_also_reserves_its_normalized_name(): void
    {
        Category::create(['name' => '  Reservada  ', 'is_active' => false]);
        $before = $this->snapshot();
        $this->patchJson($this->endpoint(), ['name' => 'reservada'])->assertUnprocessable()->assertJsonValidationErrors('name');
        $this->assertSame($before, $this->snapshot());
    }

    public function test_missing_and_invalid_identifiers_return_404_without_writes(): void
    {
        $before = $this->snapshot();
        foreach (['999999', '0', '-1', 'invalid', '999999999999999999999999'] as $id) {
            $this->patchJson('/api/admin/categories/'.$id, ['name' => 'Novo nome'])->assertNotFound();
        }
        $this->assertSame($before, $this->snapshot());
    }

    #[DataProviderExternal(StoreCategoryTest::class, 'forbiddenRoles')]
    public function test_only_admins_can_edit_existing_or_missing_categories(string $role): void
    {
        Auth::forgetGuards();
        $this->actingAs(User::factory()->create(['role' => $role]), 'web');
        $before = $this->snapshot();
        foreach ([$this->category->id, 999999] as $id) {
            $this->patchJson('/api/admin/categories/'.$id, ['is_active' => false])->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
        }
        $this->assertSame($before, $this->snapshot());
    }

    public function test_guest_receives_401(): void
    {
        Auth::forgetGuards();
        $before = $this->snapshot();
        $this->patchJson($this->endpoint(), ['name' => 'Novo nome'])->assertUnauthorized();
        $this->assertSame($before, $this->snapshot());
    }

    #[DataProviderExternal(StoreCategoryTest::class, 'roles')]
    public function test_disabled_users_receive_403(string $role): void
    {
        Auth::forgetGuards();
        $this->actingAs(User::factory()->create(['role' => $role, 'disabled_at' => now()]), 'web');
        $before = $this->snapshot();
        $this->patchJson($this->endpoint(), ['name' => 'Novo nome'])->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
        $this->assertSame($before, $this->snapshot());
    }

    public function test_real_session_requires_csrf_and_accepts_a_valid_token(): void
    {
        Auth::forgetGuards();
        $this->postJson('/api/login', ['email' => $this->admin->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $token = session()->token();
        $before = $this->snapshot();
        $this->app->instance('env', 'local');
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
            ->patchJson($this->endpoint(), ['name' => 'Novo nome'])->assertStatus(419);
        $this->withHeader('X-CSRF-TOKEN', 'invalid')->patchJson($this->endpoint(), ['name' => 'Novo nome'])->assertStatus(419);
        $this->assertSame($before, $this->snapshot());
        $this->withHeader('X-CSRF-TOKEN', $token)->patchJson($this->endpoint(), ['name' => 'Novo nome'])->assertOk()->assertJsonPath('data.name', 'Novo nome');
    }

    public function test_authorization_is_rechecked_after_validation(): void
    {
        $this->app->afterResolving(UpdateCategoryRequest::class, function (): void {
            User::whereKey($this->admin->id)->update(['role' => 'technician']);
        });
        $before = $this->category->fresh()->getAttributes();
        $this->patchJson($this->endpoint(), ['name' => 'Novo nome'])->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
        $this->assertSame($before, $this->category->fresh()->getAttributes());
    }

    public function test_transaction_rolls_back_after_an_observer_failure(): void
    {
        $before = $this->snapshot();
        Category::updated(function (): void {
            throw new RuntimeException('Falha após edição.');
        });
        $this->withoutExceptionHandling();
        try {
            $this->patchJson($this->endpoint(), ['name' => 'Rollback']);
            $this->fail('Era esperado rollback.');
        } catch (RuntimeException $exception) {
            $this->assertSame('Falha após edição.', $exception->getMessage());
        } finally {
            Category::flushEventListeners();
        }
        $this->assertSame($before, $this->snapshot());
    }

    public function test_unrelated_database_errors_return_generic_503_without_changing_the_category(): void
    {
        config(['logging.default' => 'null']);
        DB::statement('CREATE TABLE category_audit (value INTEGER UNIQUE)');
        DB::statement('INSERT INTO category_audit (value) VALUES (1)');
        DB::statement('CREATE TRIGGER category_failure AFTER UPDATE ON categories BEGIN INSERT INTO category_audit (value) VALUES (1); END');
        $before = $this->snapshot();
        $this->patchJson($this->endpoint(), ['name' => 'Falha interna'])->assertStatus(503)
            ->assertExactJson(['message' => 'Não foi possível alterar a categoria no momento.']);
        $this->assertSame($before, $this->snapshot());
    }

    public function test_route_uses_sanctum_then_active_user(): void
    {
        $route = Route::getRoutes()->match(Request::create($this->endpoint(), 'PATCH'));
        $middleware = Route::gatherRouteMiddleware($route);
        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(array_search(EnsureUserIsActive::class, $middleware, true), array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true));
    }
}
