<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;

class ReportFilters
{
    public function options(): array
    {
        $connection = DB::connection();

        return ReportReadSnapshot::run($connection, function () use ($connection): array {
            $assignees = $connection->table('users')->where(function ($query): void {
                $query->where(fn ($q) => $q->where('role', 'technician')->whereNull('disabled_at'))
                    ->orWhereExists(fn ($q) => $q->selectRaw('1')->from('tickets')->whereColumn('tickets.assigned_to', 'users.id'));
            })->orderBy('name')->orderBy('id')->get(['id', 'name', 'role', 'disabled_at'])
                ->map(fn ($row): array => ['id' => (int) $row->id, 'name' => $row->name, 'role' => $row->role, 'is_active' => $row->disabled_at === null])->all();
            $categories = $connection->table('categories')->orderBy('name')->orderBy('id')->get(['id', 'name', 'is_active'])
                ->map(fn ($row): array => ['id' => (int) $row->id, 'name' => $row->name, 'is_active' => (bool) $row->is_active])->all();
            $statuses = $connection->table('ticket_statuses')->orderBy('position')->orderBy('id')->get(['id', 'code', 'name'])
                ->map(fn ($row): array => ['id' => (int) $row->id, 'code' => $row->code, 'name' => $row->name])->all();

            return ['assignees' => $assignees, 'unassigned_value' => 'unassigned', 'categories' => $categories,
                'priorities' => ['low', 'medium', 'high', 'urgent'], 'statuses' => $statuses];
        });
    }
}
