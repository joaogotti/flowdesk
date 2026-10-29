<?php

namespace App\Http\Controllers\Tickets;

use App\Http\Controllers\Controller;
use App\Http\Requests\UpdateTicketAssignmentRequest;
use App\Models\Ticket;
use App\Models\User;
use App\Support\SessionVersion;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class UpdateTicketAssignmentController extends Controller
{
    public function __invoke(UpdateTicketAssignmentRequest $request, string $id): JsonResponse
    {
        $ticket = DB::transaction(function () use ($request, $id): Ticket {
            // O Form Request já confirmou a visibilidade. Consultar pelo ID sob bloqueio
            // permite distinguir uma disputa posterior (409) de um acesso restrito (404).
            $ticket = Ticket::query()->whereKey($id)->lockForUpdate()->first();
            if ($ticket === null) {
                abort(response()->json(['message' => 'Chamado não encontrado.'], 404));
            }

            $user = User::query()->whereKey($request->user()->id)->sharedLock()->first();
            if ($user !== null) {
                SessionVersion::assertCurrent($request, $user);
            }
            if ($user === null || $user->disabled_at !== null || ! in_array($user->role, ['technician', 'admin'], true)) {
                abort(response()->json(['message' => 'Você não tem permissão para alterar responsáveis.'], 403));
            }

            $assignedTo = $request->validated('assigned_to');
            if ($user->role === 'technician') {
                if ($assignedTo !== $user->id) {
                    abort(response()->json(['message' => 'Técnicos podem assumir chamados somente para si mesmos.'], 403));
                }
                if ($ticket->assigned_to !== null && $ticket->assigned_to !== $user->id) {
                    abort(response()->json(['message' => 'O chamado já foi assumido por outro técnico.'], 409));
                }
            }

            if (! in_array($ticket->status->code, ['open', 'in_progress', 'waiting_requester'], true)) {
                abort(response()->json(['message' => 'Não é possível alterar a atribuição neste status.'], 409));
            }

            // O bloqueio compartilhado também impede que o destino seja desativado
            // entre esta revalidação e o commit da atribuição.
            $assignee = $assignedTo === null ? null : ($assignedTo === $user->id ? $user :
                User::query()->whereKey($assignedTo)->sharedLock()->first());
            if ($assignedTo !== null && ($assignee === null || $assignee->role !== 'technician' || $assignee->disabled_at !== null)) {
                throw ValidationException::withMessages(['assigned_to' => ['Selecione um técnico ativo válido.']]);
            }

            if ($ticket->assigned_to !== $assignedTo) {
                $previous = $ticket->assigned_to;
                $changedAt = now()->startOfSecond();
                $ticket->assigned_to = $assignedTo;
                $ticket->updated_at = $changedAt;
                $ticket->save();
                $ticket->activities()->create([
                    'actor_id' => $user->id,
                    'action' => 'assignment_changed',
                    'changes' => ['assigned_to' => ['from' => $previous, 'to' => $assignedTo]],
                ]);
            }

            return $ticket->setRelation('assignee', $assignee);
        });

        return response()->json([
            'id' => $ticket->id,
            'assignee' => $ticket->assignee?->only(['id', 'name']),
            'updated_at' => $ticket->updated_at->toISOString(),
        ]);
    }
}
