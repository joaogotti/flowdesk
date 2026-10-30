<?php

namespace App\Services;

use Carbon\CarbonImmutable;
use Illuminate\Database\Connection;
use Illuminate\Database\Query\Builder;

class ReportTicketsQuery
{
    public static function timestamp(Connection $connection, CarbonImmutable $value): string
    {
        return $connection->getDriverName() === 'pgsql' ? $value->utc()->toIso8601String() : $value->utc()->toDateTimeString();
    }

    public static function cohort(Connection $connection, CarbonImmutable $start, CarbonImmutable $end, array $filters = []): Builder
    {
        $query = $connection->table('tickets')->where('tickets.created_at', '>=', self::timestamp($connection, $start))
            ->where('tickets.created_at', '<', self::timestamp($connection, $end));
        foreach (['category_id', 'priority'] as $field) {
            if (isset($filters[$field])) {
                $query->where('tickets.'.$field, $filters[$field]);
            }
        }
        if (isset($filters['assigned_to'])) {
            if ($filters['assigned_to'] === 'unassigned') {
                $query->whereNull('tickets.assigned_to');
            } else {
                $query->where('tickets.assigned_to', $filters['assigned_to']);
            }
        }
        if (isset($filters['status'])) {
            $query->whereIn('tickets.status_id', $connection->table('ticket_statuses')->where('code', $filters['status'])->select('id'));
        }

        return $query;
    }

    public static function classified(Connection $connection, Builder $cohort, CarbonImmutable $now): Builder
    {
        $base = $cohort->join('ticket_statuses', 'tickets.status_id', '=', 'ticket_statuses.id')
            ->select(['tickets.*', 'ticket_statuses.code as report_status', 'ticket_statuses.name as report_status_name'])
            ->selectRaw('? AS report_now', [$now->toIso8601String()]);

        return $connection->query()->fromSub($base, 'cohort')->select('cohort.*')
            ->selectRaw(self::classification($connection, 'first_response_due_at', 'first_responded_at').' AS first_state')
            ->selectRaw(self::classification($connection, 'resolution_due_at', 'resolved_at').' AS resolution_state');
    }

    private static function classification(Connection $connection, string $dueColumn, string $occurredColumn): string
    {
        // Column names are private constants; no request input is interpolated into SQL.
        $date = fn (string $column): string => $connection->getDriverName() === 'sqlite' ? "julianday({$column})" : $column;
        $created = $date('created_at');
        $due = $date($dueColumn);
        $occurred = $date($occurredColumn);
        $resolved = $date('resolved_at');
        $closed = $date('closed_at');
        $now = $connection->getDriverName() === 'pgsql' ? 'CAST(report_now AS timestamp with time zone)' : 'julianday(report_now)';

        return "CASE
            WHEN report_status = 'cancelled' OR {$created} IS NULL OR {$due} IS NULL OR {$created} > {$now} OR {$due} < {$created}
                OR (closed_at IS NOT NULL AND ({$closed} IS NULL OR {$closed} < {$created} OR {$closed} > {$now}))
                OR (resolved_at IS NOT NULL AND ({$resolved} IS NULL OR {$resolved} < {$created} OR {$resolved} > {$now} OR (closed_at IS NOT NULL AND {$resolved} > {$closed})))
                OR ({$occurredColumn} IS NOT NULL AND ({$occurred} IS NULL OR {$occurred} < {$created} OR {$occurred} > {$now}
                    OR (closed_at IS NOT NULL AND {$occurred} > {$closed}) OR (resolved_at IS NOT NULL AND {$occurred} > {$resolved}))) THEN 'not_evaluable'
            WHEN {$occurredColumn} IS NOT NULL THEN CASE WHEN {$occurred} <= {$due} THEN 'met' ELSE 'late' END
            WHEN report_status IN ('open', 'in_progress', 'waiting_requester') AND resolved_at IS NULL AND closed_at IS NULL
                THEN CASE WHEN {$now} > {$due} THEN 'pending_overdue' ELSE 'pending_on_time' END
            ELSE 'not_evaluable' END";
    }
}
