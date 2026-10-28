<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Models\Category;
use App\Models\User;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Schema;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class StoreCategoryTest extends TestCase
{
    use AssignmentFixtures;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertSame('sqlite', config('database.default'));
        $this->assertSame(':memory:', config('database.connections.sqlite.database'));
        $this->createAssignmentFixtures();
        $this->migration()->up();
        $this->admin = User::factory()->create(['role' => 'admin']);
        $this->actingAs($this->admin, 'web');
    }

    private function migration(): object
    {
        return require database_path('migrations/2026_10_26_220000_add_normalized_category_name_unique_index.php');
    }

    public function test_creation_normalizes_name_and_uses_database_active_default_with_exact_contract(): void
    {
        $this->ticket();
        $before = $this->snapshot();
        $response = $this->postJson('/api/admin/categories', ['name' => " \tPeriféricos\n\u{00a0}"])->assertCreated();
        $id = $response->json('data.id');
        $this->assertIsInt($id);
        $response->assertExactJson(['data' => ['id' => $id, 'name' => 'Periféricos', 'is_active' => true, 'tickets_count' => 0]]);
        $category = Category::findOrFail($id);
        $this->assertSame('Periféricos', $category->name);
        $this->assertTrue($category->is_active);
        $this->assertNotNull($category->created_at);
        $this->assertNotNull($category->updated_at);
        $after = $this->snapshot();
        $after['categories'] = DB::table('categories')->where('id', '!=', $id)->orderBy('id')->get()->toJson();
        $this->assertSame($before, $after);
        $this->getJson('/api/categories')->assertOk()->assertJsonFragment(['id' => $id, 'name' => 'Periféricos']);
        $this->getJson('/api/admin/categories')->assertOk()->assertJsonFragment(['id' => $id, 'name' => 'Periféricos', 'is_active' => true, 'tickets_count' => 0]);
    }

    public function test_accepts_100_multibyte_characters_after_trimming_without_collapsing_internal_spaces(): void
    {
        $this->postJson('/api/admin/categories', ['name' => '  '.str_repeat('é', 100).'  '])->assertCreated()->assertJsonPath('data.name', str_repeat('é', 100));
        $this->postJson('/api/admin/categories', ['name' => '  Equipamentos  especiais  '])->assertCreated()->assertJsonPath('data.name', 'Equipamentos  especiais');
    }

    public static function invalidPayloads(): array
    {
        $cases = [
            'missing' => [[], 'name'], 'null' => [['name' => null], 'name'],
            'empty' => [['name' => ''], 'name'], 'spaces' => [['name' => " \t\n\u{00a0}"], 'name'],
            'number' => [['name' => 12], 'name'], 'boolean' => [['name' => true], 'name'],
            'array' => [['name' => ['Rede']], 'name'], 'object' => [['name' => (object) ['value' => 'Rede']], 'name'],
            'too long' => [['name' => str_repeat('é', 101)], 'name'], 'nul' => [['name' => "A\0B"], 'name'],
        ];
        foreach (['id', 'is_active', 'created_at', 'updated_at', 'description', 'tickets_count', 'tickets', 'unknown'] as $field) {
            $cases[$field] = [['name' => 'Nova categoria', $field => null], 'payload'];
        }

        return $cases;
    }

    #[DataProvider('invalidPayloads')]
    public function test_invalid_or_additional_fields_return_422_without_writes(array $payload, string $field): void
    {
        $before = $this->snapshot();
        $this->postJson('/api/admin/categories', $payload)->assertUnprocessable()->assertJsonValidationErrors($field)->assertJsonMissingPath('data');
        $this->assertSame($before, $this->snapshot());
    }

    public static function duplicates(): array
    {
        return [['Hardware'], ['hardware'], ['HARDWARE'], ['  Hardware  '], ["\t HaRdWaRe \n"]];
    }

    #[DataProvider('duplicates')]
    public function test_database_name_conflicts_return_clean_422_and_preserve_records(string $name): void
    {
        $before = $this->snapshot();
        $this->postJson('/api/admin/categories', ['name' => $name])->assertUnprocessable()->assertExactJson([
            'message' => 'Já existe uma categoria com esse nome.',
            'errors' => ['name' => ['Já existe uma categoria com esse nome.']],
        ]);
        $this->assertSame($before, $this->snapshot());
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_duplicate_of_inactive_legacy_name_with_spaces_is_rejected(): void
    {
        Category::create(['name' => '  Antiga  ', 'is_active' => false]);
        $before = $this->snapshot();
        $this->postJson('/api/admin/categories', ['name' => 'antiga'])->assertUnprocessable()->assertJsonValidationErrors('name');
        $this->assertSame($before, $this->snapshot());
    }

    public static function forbiddenRoles(): array
    {
        return [['technician'], ['requester'], ['unknown']];
    }

    #[DataProvider('forbiddenRoles')]
    public function test_non_admin_roles_receive_403_even_with_invalid_payload(string $role): void
    {
        Auth::forgetGuards();
        $this->actingAs(User::factory()->create(['role' => $role]), 'web');
        $before = $this->snapshot();
        $this->postJson('/api/admin/categories', ['is_active' => false])->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
        $this->assertSame($before, $this->snapshot());
    }

    public function test_guest_receives_401_without_creating_categories(): void
    {
        Auth::forgetGuards();
        $before = $this->snapshot();
        $this->postJson('/api/admin/categories', ['name' => 'Nova categoria'])->assertUnauthorized();
        $this->assertSame($before, $this->snapshot());
    }

    public static function roles(): array
    {
        return [['admin'], ['technician'], ['requester']];
    }

    #[DataProvider('roles')]
    public function test_disabled_users_receive_403(string $role): void
    {
        Auth::forgetGuards();
        $this->actingAs(User::factory()->create(['role' => $role, 'disabled_at' => now()]), 'web');
        $before = $this->snapshot();
        $this->postJson('/api/admin/categories', ['name' => 'Nova categoria'])->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
        $this->assertSame($before, $this->snapshot());
    }

    public function test_web_session_can_create_and_inactive_categories_remain_unavailable_for_tickets(): void
    {
        Auth::forgetGuards();
        $this->postJson('/api/login', ['email' => $this->admin->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)->postJson('/api/admin/categories', ['name' => 'Sessão administrativa'])->assertCreated();
        $inactive = Category::create(['name' => 'Indisponível', 'is_active' => false]);
        $this->postJson('/api/tickets', ['title' => 'Teste', 'description' => 'Descrição', 'category_id' => $inactive->id, 'priority' => 'medium'])
            ->assertUnprocessable()->assertJsonValidationErrors('category_id');
        $this->assertDatabaseCount('tickets', 0);
    }

    public function test_transaction_rolls_back_if_a_category_observer_fails(): void
    {
        $before = $this->snapshot();
        Category::created(function (): void {
            throw new RuntimeException('Falha após inserção.');
        });
        $this->withoutExceptionHandling();
        try {
            $this->postJson('/api/admin/categories', ['name' => 'Rollback']);
            $this->fail('A falha deveria interromper a criação.');
        } catch (RuntimeException $exception) {
            $this->assertSame('Falha após inserção.', $exception->getMessage());
        } finally {
            Category::flushEventListeners();
        }
        $this->assertSame($before, $this->snapshot());
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_other_database_unique_errors_are_not_reported_as_duplicate_names_or_exposed(): void
    {
        config(['logging.default' => 'null']);
        DB::statement('CREATE TABLE category_audit (value INTEGER UNIQUE)');
        DB::statement('INSERT INTO category_audit (value) VALUES (1)');
        DB::statement('CREATE TRIGGER category_failure AFTER INSERT ON categories BEGIN INSERT INTO category_audit (value) VALUES (1); END');
        $before = $this->snapshot();
        $this->postJson('/api/admin/categories', ['name' => 'Falha interna'])->assertStatus(503)
            ->assertExactJson(['message' => 'Não foi possível criar a categoria no momento.']);
        $this->assertSame($before, $this->snapshot());
    }

    public function test_migration_down_preserves_records_and_original_unique_constraint_and_can_be_reapplied(): void
    {
        $before = $this->snapshot();
        $this->assertTrue(Schema::hasIndex('categories', 'categories_name_normalized_unique'));
        $this->migration()->down();
        $this->assertFalse(Schema::hasIndex('categories', 'categories_name_normalized_unique'));
        try {
            Category::create(['name' => 'Hardware']);
            $this->fail('A restrição original deve continuar ativa.');
        } catch (UniqueConstraintViolationException) {
            $this->assertSame($before, $this->snapshot());
        }
        $this->migration()->up();
        $this->assertTrue(Schema::hasIndex('categories', 'categories_name_normalized_unique'));
        $this->assertSame($before, $this->snapshot());
    }

    public function test_route_requires_sanctum_and_active_user(): void
    {
        $route = Route::getRoutes()->match(Request::create('/api/admin/categories', 'POST'));
        $middleware = Route::gatherRouteMiddleware($route);
        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(array_search(EnsureUserIsActive::class, $middleware, true), array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true));
    }
}
