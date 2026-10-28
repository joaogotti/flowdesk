<?php

namespace App\Http\Controllers\Tickets;

use App\Http\Controllers\Controller;
use App\Http\Requests\UpdateTicketStatusRequest;
use App\Models\Ticket;
use App\Models\TicketActivity;
use App\Models\TicketStatus;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class UpdateTicketStatusController extends Controller
{
    private const TRANSITIONS = [
        'open' => ['in_progress', 'cancelled'],
        'in_progress' => ['waiting_requester', 'resolved', 'cancelled'],
        'waiting_requester' => ['in_progress', 'cancelled'],
        'resolved' => ['in_progress', 'closed'],
        'closed' => [],
        'cancelled' => [],
    ];

    public function __invoke(UpdateTicketStatusRequest $request, string $id): JsonResponse
    {
        $ticket = DB::transaction(function () use ($request, $id): Ticket {
            if (! in_array($request->user()->role, ['technician', 'admin'], true)) {
                abort(response()->json(['message' => 'Você não tem permissão para alterar o status.'], 403));
            }
            $ticket = Ticket::query()->visibleTo($request->user())->whereKey($id)->lockForUpdate()->first();
            if ($ticket === null) {
                abort(response()->json(['message' => 'Chamado não encontrado.'], 404));
            }

            $user = User::query()->whereKey($request->user()->id)->sharedLock()->first();
            if ($user === null || $user->disabled_at !== null || ! in_array($user->role, ['technician', 'admin'], true)) {
                abort(response()->json(['message' => 'Você não tem permissão para alterar o status.'], 403));
            }
            if ($user->role === 'technician' && $ticket->assigned_to !== $user->id) {
                if ($ticket->assigned_to !== null) {
                    abort(response()->json(['message' => 'Chamado não encontrado.'], 404));
                }
                abort(response()->json(['message' => 'Somente o técnico responsável pode alterar o status deste chamado.'], 403));
            }

            $previous = $ticket->status->code;
            $next = $request->validated('status');
            // Inclusive em estados finais: repetir o código atual não regrava datas.
            if ($next === $previous) {
                return $ticket;
            }
            if (! in_array($next, self::TRANSITIONS[$previous] ?? [], true)) {
                abort(response()->json(['message' => 'Esta transição de status não é permitida.'], 409));
            }

            $status = TicketStatus::query()->where('code', $next)->sharedLock()->first();
            if ($status === null) {
                throw ValidationException::withMessages(['status' => ['O status informado não está disponível.']]);
            }
            $changedAt = now()->startOfSecond();
            $ticket->status_id = $status->id;
            $ticket->updated_at = $changedAt;
            if ($next === 'resolved') {
                $ticket->resolved_at = $changedAt;
            } elseif ($previous === 'resolved' && $next === 'in_progress') {
                $ticket->resolved_at = null;
            }
            if ($next === 'closed') {
                $ticket->closed_at = $changedAt;
            }
            $ticket->save();

            $activity = new TicketActivity([
                'actor_id' => $user->id, 'action' => 'status_changed',
                'changes' => ['status' => ['from' => $previous, 'to' => $next]],
            ]);
            $activity->created_at = $changedAt;
            $ticket->activities()->save($activity);

            return $ticket->setRelation('status', $status);
        });

        return response()->json([
            'id' => $ticket->id,
            'status' => $ticket->status->only(['id', 'code', 'name']),
            'resolved_at' => $ticket->resolved_at?->toISOString(),
            'closed_at' => $ticket->closed_at?->toISOString(),
            'updated_at' => $ticket->updated_at->toISOString(),
        ]);
    }
}
