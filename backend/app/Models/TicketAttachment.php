<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

#[Fillable(['ticket_id', 'uploaded_by', 'storage_key', 'original_name', 'mime_type', 'size_bytes', 'sha256', 'state', 'created_at', 'confirmed_at', 'expires_at', 'cleaned_at'])]
#[Hidden(['storage_key'])]
class TicketAttachment extends Model
{
    public const UPDATED_AT = null;

    protected function casts(): array
    {
        return ['size_bytes' => 'integer', 'created_at' => 'datetime', 'confirmed_at' => 'datetime', 'expires_at' => 'datetime', 'cleaned_at' => 'datetime'];
    }

    public function ticket(): BelongsTo
    {
        return $this->belongsTo(Ticket::class);
    }

    public function uploader(): BelongsTo
    {
        return $this->belongsTo(User::class, 'uploaded_by');
    }

    public function publicData(): array
    {
        return ['id' => $this->id, 'original_name' => $this->original_name, 'mime_type' => $this->mime_type,
            'size_bytes' => $this->size_bytes, 'uploaded_by' => $this->uploader->only(['id', 'name']),
            'created_at' => $this->created_at->toISOString(), 'confirmed_at' => $this->confirmed_at?->toISOString()];
    }
}
