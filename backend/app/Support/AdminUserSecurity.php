<?php

namespace App\Support;

use App\Models\Ticket;
use App\Models\User;
use Illuminate\Support\Facades\DB;

class AdminUserSecurity
{
    /** @return array<int, User|null> */
    public static function lockUsers(int $actorId, int $targetId): array
    {
        // Shared by role and status mutations; released on transaction completion.
        if (DB::connection()->getDriverName() === 'pgsql') {
            DB::select('SELECT pg_advisory_xact_lock(706402, 1)');
        }
        $ids = array_unique([$actorId, $targetId]);
        sort($ids, SORT_NUMERIC);
        $records = [];
        foreach ($ids as $id) {
            $query = User::query()->whereKey($id);
            $records[$id] = ($id === $targetId ? $query->lockForUpdate() : $query->sharedLock())->first();
        }

        return $records;
    }

    public static function hasBlockingAssignments(int $userId): bool
    {
        // Do not lock tickets here: ticket writers acquire ticket -> user locks.
        return Ticket::query()->where('assigned_to', $userId)
            ->whereHas('status', fn ($query) => $query->whereIn('code', ['open', 'in_progress', 'waiting_requester', 'resolved']))->exists();
    }
}
