<?php

namespace App\Support;

use App\Models\Ticket;
use App\Models\User;
use Illuminate\Http\Request;

class TicketAttachmentAccess
{
    // Must be called inside a transaction. Preserve the existing ticket -> user order.
    public static function lock(Request $request, string|int $id, bool $write = false): Ticket
    {
        if (filter_var($id, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) === false) {
            abort(response()->json(['message' => 'Chamado não encontrado.'], 404));
        }
        $query = Ticket::query()->whereKey($id);
        $ticket = ($write ? $query->lockForUpdate() : $query->sharedLock())->first();
        if ($ticket === null) {
            abort(response()->json(['message' => 'Chamado não encontrado.'], 404));
        }
        $user = User::query()->whereKey($request->user()->id)->sharedLock()->first();
        SessionVersion::assertCurrent($request, $user);
        if ($user->disabled_at !== null || ! in_array($user->role, ['requester', 'technician', 'admin'], true)) {
            abort(response()->json(['message' => 'Acesso não permitido.'], 403));
        }
        if (! Ticket::query()->visibleTo($user)->whereKey($id)->exists()) {
            abort(response()->json(['message' => 'Chamado não encontrado.'], 404));
        }
        if ($write && ! in_array($ticket->status->code, ['open', 'in_progress', 'waiting_requester'], true)) {
            self::conflict('ticket_not_writable', 'Não é possível enviar anexos neste status.');
        }

        return $ticket;
    }

    public static function conflict(string $code, string $message): never
    {
        abort(response()->json(['message' => $message, 'code' => $code], 409));
    }
}
