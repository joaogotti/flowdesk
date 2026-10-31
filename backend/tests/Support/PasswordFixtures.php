<?php

namespace Tests\Support;

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

trait PasswordFixtures
{
    protected function createPasswordFixtures(): void
    {
        $connection = DB::connection();
        $this->assertTrue(($connection->getDriverName() === 'sqlite' && $connection->getDatabaseName() === ':memory:') ||
            ($connection->getDriverName() === 'pgsql' && $connection->getDatabaseName() === 'flowdesk_password_test'
                && preg_match('/^flowdesk-password-test-[a-f0-9]+$/', $connection->getConfig('host')) === 1));
        $this->assertFalse(Schema::hasTable('users'));
        // Fixtures only: never run migrations or attach development volumes.
        Schema::create('users', function (Blueprint $table): void {
            $table->id();
            $table->string('name');
            $table->string('email')->unique();
            $table->timestamp('email_verified_at')->nullable();
            $table->string('password');
            $table->rememberToken();
            $table->timestamps();
            $table->string('role', 20)->default('requester');
            $table->timestampTz('disabled_at')->nullable();
            $table->bigInteger('session_version')->default(0);
        });
        Schema::create('sessions', function (Blueprint $table): void {
            $table->string('id')->primary();
            $table->foreignId('user_id')->nullable()->index();
            $table->string('ip_address', 45)->nullable();
            $table->text('user_agent')->nullable();
            $table->longText('payload');
            $table->integer('last_activity')->index();
        });
        Schema::create('tickets', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('requester_id')->constrained('users')->restrictOnDelete();
            $table->foreignId('assigned_to')->nullable()->constrained('users')->restrictOnDelete();
            $table->text('title');
        });
        Schema::create('ticket_comments', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('ticket_id')->constrained('tickets')->restrictOnDelete();
            $table->foreignId('user_id')->constrained('users')->restrictOnDelete();
            $table->text('body');
        });
        Schema::create('ticket_activities', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('ticket_id')->constrained('tickets')->restrictOnDelete();
            $table->foreignId('actor_id')->constrained('users')->restrictOnDelete();
            $table->string('action');
        });
    }

    protected function passwordSnapshot(): array
    {
        $result = [];
        foreach (['users', 'sessions', 'tickets', 'ticket_comments', 'ticket_activities'] as $table) {
            $result[$table] = DB::table($table)->orderBy('id')->get()->toJson();
        }

        return $result;
    }
}
