<?php

namespace App\Http\Controllers\Tickets;

use App\Http\Controllers\Controller;
use App\Models\Ticket;
use App\Models\TicketActivity;
use App\Models\TicketComment;
use App\Support\TicketActivityDetails;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class ShowTicketController extends Controller
{
    public function __invoke(Request $request, string $id): JsonResponse
    {
        // Rejeita IDs fora do intervalo de bigint antes de consultar o PostgreSQL.
        if (filter_var($id, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) === false) {
            return response()->json(['message' => 'Chamado não encontrado.'], 404);
        }

        $user = $request->user();
        $isStaff = in_array($user->role, ['technician', 'admin'], true);
        $ticket = Ticket::query()->visibleTo($user)->whereKey($id)
            ->with([
                'requester:id,name', 'assignee:id,name', 'category:id,name', 'status:id,code,name',
                'comments' => function (HasMany $query) use ($isStaff): void {
                    $query->select(['id', 'ticket_id', 'user_id', 'body', 'is_internal', 'created_at'])
                        ->with('user:id,name')->orderBy('created_at')->orderBy('id');
                    if (! $isStaff) {
                        $query->where('is_internal', false);
                    }
                },
                'activities' => function (HasMany $query) use ($isStaff): void {
                    $query->select(['id', 'ticket_id', 'actor_id', 'action', 'created_at', ...($isStaff ? ['changes'] : [])])
                        ->with('actor:id,name')->orderBy('created_at')->orderBy('id');
                    // Apenas o evento público atualmente conhecido é exposto ao solicitante.
                    // A ausência de classificação de audiência exige ocultar ações desconhecidas.
                    if (! $isStaff) {
                        $query->where('action', 'created')->whereNull('changes');
                    }
                },
            ])->first([
                'id', 'title', 'description', 'priority', 'requester_id', 'assigned_to', 'category_id', 'status_id',
                'created_at', 'updated_at', 'first_response_due_at', 'resolution_due_at',
                'first_responded_at', 'resolved_at', 'closed_at',
            ]);

        if ($ticket === null) {
            return response()->json(['message' => 'Chamado não encontrado.'], 404);
        }

        $activityDetails = $isStaff ? (new TicketActivityDetails)->forActivities($ticket->activities) : [];

        return response()->json([
            'id' => $ticket->id,
            'title' => $ticket->title,
            'description' => $ticket->description,
            'priority' => $ticket->priority,
            'requester' => $ticket->requester->only(['id', 'name']),
            'assignee' => $ticket->assignee?->only(['id', 'name']),
            'category' => $ticket->category->only(['id', 'name']),
            'status' => $ticket->status->only(['id', 'code', 'name']),
            'created_at' => $ticket->created_at->toISOString(),
            'updated_at' => $ticket->updated_at->toISOString(),
            'first_response_due_at' => $ticket->first_response_due_at->toISOString(),
            'resolution_due_at' => $ticket->resolution_due_at->toISOString(),
            'first_responded_at' => $ticket->first_responded_at?->toISOString(),
            'resolved_at' => $ticket->resolved_at?->toISOString(),
            'closed_at' => $ticket->closed_at?->toISOString(),
            'comments' => $ticket->comments->map(fn (TicketComment $comment): array => [
                'id' => $comment->id,
                'author' => $comment->user->only(['id', 'name']),
                'body' => $comment->body,
                ...($isStaff ? ['is_internal' => $comment->is_internal] : []),
                'created_at' => $comment->created_at->toISOString(),
            ])->all(),
            'activities' => $ticket->activities->map(fn (TicketActivity $activity): array => [
                'id' => $activity->id,
                'action' => $activity->action,
                'actor' => $activity->actor?->only(['id', 'name']),
                'created_at' => $activity->created_at->toISOString(),
                ...(isset($activityDetails[$activity->id]) ? ['details' => $activityDetails[$activity->id]] : []),
            ])->all(),
        ]);
    }
}
