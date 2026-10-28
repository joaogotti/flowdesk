<?php

namespace App\Http\Controllers\Tickets;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreTicketCommentRequest;
use App\Models\Ticket;
use App\Models\TicketActivity;
use App\Models\TicketComment;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

class StoreTicketCommentController extends Controller
{
    public function __invoke(StoreTicketCommentRequest $request, string $id): JsonResponse
    {
        $comment = DB::transaction(function () use ($request, $id): TicketComment {
            // Mesma ordem de atribuição/status/detalhes: chamado, depois usuário.
            $ticket = Ticket::query()->whereKey($id)->lockForUpdate()->first();

            if ($ticket === null) {
                abort(response()->json(['message' => 'Chamado não encontrado.'], 404));
            }

            // Mantém perfil/situação estáveis até o commit, sem reutilizar a identidade em cache.
            $user = User::query()->whereKey($request->user()->id)->sharedLock()->first();
            if ($user === null || $user->disabled_at !== null || ! in_array($user->role, ['requester', 'technician', 'admin'], true)) {
                abort(response()->json(['message' => 'Acesso não permitido.'], 403));
            }
            if (! Ticket::query()->visibleTo($user)->whereKey($ticket->id)->exists()) {
                abort(response()->json(['message' => 'Chamado não encontrado.'], 404));
            }

            $data = $request->validated();
            $isInternal = $data['is_internal'] ?? false;
            if ($isInternal && $user->role === 'requester') {
                abort(response()->json(['message' => 'Somente técnicos e administradores podem criar comentários internos.'], 403));
            }

            if (! in_array($ticket->status->code, ['open', 'in_progress', 'waiting_requester'], true)) {
                abort(response()->json(['message' => 'Não é possível adicionar comentários a chamados neste status.'], 409));
            }

            $createdAt = now()->startOfSecond();
            $comment = new TicketComment([
                'user_id' => $user->id,
                'body' => $data['body'],
                'is_internal' => $isInternal,
            ]);
            $comment->created_at = $createdAt;
            $comment->updated_at = $createdAt;
            $ticket->comments()->save($comment);

            $activity = new TicketActivity([
                'actor_id' => $user->id,
                'action' => 'comment_added',
                // Metadados mínimos; nunca duplicamos o conteúdo do comentário no histórico.
                'changes' => ['comment_id' => $comment->id, 'is_internal' => $isInternal],
            ]);
            $activity->created_at = $createdAt;
            $ticket->activities()->save($activity);

            if (! $isInternal && in_array($user->role, ['technician', 'admin'], true) && $ticket->first_responded_at === null) {
                $ticket->first_responded_at = $createdAt;
                $ticket->updated_at = $createdAt;
                $ticket->save();
            }
            // Comentários internos não tocam no chamado, inclusive em updated_at.

            return $comment->load('user:id,name');
        });

        return response()->json([
            'id' => $comment->id,
            'body' => $comment->body,
            'is_internal' => $comment->is_internal,
            'author' => $comment->user->only(['id', 'name']),
            'created_at' => $comment->created_at->toISOString(),
        ], 201);
    }
}
