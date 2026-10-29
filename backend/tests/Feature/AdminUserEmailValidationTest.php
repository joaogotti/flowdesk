<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class AdminUserEmailValidationTest extends TestCase
{
    private User $target;

    protected function setUp(): void
    {
        parent::setUp();
        $host = getenv('FLOWDESK_EMAIL_PG_HOST');
        if ($host) {
            $this->assertMatchesRegularExpression('/^flowdesk-email-test-[a-f0-9]+$/', $host);
            config(['database.default' => 'email_pg', 'database.connections.email_pg' => [
                'driver' => 'pgsql', 'host' => $host, 'port' => 5432,
                'database' => 'flowdesk_email_test', 'username' => 'postgres', 'password' => '',
                'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer',
            ]]);
            $this->assertSame('flowdesk_email_test', DB::connection()->getDatabaseName());
        } else {
            $this->assertSame('sqlite', config('database.default'));
            $this->assertSame(':memory:', DB::connection()->getDatabaseName());
        }
        DB::beginTransaction();
        (require database_path('migrations/0001_01_01_000000_create_users_table.php'))->up();
        if ($host) {
            (require database_path('migrations/2026_10_09_020940_add_role_and_disabled_at_to_users_table.php'))->up();
            (require database_path('migrations/2026_10_28_230000_add_session_version_to_users_table.php'))->up();
        } else {
            Schema::table('users', function (Blueprint $table): void {
                $table->string('role', 20)->default('requester');
                $table->timestampTz('disabled_at')->nullable();
                $table->bigInteger('session_version')->default(0);
            });
        }
        $this->actingAs(User::factory()->create(['role' => 'admin']), 'web');
        $this->target = User::factory()->create(['email' => 'original@example.com']);
    }

    protected function tearDown(): void
    {
        try {
            if ($this->app && DB::transactionLevel() > 0) {
                DB::rollBack();
            }
        } finally {
            parent::tearDown();
        }
    }

    public static function nulEmails(): iterable
    {
        foreach (['POST', 'PATCH'] as $method) {
            foreach ([
                'start' => "\0new@example.com",
                'local part' => "ne\0w@example.com",
                'domain' => "new@exam\0ple.com",
                'end' => "new@example.com\0",
                'after valid address' => "new@example.com\0.other",
                'quoted' => "\"ne\0w\"@example.com",
                'comment' => "new(comment\0)@example.com",
                'surrounded by whitespace' => " \t\0New@Example.COM\0\r\n ",
            ] as $position => $email) {
                yield "$method $position" => [$method, $email];
            }
        }
    }

    private function payload(string $method, string $email): array
    {
        $payload = ['name' => 'Changed Name', 'email' => $email];

        return $method === 'PATCH' ? $payload : [...$payload,
            'password' => 'Senha!Segura123', 'password_confirmation' => 'Senha!Segura123', 'role' => 'requester',
        ];
    }

    private function endpoint(string $method): string
    {
        return '/api/admin/users'.($method === 'PATCH' ? '/'.$this->target->id : '');
    }

    #[DataProvider('nulEmails')]
    public function test_nul_in_json_is_rejected_before_any_insert_or_update(string $method, string $email): void
    {
        $before = DB::table('users')->orderBy('id')->get()->toJson();
        $json = json_encode($this->payload($method, $email), JSON_THROW_ON_ERROR);
        // Exercise the wire representation, including a literal JSON Unicode escape.
        $this->assertStringContainsString('\\u0000', $json);
        DB::enableQueryLog();
        DB::flushQueryLog();
        try {
            $this->call($method, $this->endpoint($method), server: [
                'CONTENT_TYPE' => 'application/json', 'HTTP_ACCEPT' => 'application/json',
            ], content: $json)->assertUnprocessable()->assertJsonValidationErrors('email')->assertJsonMissingPath('data');
            $queries = DB::getQueryLog();
        } finally {
            DB::disableQueryLog();
        }
        foreach ($queries as $query) {
            $this->assertDoesNotMatchRegularExpression('/^\s*(insert|update)\b/i', $query['query']);
            // Invalid bytes must not reach even the uniqueness lookup.
            foreach ($query['bindings'] as $binding) {
                if (is_string($binding)) {
                    $this->assertStringNotContainsString("\0", $binding);
                }
            }
        }
        $this->assertSame($before, DB::table('users')->orderBy('id')->get()->toJson());
    }

    public static function validEmails(): iterable
    {
        foreach (['POST', 'PATCH'] as $method) {
            yield "$method normalized" => [$method, " \tNew.User+tag@Example.COM\r\n\u{00a0}", 'new.user+tag@example.com'];
            yield "$method quoted" => [$method, '"New.User"@Example.COM', '"new.user"@example.com'];
        }
    }

    #[DataProvider('validEmails')]
    public function test_valid_email_response_matches_persisted_normalized_value(string $method, string $email, string $expected): void
    {
        $response = $this->json($method, $this->endpoint($method), $this->payload($method, $email))
            ->assertStatus($method === 'POST' ? 201 : 200)->assertJsonPath('data.email', $expected);
        $this->assertSame($expected, User::findOrFail($response->json('data.id'))->email);
        $this->assertSame(['id', 'name', 'email', 'role', 'disabled_at', 'created_at'], array_keys($response->json('data')));
    }
}
