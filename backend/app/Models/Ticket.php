<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

#[Fillable([
    'requester_id',
    'assigned_to',
    'category_id',
    'status_id',
    'sla_policy_id',
    'title',
    'description',
    'priority',
    'first_response_due_at',
    'resolution_due_at',
    'first_responded_at',
    'resolved_at',
    'closed_at',
])]
class Ticket extends Model
{
    public function scopeVisibleTo(Builder $query, User $user): void
    {
        if ($user->role === 'requester') {
            $query->where('requester_id', $user->id);
        } elseif ($user->role === 'technician') {
            $query->where(function (Builder $query) use ($user): void {
                $query->where('assigned_to', $user->id)->orWhereNull('assigned_to');
            });
        } elseif ($user->role !== 'admin') {
            $query->whereRaw('1 = 0');
        }
    }

    protected function casts(): array
    {
        return [
            'first_response_due_at' => 'datetime',
            'resolution_due_at' => 'datetime',
            'first_responded_at' => 'datetime',
            'resolved_at' => 'datetime',
            'closed_at' => 'datetime',
        ];
    }

    public function requester(): BelongsTo
    {
        return $this->belongsTo(User::class, 'requester_id');
    }

    public function assignee(): BelongsTo
    {
        return $this->belongsTo(User::class, 'assigned_to');
    }

    public function category(): BelongsTo
    {
        return $this->belongsTo(Category::class, 'category_id');
    }

    public function status(): BelongsTo
    {
        return $this->belongsTo(TicketStatus::class, 'status_id');
    }

    public function slaPolicy(): BelongsTo
    {
        return $this->belongsTo(SlaPolicy::class, 'sla_policy_id');
    }

    public function comments(): HasMany
    {
        return $this->hasMany(TicketComment::class, 'ticket_id');
    }

    public function attachments(): HasMany
    {
        return $this->hasMany(TicketAttachment::class);
    }

    public function activities(): HasMany
    {
        return $this->hasMany(TicketActivity::class, 'ticket_id');
    }
}
