<?php

namespace App\Support;

use App\Models\Category;
use App\Models\TicketActivity;
use App\Models\User;
use Illuminate\Database\Eloquent\Collection;

class TicketActivityDetails
{
    private const FIELDS = [
        'assignment_changed' => ['assigned_to' => 'assignee'],
        'status_changed' => ['status' => 'status'],
        'details_changed' => ['category_id' => 'category', 'priority' => 'priority'],
    ];

    private const STATUSES = ['open', 'in_progress', 'waiting_requester', 'resolved', 'closed', 'cancelled'];

    private const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

    /**
     * Only call for activities already scoped to a ticket visible to staff.
     *
     * @param  Collection<int, TicketActivity>  $activities
     */
    public function forActivities(Collection $activities): array
    {
        $details = [];
        $userIds = [];
        $categoryIds = [];

        foreach ($activities as $activity) {
            if (! is_array($activity->changes)) {
                continue;
            }

            foreach (self::FIELDS[$activity->action] ?? [] as $source => $field) {
                $transition = $activity->changes[$source] ?? null;
                if (! is_array($transition)) {
                    continue;
                }

                foreach (['from', 'to'] as $side) {
                    // An absent/invalid side is unknown, not an explicit unassignment.
                    if (! array_key_exists($side, $transition) || ! $this->validValue($field, $transition[$side])) {
                        continue;
                    }

                    $value = $transition[$side];
                    $details[$activity->id][$field][$side] = $value;
                    if ($field === 'assignee' && $value !== null) {
                        $userIds[$value] = $value;
                    } elseif ($field === 'category' && $value !== null) {
                        $categoryIds[$value] = $value;
                    }
                }
            }
        }

        // Historical references may be inactive/disabled. Select only public names.
        $users = $userIds === [] ? collect() : User::query()->whereIn('id', array_values($userIds))->get(['id', 'name'])->keyBy('id');
        $categories = $categoryIds === [] ? collect() : Category::query()->whereIn('id', array_values($categoryIds))->get(['id', 'name'])->keyBy('id');

        foreach ($details as $activityId => $fields) {
            foreach (['assignee' => $users, 'category' => $categories] as $field => $references) {
                foreach ($fields[$field] ?? [] as $side => $id) {
                    $details[$activityId][$field][$side] = $id === null ? null : [
                        'id' => $id,
                        'name' => $references->get($id)?->name,
                    ];
                }
            }
        }

        return $details;
    }

    private function validValue(string $field, mixed $value): bool
    {
        return match ($field) {
            'assignee', 'category' => $value === null || (is_int($value) && $value > 0),
            'status' => $value === null || in_array($value, self::STATUSES, true),
            'priority' => $value === null || in_array($value, self::PRIORITIES, true),
            default => false,
        };
    }
}
