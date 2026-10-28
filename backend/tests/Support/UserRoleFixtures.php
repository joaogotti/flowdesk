<?php

namespace Tests\Support;

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

trait UserRoleFixtures
{
    use AssignmentFixtures;

    protected function configureRolePostgresql(): ?array
    {
        $host = getenv('FLOWDESK_ROLE_PG_HOST');
        if (! $host) {
            return null;
        }
        $this->assertMatchesRegularExpression('/^flowdesk-role-test-[a-f0-9]+$/', $host);
        $connection = [
            'driver' => 'pgsql', 'host' => $host, 'port' => 5432,
            'database' => 'flowdesk_role_test', 'username' => 'postgres', 'password' => '',
            'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer',
        ];
        config(['database.default' => 'role_pg', 'database.connections.role_pg' => $connection]);

        return $connection;
    }

    protected function createRoleFixtures(): void
    {
        $this->createAssignmentFixtures();
        if (DB::connection()->getDriverName() === 'pgsql') {
            $this->assertSame('flowdesk_role_test', DB::connection()->getDatabaseName());
            (require database_path('migrations/2026_10_28_210000_create_user_role_changes_table.php'))->up();
        } else {
            // SQLite fixture only. The approved migration is executed exclusively on disposable PG.
            $this->assertSame(':memory:', DB::connection()->getDatabaseName());
            Schema::create('user_role_changes', function (Blueprint $table): void {
                $table->id();
                $table->foreignId('actor_id')->constrained('users')->restrictOnDelete();
                $table->foreignId('target_user_id')->constrained('users')->restrictOnDelete();
                $table->string('previous_role', 20);
                $table->string('new_role', 20);
                $table->timestampTz('created_at');
            });
        }
        config(['logging.default' => 'null']);
    }

    protected function roleSnapshot(): array
    {
        return [...$this->snapshot(), 'user_role_changes' => DB::table('user_role_changes')->orderBy('id')->get()->toJson()];
    }
}
