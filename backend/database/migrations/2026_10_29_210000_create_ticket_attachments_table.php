<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ticket_attachments', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('ticket_id')->constrained()->restrictOnDelete();
            $table->foreignId('uploaded_by')->constrained('users')->restrictOnDelete();
            $table->string('storage_key', 120)->unique();
            $table->string('original_name', 200);
            $table->string('mime_type', 40);
            $table->bigInteger('size_bytes');
            $table->string('sha256', 64);
            $table->enum('state', ['pending', 'ready', 'failed'])->default('pending');
            $table->timestampTz('created_at');
            $table->timestampTz('confirmed_at')->nullable();
            $table->timestampTz('expires_at');
            // Allows retrying failed cleanup without repeatedly scanning already-cleaned rows.
            $table->timestampTz('cleaned_at')->nullable();
            $table->index(['ticket_id', 'state', 'created_at']);
            $table->index(['state', 'expires_at']);
            $table->index(['state', 'cleaned_at', 'id']);
            $table->index('uploaded_by');
        });
        if (DB::getDriverName() === 'pgsql') {
            foreach ([
                'size' => 'size_bytes > 0 AND size_bytes <= 5242880',
                'sha256' => "sha256 ~ '^[a-f0-9]{64}$'",
                'key' => "storage_key ~ ('^tickets/' || ticket_id::text || '/[a-f0-9]{32}\\.(jpg|png|pdf|txt)$')",
                'name' => "length(original_name) > 0 AND original_name !~ '[[:cntrl:]/\\\\]'",
                'mime' => "mime_type IN ('image/jpeg','image/png','application/pdf','text/plain')",
                'dates' => 'expires_at > created_at AND (confirmed_at IS NULL OR confirmed_at >= created_at) AND (cleaned_at IS NULL OR cleaned_at >= created_at)',
                'state_dates' => "(state = 'ready' AND confirmed_at IS NOT NULL AND cleaned_at IS NULL) OR (state = 'pending' AND confirmed_at IS NULL AND cleaned_at IS NULL) OR (state = 'failed' AND confirmed_at IS NULL)",
            ] as $name => $expression) {
                DB::statement("ALTER TABLE ticket_attachments ADD CONSTRAINT ticket_attachments_{$name}_check CHECK ({$expression})");
            }
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('ticket_attachments');
    }
};
