<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // This migration is verified only on disposable PostgreSQL in this delivery.
        Schema::create('user_role_changes', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('actor_id')->constrained('users')->restrictOnDelete();
            $table->foreignId('target_user_id')->constrained('users')->restrictOnDelete();
            $table->string('previous_role', 20);
            $table->string('new_role', 20);
            $table->timestampTz('created_at');
            $table->index(['target_user_id', 'created_at']);
            $table->index('actor_id');
        });
        DB::statement("ALTER TABLE user_role_changes ADD CONSTRAINT user_role_changes_previous_role_check CHECK (previous_role IN ('requester', 'technician', 'admin'))");
        DB::statement("ALTER TABLE user_role_changes ADD CONSTRAINT user_role_changes_new_role_check CHECK (new_role IN ('requester', 'technician', 'admin'))");
        DB::statement('ALTER TABLE user_role_changes ADD CONSTRAINT user_role_changes_different_roles_check CHECK (previous_role <> new_role)');
        DB::statement('ALTER TABLE user_role_changes ADD CONSTRAINT user_role_changes_different_users_check CHECK (actor_id <> target_user_id)');
    }

    public function down(): void
    {
        Schema::dropIfExists('user_role_changes');
    }
};
