<?php

namespace App\Http\Controllers\Dashboard;

use App\Http\Controllers\Controller;
use App\Models\Ticket;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class StatsController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        abort_unless(
            in_array($request->user()?->role, ['requester', 'technician', 'admin'], true),
            403,
            'Acesso não permitido.',
        );

        $query = Ticket::query()->visibleTo($request->user())
            ->leftJoin('ticket_statuses', 'tickets.status_id', '=', 'ticket_statuses.id')
            ->selectRaw('COUNT(*) AS total')
            ->selectRaw('COUNT(CASE WHEN tickets.assigned_to IS NULL THEN 1 END) AS unassigned');

        $statuses = ['open', 'in_progress', 'waiting_requester', 'resolved', 'closed', 'cancelled'];
        foreach ($statuses as $status) {
            $query->selectRaw("COUNT(CASE WHEN ticket_statuses.code = ? THEN 1 END) AS {$status}", [$status]);
        }

        $counts = $query->toBase()->first();
        $data = [];
        foreach (['total', ...$statuses, 'unassigned'] as $key) {
            $data[$key] = (int) $counts->$key;
        }

        return response()->json(['data' => $data]);
    }
}
