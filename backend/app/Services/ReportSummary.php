<?php

namespace App\Services;

use Carbon\CarbonImmutable;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

class ReportSummary
{
    private const STATES = ['met', 'late', 'pending_on_time', 'pending_overdue', 'not_evaluable'];

    public function summarize(CarbonImmutable $start, CarbonImmutable $end, CarbonImmutable $now): array
    {
        $connection = DB::connection();

        return ReportReadSnapshot::run($connection, function () use ($connection, $start, $end, $now): array {
            $cohort = ReportTicketsQuery::cohort($connection, $start, $end);
            $classes = ReportTicketsQuery::classified($connection, clone $cohort, $now);
            $groups = $connection->query()->fromSub($classes, 'classified')->select(['first_state', 'resolution_state'])
                ->selectRaw('COUNT(*) AS total')
                ->selectRaw('SUM(CASE WHEN assigned_to IS NULL THEN 1 ELSE 0 END) AS unassigned')
                ->selectRaw("SUM(CASE WHEN report_status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled")
                ->groupBy('first_state', 'resolution_state')->get();
            $first = $resolution = array_fill_keys(self::STATES, 0);
            $total = $unassigned = $cancelled = 0;
            foreach ($groups as $group) {
                $count = (int) $group->total;
                $first[$group->first_state] += $count;
                $resolution[$group->resolution_state] += $count;
                $total += $count;
                $unassigned += (int) $group->unassigned;
                $cancelled += (int) $group->cancelled;
            }
            $statuses = (clone $cohort)->select('status_id')->selectRaw('COUNT(*) AS total')->groupBy('status_id');
            $byStatus = $connection->table('ticket_statuses')->leftJoinSub($statuses, 'counts', 'ticket_statuses.id', '=', 'counts.status_id')
                ->orderBy('position')->orderBy('ticket_statuses.id')->get(['code', 'name', DB::raw('COALESCE(counts.total, 0) AS total')])
                ->map(fn ($row): array => ['code' => $row->code, 'name' => $row->name, 'count' => (int) $row->total])->all();
            $byCategory = (clone $cohort)->join('categories', 'tickets.category_id', '=', 'categories.id')
                ->select(['categories.id', 'categories.name', 'categories.is_active'])->selectRaw('COUNT(*) AS total')
                ->groupBy('categories.id', 'categories.name', 'categories.is_active')->orderBy('categories.id')->get()
                ->map(fn ($row): array => ['id' => (int) $row->id, 'name' => $row->name, 'is_active' => (bool) $row->is_active, 'count' => (int) $row->total])->all();
            $priorityCounts = (clone $cohort)->select('priority')->selectRaw('COUNT(*) AS total')->groupBy('priority')->pluck('total', 'priority');
            $priorities = [];
            foreach (['low', 'medium', 'high', 'urgent'] as $priority) {
                $priorities[] = ['code' => $priority, 'count' => (int) ($priorityCounts[$priority] ?? 0)];
            }

            return [
                'movements' => ['created' => $total,
                    'resolved_distinct' => $this->within($connection->table('ticket_activities'), 'created_at', $start, $end)
                        ->where('action', 'status_changed')->where('changes->status->to', 'resolved')->distinct()->count('ticket_id'),
                    'closed' => $this->within($connection->table('tickets'), 'closed_at', $start, $end)->count()],
                'cohort' => ['scope' => 'tickets_created_in_period', 'total' => $total,
                    'unassigned' => ['count' => $unassigned, 'scope' => 'all_cohort_tickets_including_final_and_cancelled'],
                    'by_status' => $byStatus, 'by_category' => $byCategory, 'by_priority' => $priorities],
                'sla' => ['scope' => 'tickets_created_in_period', 'basis' => 'currently_recorded_deadlines',
                    'note' => 'Os prazos atualmente registrados podem ter sido recalculados após mudanças de prioridade. Tempos são corridos, sem pausa em waiting_requester.',
                    'first_response' => $this->sla($first, $cancelled), 'resolution' => $this->sla($resolution, $cancelled)],
            ];
        });
    }

    private function within(Builder $query, string $column, CarbonImmutable $start, CarbonImmutable $end): Builder
    {
        return $query->where($column, '>=', ReportTicketsQuery::timestamp($query->getConnection(), $start))
            ->where($column, '<', ReportTicketsQuery::timestamp($query->getConnection(), $end));
    }

    private function sla(array $counts, int $cancelled): array
    {
        $denominator = $counts['met'] + $counts['late'];

        return [...$counts, 'cancelled_excluded' => $cancelled, 'compliance_denominator' => $denominator,
            'compliance_rate' => $denominator === 0 ? null : round(100 * $counts['met'] / $denominator, 2)];
    }
}
