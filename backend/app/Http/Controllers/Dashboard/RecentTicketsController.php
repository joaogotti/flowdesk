<?php

namespace App\Http\Controllers\Dashboard;

use App\Http\Controllers\Controller;
use App\Models\Ticket;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class RecentTicketsController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        abort_unless(
            in_array($request->user()?->role, ['requester', 'technician', 'admin'], true),
            403,
            'Acesso não permitido.',
        );

        $tickets = Ticket::query()->visibleTo($request->user())
            ->with(['status:id,code,name', 'assignee:id,name'])
            ->orderByDesc('updated_at')->orderByDesc('id')
            ->limit(5)
            ->get(['id', 'title', 'status_id', 'assigned_to', 'updated_at'])
            ->map(fn (Ticket $ticket): array => [
                'id' => $ticket->id,
                'title' => $ticket->title,
                'status' => $ticket->status->only(['code', 'name']),
                'assignee' => $ticket->assignee?->only(['id', 'name']),
                'updated_at' => $ticket->updated_at->toISOString(),
            ]);

        return response()->json(['data' => $tickets]);
    }
}
