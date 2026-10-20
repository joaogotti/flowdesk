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
        Schema::create('sla_policies', function (Blueprint $table) {
            $table->id();
            $table->string('priority', 10)->unique();
            $table->integer('first_response_minutes');
            $table->integer('resolution_minutes');
            $table->timestampsTz();
        });

        DB::statement("ALTER TABLE sla_policies ADD CONSTRAINT sla_policies_priority_check CHECK (priority IN ('low', 'medium', 'high', 'urgent'))");
        DB::statement('ALTER TABLE sla_policies ADD CONSTRAINT sla_policies_first_response_minutes_check CHECK (first_response_minutes > 0)');
        DB::statement('ALTER TABLE sla_policies ADD CONSTRAINT sla_policies_resolution_minutes_check CHECK (resolution_minutes > 0)');
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('sla_policies');
    }
};
