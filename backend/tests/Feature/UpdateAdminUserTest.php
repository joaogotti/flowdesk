<?php

namespace Tests\Feature;

use App\Http\Middleware\EnsureUserIsActive;
use App\Http\Requests\UpdateAdminUserRequest;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\Support\AssignmentFixtures;
use Tests\TestCase;

class UpdateAdminUserTest extends TestCase
{
    use AssignmentFixtures;

    private User $admin;

    private User $target;

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertSame('sqlite', config('database.default'));
        $this->assertSame(':memory:', config('database.connections.sqlite.database'));
        $this->createAssignmentFixtures();
        config(['logging.default' => 'null']);
        $this->admin = User::factory()->create(['role' => 'admin']);
        $this->target = User::factory()->create(['name' => 'Nome Original', 'email' => 'original@example.com', 'role' => 'technician']);
        $this->actingAs($this->admin, 'web');
    }

    private function endpoint(): string
    {
        return '/api/admin/users/'.$this->target->id;
    }

    private function patchTarget(array $payload): TestResponse
    {
        foreach (['name', 'email'] as $field) {
            if (array_key_exists($field, $payload) && ! array_key_exists('expected_'.$field, $payload)) {
                $payload['expected_'.$field] = $this->target->{$field};
            }
        }

        return $this->patchJson($this->endpoint(), $payload);
    }

    private function row(User $user): array
    {
        return [
            'id' => $user->id, 'name' => $user->name, 'email' => $user->email, 'role' => $user->role,
            'disabled_at' => $user->disabled_at?->toISOString(), 'created_at' => $user->created_at?->toISOString(),
        ];
    }

    public static function partialUpdates(): array
    {
        return [
            'name' => [['name' => " \tNovo  Nome\n\u{00a0}"], ['name' => 'Novo  Nome']],
            'email' => [['email' => ' NOVO@Example.COM '], ['email' => 'novo@example.com']],
            'both' => [['name' => ' Novo Nome ', 'email' => ' NOVO@Example.COM '], ['name' => 'Novo Nome', 'email' => 'novo@example.com']],
        ];
    }

    #[DataProvider('partialUpdates')]
    public function test_partial_updates_normalize_only_supplied_fields_with_exact_public_contract(array $payload, array $changes): void
    {
        $before = $this->target->getAttributes();
        $expected = array_replace($this->row($this->target), $changes);
        $this->travel(10)->minutes();
        $response = $this->patchTarget($payload)->assertOk()->assertExactJson(['data' => $expected]);
        $fresh = $this->target->fresh();
        foreach ($before as $field => $value) {
            if ($field !== 'updated_at') {
                $this->assertSame($changes[$field] ?? $value, $fresh->getAttributes()[$field]);
            }
        }
        $this->assertNotSame($before['updated_at'], $fresh->getAttributes()['updated_at']);
        foreach (['password', 'remember_token', 'email_verified_at', 'updated_at', $this->target->password] as $secret) {
            $response->assertDontSee($secret, false);
        }
        $this->assertSame(0, DB::transactionLevel());
    }

    public static function targetStates(): array
    {
        return [['admin', null], ['requester', null], ['technician', null], ['admin', '2026-01-01'], ['requester', '2026-01-01'], ['technician', '2026-01-01']];
    }

    #[DataProvider('targetStates')]
    public function test_preserves_all_relationships_roles_states_credentials_and_creation_time(string $role, ?string $disabledAt): void
    {
        $this->target->update(['role' => $role, 'disabled_at' => $disabledAt]);
        $this->target->forceFill(['remember_token' => 'private-token', 'email_verified_at' => now()])->save();
        foreach ([false, true] as $internal) {
            $ticket = $this->ticket(['requester_id' => $this->target->id, 'assigned_to' => $this->target->id]);
            $ticket->comments()->create(['user_id' => $this->target->id, 'body' => 'Preservar comentário.', 'is_internal' => $internal]);
            DB::table('ticket_activities')->insert(['ticket_id' => $ticket->id, 'actor_id' => $this->target->id, 'action' => 'ticket_created', 'created_at' => now()]);
        }
        $before = $this->snapshot();
        $before['users'] = DB::table('users')->where('id', '!=', $this->target->id)->orderBy('id')->get()->toJson();
        $attributes = $this->target->fresh()->getAttributes();
        $this->travel(5)->minutes();
        $this->patchTarget(['name' => 'Nome Atualizado', 'email' => 'atualizado@example.com'])
            ->assertOk()->assertJsonPath('data.role', $role)->assertJsonPath('data.disabled_at', $this->target->disabled_at?->toISOString());
        $fresh = $this->target->fresh();
        foreach ($attributes as $field => $value) {
            if (! in_array($field, ['name', 'email', 'updated_at'], true)) {
                $this->assertSame($value, $fresh->getAttributes()[$field]);
            }
        }
        $after = $this->snapshot();
        $after['users'] = DB::table('users')->where('id', '!=', $this->target->id)->orderBy('id')->get()->toJson();
        $this->assertSame($before, $after);
        $this->assertSame(2, $fresh->requestedTickets()->count());
        $this->assertSame(2, $fresh->assignedTickets()->count());
        $this->assertSame(2, $fresh->ticketComments()->count());
        $this->assertSame(2, $fresh->ticketActivities()->count());
    }

    public function test_self_edit_preserves_admin_access_session_csrf_and_credentials(): void
    {
        $this->target = $this->admin;
        Auth::forgetGuards();
        $this->postJson('/api/login', ['email' => $this->admin->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $token = session()->token();
        $before = $this->admin->fresh()->getAttributes();
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)
            ->patchTarget(['name' => 'Administrador Atualizado', 'email' => ' ADMIN@Example.COM '])
            ->assertOk()->assertJsonPath('data.role', 'admin')->assertJsonPath('data.email', 'admin@example.com');
        Auth::forgetGuards();
        $this->getJson('/api/user')->assertOk()->assertJsonPath('role', 'admin')->assertJsonPath('email', 'admin@example.com');
        $this->getJson('/api/admin/users')->assertOk();
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($token, session()->token());
        $this->assertSame($before['password'], $this->admin->fresh()->getAttributes()['password']);
        $this->assertSame($before['created_at'], $this->admin->fresh()->getAttributes()['created_at']);
        $this->assertDatabaseCount('sessions', 0);
    }

    public function test_normalized_equal_values_skip_save_events_update_queries_and_timestamps(): void
    {
        $before = $this->snapshot();
        $this->travel(10)->minutes();
        User::updating(function (): void {
            throw new RuntimeException('Não deve salvar dados iguais.');
        });
        DB::enableQueryLog();
        try {
            $this->patchTarget(['name' => ' Nome Original ', 'email' => ' ORIGINAL@Example.COM '])
                ->assertOk()->assertExactJson(['data' => $this->row($this->target)]);
            $queries = DB::getQueryLog();
        } finally {
            User::flushEventListeners();
            DB::disableQueryLog();
        }
        foreach ($queries as $query) {
            $this->assertMatchesRegularExpression('/^select\b/i', $query['query']);
        }
        $this->assertSame($before, $this->snapshot());
    }

    public function test_own_legacy_email_can_be_normalized_and_maximum_unicode_name_is_accepted(): void
    {
        $this->target->update(['email' => 'ORIGINAL@EXAMPLE.COM']);
        $this->patchTarget(['email' => ' Original@Example.COM ', 'name' => str_repeat('é', 255)])
            ->assertOk()->assertJsonPath('data.email', 'original@example.com')->assertJsonPath('data.name', str_repeat('é', 255));
    }

    public static function invalidPayloads(): array
    {
        $cases = ['empty' => [[], 'payload']];
        foreach (['name', 'email'] as $field) {
            foreach (['null' => null, 'empty' => '', 'spaces' => " \t\n\u{00a0}", 'array' => [], 'number' => 5, 'bool' => false, 'long' => str_repeat('é', 256), 'nul' => "a\0b"] as $label => $value) {
                $cases[$field.' '.$label] = [[$field => $value], $field];
            }
        }
        $cases['bad email'] = [['email' => 'invalid'], 'email'];
        foreach (['role', 'password', 'password_confirmation', 'disabled_at', 'session_version', 'id', 'created_at', 'updated_at', 'remember_token', 'email_verified_at', 'unknown', 'permissions'] as $field) {
            $cases[$field] = [['name' => 'Não salvar', $field => null], 'payload'];
        }
        $cases['forbidden only'] = [['role' => 'admin'], 'payload'];
        $cases['valid and invalid'] = [['name' => 'Não salvar', 'email' => null], 'email'];

        return $cases;
    }

    #[DataProvider('invalidPayloads')]
    public function test_invalid_or_forbidden_fields_return_422_without_writes(array $payload, string $field): void
    {
        $before = $this->snapshot();
        $this->patchTarget($payload)->assertUnprocessable()->assertJsonValidationErrors($field)->assertJsonMissingPath('data');
        $this->assertSame($before, $this->snapshot());
    }

    public function test_forbidden_query_fields_are_rejected_even_when_null(): void
    {
        $before = $this->snapshot();
        $this->patchJson($this->endpoint().'?disabled_at=', ['name' => 'Não salvar'])->assertUnprocessable()->assertJsonValidationErrors('payload');
        $this->assertSame($before, $this->snapshot());
    }

    public static function duplicateEmails(): array
    {
        return [['duplicate@example.com', null], ['DUPLICATE@EXAMPLE.COM', null], ['Duplicate@Example.COM', '2026-01-01']];
    }

    #[DataProvider('duplicateEmails')]
    public function test_duplicate_email_including_legacy_capitalization_and_disabled_user_returns_422(string $email, ?string $disabledAt): void
    {
        User::factory()->create(['email' => $email, 'disabled_at' => $disabledAt]);
        $before = $this->snapshot();
        $this->patchTarget(['name' => 'Não salvar', 'email' => ' DUPLICATE@Example.COM '])
            ->assertUnprocessable()->assertJsonValidationErrors('email');
        $this->assertSame($before, $this->snapshot());
    }

    public static function deniedActors(): array
    {
        return [['requester', null], ['technician', null], ['admin', '2026-01-01'], ['requester', '2026-01-01'], ['technician', '2026-01-01']];
    }

    #[DataProvider('deniedActors')]
    public function test_unauthorized_roles_and_disabled_accounts_are_forbidden_before_target_lookup(string $role, ?string $disabledAt): void
    {
        Auth::forgetGuards();
        $this->actingAs(User::factory()->create(['role' => $role, 'disabled_at' => $disabledAt]), 'web');
        $before = $this->snapshot();
        foreach ([$this->endpoint(), '/api/admin/users/999999'] as $endpoint) {
            $this->patchJson($endpoint, [])->assertForbidden()->assertExactJson(['message' => 'Acesso não permitido.']);
        }
        $this->assertSame($before, $this->snapshot());
    }

    public function test_guests_receive_401_before_target_lookup_or_validation(): void
    {
        Auth::forgetGuards();
        $before = $this->snapshot();
        foreach ([$this->endpoint(), '/api/admin/users/999999'] as $endpoint) {
            $this->patchJson($endpoint, [])->assertUnauthorized();
        }
        $this->assertSame($before, $this->snapshot());
    }

    public function test_missing_or_invalid_target_ids_return_404_without_writes(): void
    {
        $before = $this->snapshot();
        foreach (['999999', '0', '-1', 'abc', '999999999999999999999999999999'] as $id) {
            $this->patchJson('/api/admin/users/'.$id, ['name' => 'Não salvar'])->assertNotFound()->assertJsonMissingPath('data');
        }
        $this->patchJson('/api/admin/users/999999', [])->assertNotFound();
        $this->assertSame($before, $this->snapshot());
    }

    public function test_csrf_is_required_for_real_stateful_requests(): void
    {
        Auth::forgetGuards();
        $this->postJson('/api/login', ['email' => $this->admin->email, 'password' => 'password'])->assertOk();
        $sessionId = session()->getId();
        $token = session()->token();
        $before = $this->snapshot();
        $this->app->instance('env', 'local');
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $sessionId)->patchTarget(['name' => 'Novo Nome'])->assertStatus(419);
        $this->withHeader('X-CSRF-TOKEN', 'invalid')->patchTarget(['name' => 'Novo Nome'])->assertStatus(419);
        $this->assertSame($before, $this->snapshot());
        Auth::forgetGuards();
        $this->withHeader('X-CSRF-TOKEN', $token)->patchTarget(['name' => 'Novo Nome'])->assertOk();
        $this->assertSame($sessionId, session()->getId());
        $this->assertSame($token, session()->token());
    }

    public static function revokedAccess(): array
    {
        return [[['role' => 'technician']], [['disabled_at' => '2026-01-01']]];
    }

    #[DataProvider('revokedAccess')]
    public function test_authorization_is_rechecked_under_lock_after_validation(array $changes): void
    {
        $this->app->afterResolving(UpdateAdminUserRequest::class, function () use ($changes): void {
            User::whereKey($this->admin->id)->update($changes);
        });
        $before = $this->target->fresh()->getAttributes();
        $this->patchTarget(['name' => 'Não salvar'])->assertForbidden();
        $this->assertSame($before, $this->target->fresh()->getAttributes());
    }

    public function test_target_removed_after_validation_returns_404(): void
    {
        $this->app->afterResolving(UpdateAdminUserRequest::class, function (): void {
            User::whereKey($this->target->id)->delete();
        });
        $this->patchTarget(['name' => 'Não salvar'])->assertNotFound()->assertExactJson(['message' => 'Usuário não encontrado.']);
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_database_email_collision_after_validation_returns_clean_422(): void
    {
        $this->app->afterResolving(UpdateAdminUserRequest::class, function (): void {
            User::factory()->create(['email' => 'race@example.com']);
        });
        $before = $this->target->fresh()->getAttributes();
        $this->patchTarget(['name' => 'Não salvar', 'email' => ' RACE@Example.COM '])->assertUnprocessable()->assertExactJson([
            'message' => 'Já existe um usuário com esse e-mail.', 'errors' => ['email' => ['Já existe um usuário com esse e-mail.']],
        ]);
        $this->assertSame($before, $this->target->fresh()->getAttributes());
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_unrelated_unique_failures_return_generic_503_and_roll_back(): void
    {
        DB::statement('CREATE TABLE user_audit (email TEXT UNIQUE)');
        DB::statement("INSERT INTO user_audit (email) VALUES ('internal-marker')");
        DB::statement("CREATE TRIGGER user_failure AFTER UPDATE ON users BEGIN INSERT INTO user_audit (email) VALUES ('internal-marker'); END");
        $before = $this->snapshot();
        $this->patchTarget(['name' => 'Não salvar'])->assertStatus(503)->assertExactJson(['message' => 'Não foi possível alterar o usuário no momento.']);
        $this->assertSame($before, $this->snapshot());
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_observer_failure_rolls_back_the_entire_update(): void
    {
        $before = $this->snapshot();
        User::updated(function (): void {
            throw new RuntimeException('Falha após edição.');
        });
        $this->withoutExceptionHandling();
        try {
            $this->patchTarget(['name' => 'Rollback']);
            $this->fail('Era esperado rollback.');
        } catch (RuntimeException $exception) {
            $this->assertSame('Falha após edição.', $exception->getMessage());
        } finally {
            User::flushEventListeners();
        }
        $this->assertSame($before, $this->snapshot());
        $this->assertSame(0, DB::transactionLevel());
    }

    public function test_route_reuses_sanctum_and_active_user_middleware(): void
    {
        $route = Route::getRoutes()->match(Request::create($this->endpoint(), 'PATCH'));
        $middleware = Route::gatherRouteMiddleware($route);
        $this->assertContains('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware);
        $this->assertContains(EnsureUserIsActive::class, $middleware);
        $this->assertLessThan(array_search(EnsureUserIsActive::class, $middleware, true), array_search('Illuminate\Auth\Middleware\Authenticate:sanctum', $middleware, true));
    }

    public static function invalidPreconditions(): array
    {
        return [
            [['name' => 'Novo'], 'expected_name'],
            [['email' => 'new@example.invalid'], 'expected_email'],
            [['name' => 'Novo', 'expected_name' => null], 'expected_name'],
            [['name' => 'Novo', 'expected_name' => []], 'expected_name'],
            [['name' => 'Novo', 'expected_name' => str_repeat('é', 256)], 'expected_name'],
            [['name' => 'Novo', 'expected_name' => "Nome Original\0"], 'expected_name'],
            [['name' => "\0Novo", 'expected_name' => 'Nome Original'], 'name'],
            [['name' => 'Novo', 'expected_name' => 'Nome Original', 'expected_email' => 'original@example.com'], 'expected_email'],
            [['email' => 'new@example.invalid', 'expected_email' => false], 'expected_email'],
            [['email' => 'new@example.invalid', 'expected_email' => 'original@example.com', 'expected_name' => null], 'expected_name'],
        ];
    }

    #[DataProvider('invalidPreconditions')]
    public function test_preconditions_are_required_and_cannot_be_sent_without_the_corresponding_field(array $payload, string $field): void
    {
        $before = $this->snapshot();
        $this->patchJson($this->endpoint(), $payload)->assertUnprocessable()->assertJsonValidationErrors($field);
        $this->assertSame($before, $this->snapshot());
    }

    public function test_stale_name_or_email_conflicts_atomically_including_noop_replacements(): void
    {
        foreach (['expected_name' => 'Nome Antigo', 'expected_email' => 'old@example.invalid'] as $field => $value) {
            $before = $this->snapshot();
            $this->patchJson($this->endpoint(), [
                'name' => 'Nome Original', 'email' => 'novo@example.invalid',
                'expected_name' => 'Nome Original', 'expected_email' => 'original@example.com',
                $field => $value,
            ])->assertConflict()->assertJsonPath('code', 'profile_changed')->assertJsonMissingPath('data');
            $this->assertSame($before, $this->snapshot());
            $this->assertSame(0, DB::transactionLevel());
        }
    }

    public function test_preconditions_compare_exact_originals_without_case_or_whitespace_normalization(): void
    {
        $this->target->update(['name' => ' Nome Original ', 'email' => 'ORIGINAL@EXAMPLE.COM']);
        $this->patchJson($this->endpoint(), ['name' => 'Novo', 'expected_name' => 'Nome Original'])
            ->assertConflict()->assertJsonPath('code', 'profile_changed');
        $this->patchJson($this->endpoint(), ['email' => 'new@example.invalid', 'expected_email' => 'original@example.com'])
            ->assertConflict()->assertJsonPath('code', 'profile_changed');
        $this->patchTarget(['name' => 'Novo', 'email' => 'new@example.invalid'])->assertOk();
    }

    public function test_disjoint_edits_preserve_the_other_field_and_recheck_preconditions_under_lock(): void
    {
        $this->app->afterResolving(UpdateAdminUserRequest::class, function (): void {
            User::whereKey($this->target->id)->update(['name' => 'Autoedição recente']);
        });
        $this->patchTarget(['email' => 'new@example.invalid'])->assertOk()->assertJsonPath('data.name', 'Autoedição recente');
        $before = $this->target->fresh()->getAttributes();
        $this->patchTarget(['name' => 'Não salvar'])->assertConflict()->assertJsonPath('code', 'profile_changed');
        $this->assertSame($before, $this->target->fresh()->getAttributes());
    }
}
