<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

#[Fillable(['actor_id', 'target_user_id', 'previous_disabled_at', 'new_disabled_at', 'created_at'])]
class UserStatusChange extends Model
{
    public const UPDATED_AT = null;

    protected function casts(): array
    {
        return ['previous_disabled_at' => 'datetime', 'new_disabled_at' => 'datetime', 'created_at' => 'datetime'];
    }

    public function actor(): BelongsTo
    {
        return $this->belongsTo(User::class, 'actor_id');
    }

    public function targetUser(): BelongsTo
    {
        return $this->belongsTo(User::class, 'target_user_id');
    }
}
