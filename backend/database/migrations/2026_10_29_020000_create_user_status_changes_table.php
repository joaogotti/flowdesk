<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
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
        DB::statement('ALTER TABLE user_status_changes ADD CONSTRAINT user_status_changes_different_states_check CHECK ((previous_disabled_at IS NULL) <> (new_disabled_at IS NULL))');
        DB::statement('ALTER TABLE user_status_changes ADD CONSTRAINT user_status_changes_different_users_check CHECK (actor_id <> target_user_id)');
    }

    public function down(): void
    {
        Schema::dropIfExists('user_status_changes');
    }
};
