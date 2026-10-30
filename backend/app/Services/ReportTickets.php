<?php

namespace App\Services;

use Carbon\CarbonImmutable;
use Illuminate\Database\Query\Builder;
use Illuminate\Pagination\LengthAwarePaginator;
use Illuminate\Support\Facades\DB;

class ReportTickets
{
    // No pagination here: a future export can reuse the identical filtered, classified query.
    public function query(CarbonImmutable $start, CarbonImmutable $end, CarbonImmutable $now, array $filters): Builder
    {
        $connection = DB::connection();
        $cohort = ReportTicketsQuery::cohort($connection, $start, $end, $filters);
        $classified = ReportTicketsQuery::classified($connection, $cohort, $now);

        return $connection->query()->fromSub($classified, 'records')
            ->join('users as requester', 'records.requester_id', '=', 'requester.id')
            ->leftJoin('users as assignee', 'records.assigned_to', '=', 'assignee.id')
            ->join('categories', 'records.category_id', '=', 'categories.id')
            ->select(['records.id', 'records.title', 'records.requester_id', 'requester.name as requester_name',
                'records.assigned_to', 'assignee.name as assignee_name', 'records.category_id', 'categories.name as category_name',
                'records.priority', 'records.status_id', 'records.report_status', 'records.report_status_name',
                'records.created_at', 'records.first_responded_at', 'records.resolved_at', 'records.closed_at',
                'records.first_response_due_at', 'records.resolution_due_at', 'records.first_state', 'records.resolution_state'])
            ->orderByDesc('records.created_at')->orderByDesc('records.id');
    }

    public function paginate(CarbonImmutable $start, CarbonImmutable $end, CarbonImmutable $now, array $filters, int $page, int $perPage): LengthAwarePaginator
    {
        return ReportReadSnapshot::run(DB::connection(), function () use ($start, $end, $now, $filters, $page, $perPage) {
            return $this->query($start, $end, $now, $filters)->paginate($perPage, ['*'], 'page', $page)
                ->through(fn (object $row): array => $this->publicData($row));
        });
    }

    public function publicData(object $row): array
    {
        $date = fn (?string $value): ?string => $value === null ? null : CarbonImmutable::parse($value, 'UTC')->utc()->toISOString();

        return ['id' => (int) $row->id, 'title' => $row->title,
            'requester' => ['id' => (int) $row->requester_id, 'name' => $row->requester_name],
            'assignee' => $row->assigned_to === null ? null : ['id' => (int) $row->assigned_to, 'name' => $row->assignee_name],
            'category' => ['id' => (int) $row->category_id, 'name' => $row->category_name],
            'priority' => $row->priority,
            'status' => ['id' => (int) $row->status_id, 'code' => $row->report_status, 'name' => $row->report_status_name],
            'created_at' => $date($row->created_at), 'first_responded_at' => $date($row->first_responded_at),
            'resolved_at' => $date($row->resolved_at), 'closed_at' => $date($row->closed_at),
            'first_response_due_at' => $date($row->first_response_due_at), 'resolution_due_at' => $date($row->resolution_due_at),
            'sla' => ['first_response' => $row->first_state, 'resolution' => $row->resolution_state]];
    }
}
