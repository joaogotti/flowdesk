<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        $trim = match (DB::getDriverName()) {
            'pgsql' => 'BTRIM',
            'sqlite' => 'TRIM',
            default => throw new RuntimeException('O índice de categorias requer PostgreSQL ou SQLite.'),
        };

        DB::statement("CREATE UNIQUE INDEX categories_name_normalized_unique ON categories (LOWER({$trim}(name)))");
    }

    public function down(): void
    {
        DB::statement('DROP INDEX categories_name_normalized_unique');
    }
};
