<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('tasks', function (Blueprint $table) {
            $table->id();
            $table->foreignId('project_id')->constrained('projects')->restrictOnDelete();
            $table->foreignId('status_id');
            $table->foreignId('created_by')->index()->constrained('users')->restrictOnDelete();
            $table->foreignId('assignee_id')->nullable()->index();
            $table->string('title', 200);
            $table->text('description')->nullable();
            $table->string('priority', 10)->default('medium');
            $table->timestampTz('due_at')->nullable();
            $table->integer('position');
            $table->timestampTz('archived_at')->nullable();
            $table->timestampsTz();

            $table->foreign(['project_id', 'status_id'])
                ->references(['project_id', 'id'])
                ->on('task_statuses')
                ->restrictOnDelete();

            $table->foreign(['project_id', 'assignee_id'])
                ->references(['project_id', 'user_id'])
                ->on('project_user')
                ->restrictOnDelete();

            $table->unique(['project_id', 'id']);
            $table->index(['project_id', 'status_id', 'position']);
            $table->index(['project_id', 'due_at']);
        });

        DB::statement("ALTER TABLE tasks ADD CONSTRAINT tasks_priority_check CHECK (priority IN ('low', 'medium', 'high', 'urgent'))");
        DB::statement('ALTER TABLE tasks ADD CONSTRAINT tasks_position_check CHECK (position >= 0)');
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('tasks');
    }
};
