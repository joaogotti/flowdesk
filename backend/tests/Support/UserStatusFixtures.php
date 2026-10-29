<?php

namespace Tests\Support;

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

trait UserStatusFixtures
{
    use UserRoleFixtures;

    protected function configureStatusPostgresql(): ?array
    {
        $host = getenv('FLOWDESK_USER_STATUS_PG_HOST');
        if (! $host) {
            return null;
        }
        $this->assertMatchesRegularExpression('/^flowdesk-user-status-test-[a-f0-9]+$/', $host);
        $connection = ['driver' => 'pgsql', 'host' => $host, 'port' => 5432,
            'database' => 'flowdesk_user_status_test', 'username' => 'postgres', 'password' => '',
            'charset' => 'utf8', 'prefix' => '', 'search_path' => 'public', 'sslmode' => 'prefer'];
        config(['database.default' => 'user_status_pg', 'database.connections.user_status_pg' => $connection]);

        return $connection;
    }

    protected function createStatusFixtures(): void
    {
        if (DB::connection()->getDriverName() === 'pgsql') {
            $this->assertSame('flowdesk_user_status_test', DB::connection()->getDatabaseName());
            $this->createAssignmentFixtures();
            (require database_path('migrations/2026_10_28_210000_create_user_role_changes_table.php'))->up();
            (require database_path('migrations/2026_10_29_020000_create_user_status_changes_table.php'))->up();
        } else {
            $this->createRoleFixtures();
            Schema::create('user_status_changes', function (Blueprint $table): void {
                $table->id();
                $table->foreignId('actor_id')->constrained('users')->restrictOnDelete();
                $table->foreignId('target_user_id')->constrained('users')->restrictOnDelete();
                $table->timestampTz('previous_disabled_at')->nullable();
                $table->timestampTz('new_disabled_at')->nullable();
                $table->timestampTz('created_at');
                $table->index(['target_user_id', 'created_at']);
                $table->index('actor_id');
            });
        }
        config(['logging.default' => 'null']);
    }

    protected function statusSnapshot(): array
    {
        return [...$this->roleSnapshot(), 'user_status_changes' => DB::table('user_status_changes')->orderBy('id')->get()->toJson()];
    }
}
