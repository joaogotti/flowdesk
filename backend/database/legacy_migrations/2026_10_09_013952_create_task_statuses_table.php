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
        Schema::create('task_statuses', function (Blueprint $table) {
            $table->id();
            $table->foreignId('project_id')->constrained('projects')->restrictOnDelete();
            $table->string('name', 80);
            $table->integer('position');
            $table->boolean('is_completed')->default(false);
            $table->timestampsTz();

            $table->unique(['project_id', 'name']);
            $table->unique(['project_id', 'id']);
            $table->index(['project_id', 'position']);
        });

        DB::statement('ALTER TABLE task_statuses ADD CONSTRAINT task_statuses_position_check CHECK (position >= 0)');
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('task_statuses');
    }
};
