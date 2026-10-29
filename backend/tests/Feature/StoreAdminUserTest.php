<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Schema;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\TestCase;

class StoreAdminUserTest extends TestCase
{
    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertSame('sqlite', config('database.default'));
        $this->assertSame(':memory:', config('database.connections.sqlite.database'));
        (require database_path('migrations/0001_01_01_000000_create_users_table.php'))->up();
        Schema::table('users', function (Blueprint $table): void {
            $table->string('role', 20)->default('requester');
            $table->timestampTz('disabled_at')->nullable();
            $table->bigInteger('session_version')->default(0);
        });
        config(['sanctum.stateful' => ['localhost:5173'], 'logging.default' => 'null']);
        $this->withHeader('Origin', 'http://localhost:5173');
        $this->admin = User::factory()->create(['role' => 'admin']);
        $this->actingAs($this->admin, 'web');
    }

    private function payload(array $overrides = []): array
    {
        return array_replace([
            'name' => " \tNome  Completo\n\u{00a0}", 'email' => ' New.User@Example.COM ',
            'password' => 'Senha!Segura123', 'password_confirmation' => 'Senha!Segura123', 'role' => 'requester',
        ], $overrides);
    }

    public static function roles(): array
    {
        return [['requester'], ['technician']];
    }

    #[DataProvider('roles')]
    public function test_creates_active_user_with_normalization_hash_and_exact_safe_contract(string $role): void
    {
        $before = $this->admin->fresh()->getAttributes();
        $response = $this->postJson('/api/admin/users', $this->payload(['role' => $role]))->assertCreated();
        $user = User::findOrFail($response->json('data.id'));
        $response->assertExactJson(['data' => [
            'id' => $user->id, 'name' => 'Nome  Completo', 'email' => 'new.user@example.com', 'role' => $role,
            'disabled_at' => null, 'created_at' => $user->created_at->toISOString(),
        ]]);
        $this->assertTrue(Hash::check('Senha!Segura123', $user->password));
        $this->assertNotSame('Senha!Segura123', $user->password);
        $this->assertFalse(Hash::needsRehash($user->password));
        $this->assertNull($user->disabled_at);
        $this->assertNull($user->email_verified_at);
        $this->assertNull($user->remember_token);
        $this->assertSame($before, $this->admin->fresh()->getAttributes());
        foreach (['password', 'password_confirmation', 'remember_token', 'email_verified_at', 'updated_at', 'Senha!Segura123', $user->password] as $secret) {
            $response->assertDontSee($secret, false);
        }
        $this->assertDatabaseCount('users', 2);
        $this->assertDatabaseCount('sessions', 0);
        $this->assertDatabaseCount('password_reset_tokens', 0);
        $this->getJson('/api/admin/users?search=new.user')->assertOk()->assertJsonPath('total', 1)->assertJsonPath('data.0.id', $user->id);
    }

    public static function invalidPayloads(): array
    {
        $cases = [
            'name empty' => [['name' => '  '], 'name'], 'name null' => [['name' => null], 'name'],
            'name array' => [['name' => []], 'name'], 'name long' => [['name' => str_repeat('é', 256)], 'name'],
            'name nul' => [['name' => "A\0B"], 'name'], 'email empty' => [['email' => ' '], 'email'],
            'email invalid' => [['email' => 'bad'], 'email'], 'email array' => [['email' => []], 'email'],
            'email long' => [['email' => str_repeat('a', 250).'@example.com'], 'email'],
            'password missing' => [['password' => null], 'password'], 'password array' => [['password' => []], 'password'],
            'password short' => [['password' => 'Ab1!'], 'password'],
            'password lowercase' => [['password' => 'abcdefghij1!'], 'password'],
            'password uppercase' => [['password' => 'ABCDEFGHIJ1!'], 'password'],
            'password no number' => [['password' => 'Abcdefghijk!'], 'password'],
            'password no symbol' => [['password' => 'Abcdefghijk1'], 'password'],
            'password too many bytes' => [['password' => 'Ab1!'.str_repeat('é', 35)], 'password'],
            'password nul' => [['password' => "Abcdefghij1!\0"], 'password'],
            'confirmation missing' => [['password_confirmation' => null], 'password_confirmation'],
            'confirmation wrong' => [['password_confirmation' => 'Outro!Texto123'], 'password'],
            'role admin' => [['role' => 'admin'], 'role'], 'role missing' => [['role' => null], 'role'],
            'role invalid' => [['role' => 'owner'], 'role'], 'role array' => [['role' => []], 'role'],
        ];
        foreach (['id', 'disabled_at', 'email_verified_at', 'remember_token', 'created_at', 'updated_at', 'unknown', 'is_active', 'permissions'] as $field) {
            $cases[$field] = [[$field => null], 'payload'];
        }

        return $cases;
    }

    #[DataProvider('invalidPayloads')]
    public function test_invalid_payload_returns_422_without_writes(array $overrides, string $field): void
    {
        $before = DB::table('users')->get()->toJson();
        $this->postJson('/api/admin/users', $this->payload($overrides))->assertUnprocessable()->assertJsonValidationErrors($field)->assertJsonMissingPath('data');
        $this->assertSame($before, DB::table('users')->get()->toJson());
    }

    public function test_all_fields_are_required_and_unknown_query_parameters_are_rejected(): void
    {
        $this->postJson('/api/admin/users', [])->assertUnprocessable()->assertJsonValidationErrors(['name', 'email', 'password', 'password_confirmation', 'role']);
        $this->postJson('/api/admin/users?disabled_at=2026-01-01', $this->payload())->assertUnprocessable()->assertJsonValidationErrors('payload');
        $this->assertDatabaseCount('users', 1);
    }

    public function test_name_255_characters_and_password_72_bytes_are_accepted(): void
    {
        $password = 'Ab1!'.str_repeat('é', 34);
        $this->postJson('/api/admin/users', $this->payload([
            'name' => str_repeat('é', 255), 'password' => $password, 'password_confirmation' => $password,
        ]))->assertCreated();
        $this->assertTrue(Hash::check($password, User::where('email', 'new.user@example.com')->firstOrFail()->password));
    }

    public function test_a_hash_shaped_password_is_hashed_as_plaintext(): void
    {
        $password = Hash::make('Senha!Segura123');
        $this->postJson('/api/admin/users', $this->payload(['password' => $password, 'password_confirmation' => $password]))->assertCreated();
        $stored = User::where('email', 'new.user@example.com')->firstOrFail()->password;
        $this->assertNotSame($password, $stored);
        $this->assertTrue(Hash::check($password, $stored));
    }

    public static function duplicateEmails(): array
    {
        return [['new.user@example.com', null], ['NEW.USER@EXAMPLE.COM', null], ['New.User@Example.Com', '2026-01-01']];
    }

    #[DataProvider('duplicateEmails')]
    public function test_duplicates_including_legacy_uppercase_and_disabled_accounts_are_rejected(string $email, ?string $disabled): void
    {
        User::factory()->create(['email' => $email, 'disabled_at' => $disabled]);
        $before = DB::table('users')->get()->toJson();
        $this->postJson('/api/admin/users', $this->payload())->assertUnprocessable()->assertJsonValidationErrors('email');
        $this->assertSame($before, DB::table('users')->get()->toJson());
    }

    public static function forbiddenUsers(): array
    {
        return [['requester', null], ['technician', null], ['admin', '2026-01-01'], ['requester', '2026-01-01'], ['technician', '2026-01-01']];
    }

    #[DataProvider('forbiddenUsers')]
    public function test_only_active_admins_can_create(string $role, ?string $disabled): void
    {
        Auth::forgetGuards();
        $this->actingAs(User::factory()->create(['role' => $role, 'disabled_at' => $disabled]), 'web');
        $before = DB::table('users')->get()->toJson();
        $this->postJson('/api/admin/users', [])->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
        $this->assertSame($before, DB::table('users')->get()->toJson());
    }

    public function test_guests_receive_401(): void
    {
        Auth::forgetGuards();
        $this->postJson('/api/admin/users', $this->payload())->assertUnauthorized();
        $this->assertDatabaseCount('users', 1);
    }

    public function test_real_web_login_session_and_csrf_are_preserved(): void
    {
        Auth::forgetGuards();
        $this->postJson('/api/login', ['email' => $this->admin->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $token = session()->token();
        $this->app->instance('env', 'local');
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
            ->postJson('/api/admin/users', $this->payload())->assertStatus(419);
        $this->assertDatabaseCount('users', 1);
        $this->withHeader('X-CSRF-TOKEN', 'invalid')->postJson('/api/admin/users', $this->payload())->assertStatus(419);
        Auth::forgetGuards();
        $this->withHeader('X-CSRF-TOKEN', $token)->postJson('/api/admin/users', $this->payload())->assertCreated();
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($token, session()->token());
    }

    public function test_actor_is_revalidated_inside_transaction(): void
    {
        // Simula uma identidade de sessão ainda ativa, com permissão já revogada no banco.
        DB::table('users')->where('id', $this->admin->id)->update(['role' => 'technician']);
        $this->postJson('/api/admin/users', $this->payload())->assertForbidden();
        $this->assertDatabaseCount('users', 1);
    }

    public function test_insert_race_returns_email_validation_error_after_rollback(): void
    {
        // Inserção após a validação, antes do INSERT do controller.
        User::creating(function (User $user): void {
            DB::table('users')->insert(['name' => 'Concorrente', 'email' => $user->email, 'password' => 'private', 'role' => 'requester']);
        });
        try {
            $this->postJson('/api/admin/users', $this->payload())->assertUnprocessable()->assertExactJson([
                'message' => 'Já existe um usuário com esse e-mail.', 'errors' => ['email' => ['Já existe um usuário com esse e-mail.']],
            ]);
        } finally {
            User::flushEventListeners();
        }
        $this->assertSame(0, DB::transactionLevel());
        $this->assertDatabaseCount('users', 1);
    }

    public function test_unrelated_constraint_failures_do_not_expose_sql_or_claim_duplicate_email(): void
    {
        DB::statement('CREATE TABLE user_audit (email TEXT UNIQUE)');
        DB::statement("INSERT INTO user_audit (email) VALUES ('internal-marker')");
        DB::statement("CREATE TRIGGER user_failure AFTER INSERT ON users BEGIN INSERT INTO user_audit (email) VALUES ('internal-marker'); END");
        $this->postJson('/api/admin/users', $this->payload())->assertStatus(503)->assertExactJson(['message' => 'Não foi possível cadastrar o usuário no momento.']);
        $this->assertDatabaseCount('users', 1);
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_transaction_rolls_back_observer_failure(): void
    {
        User::created(function (): void {
            throw new RuntimeException('Falha após inserção.');
        });
        $this->withoutExceptionHandling();
        try {
            $this->postJson('/api/admin/users', $this->payload());
            $this->fail('Deveria interromper a criação.');
        } catch (RuntimeException $exception) {
            $this->assertSame('Falha após inserção.', $exception->getMessage());
        } finally {
            User::flushEventListeners();
        }
        $this->assertDatabaseCount('users', 1);
        $this->assertSame(0, DB::transactionLevel());
    }
}
