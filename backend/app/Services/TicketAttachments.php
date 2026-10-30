<?php

namespace App\Services;

use App\Models\Ticket;
use App\Models\TicketActivity;
use App\Models\TicketAttachment;
use App\Support\TicketAttachmentAccess;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Throwable;

class TicketAttachments
{
    public function __construct(public AttachmentStorage $storage) {}

    public function reserve(Request $request, string $ticketId, array $file): TicketAttachment
    {
        return DB::transaction(function () use ($request, $ticketId, $file): TicketAttachment {
            $ticket = TicketAttachmentAccess::lock($request, $ticketId, true);
            // Parent lock serializes quota admission, including unexpired/expired pending rows.
            $quota = TicketAttachment::where('ticket_id', $ticket->id)->whereIn('state', ['pending', 'ready'])
                ->selectRaw('count(*) AS total, COALESCE(sum(size_bytes), 0) AS bytes')->first();
            if ((int) $quota->total >= 10 || (int) $quota->bytes + $file['size_bytes'] > 26214400) {
                TicketAttachmentAccess::conflict('attachment_limit_reached', 'Limite de 10 anexos ou 25 MiB por chamado atingido.');
            }
            $now = now();

            return TicketAttachment::create([
                ...array_diff_key($file, ['extension' => true]), 'ticket_id' => $ticket->id,
                'uploaded_by' => $request->user()->id, 'state' => 'pending',
                'storage_key' => 'tickets/'.$ticket->id.'/'.bin2hex(random_bytes(16)).'.'.$file['extension'],
                'created_at' => $now, 'expires_at' => $now->copy()->addDay(),
            ]);
        }, 3);
    }

    public function confirm(Request $request, TicketAttachment $reservation): TicketAttachment
    {
        return DB::transaction(function () use ($request, $reservation): TicketAttachment {
            $ticket = TicketAttachmentAccess::lock($request, $reservation->ticket_id, true);
            $record = TicketAttachment::whereKey($reservation->id)->lockForUpdate()->firstOrFail();
            $this->assertPending($record);
            $now = now();
            $record->state = 'ready';
            $record->confirmed_at = $now;
            $record->save();
            $activity = new TicketActivity(['ticket_id' => $ticket->id, 'actor_id' => $request->user()->id,
                'action' => 'attachment_added', 'changes' => ['attachment_id' => $record->id]]);
            $activity->created_at = $now;
            $activity->save();
            $ticket->updated_at = $now;
            $ticket->save();

            return $record->load('uploader:id,name');
        }, 3);
    }

    public function assertPending(TicketAttachment $record): void
    {
        if ($record->state !== 'pending' || $record->expires_at->lte(now())) {
            TicketAttachmentAccess::conflict('attachment_reservation_expired', 'A reserva expirou. Atualize a lista antes de tentar novamente.');
        }
    }

    // Called while holding the file lock. Never delete on an uncertain/failed DB commit.
    public function fail(TicketAttachment $reservation, bool $onlyExpired = false): bool
    {
        $record = DB::transaction(function () use ($reservation, $onlyExpired): ?TicketAttachment {
            Ticket::whereKey($reservation->ticket_id)->lockForUpdate()->first();
            $record = TicketAttachment::whereKey($reservation->id)->lockForUpdate()->first();
            if (! $record || $record->state === 'ready' || $record->cleaned_at !== null ||
                ($onlyExpired && $record->state === 'pending' && $record->expires_at->gt(now()))) {
                return null;
            }
            $record->state = 'failed';
            $record->save();

            return $record;
        }, 3);
        if ($record === null) {
            return false;
        }
        $this->storage->deleteFailed($record);
        TicketAttachment::whereKey($record->id)->where('state', 'failed')->update(['cleaned_at' => now()]);

        return true;
    }

    public function compensate(TicketAttachment $record): void
    {
        try {
            $this->fail($record);
        } catch (Throwable $exception) {
            // The persisted reservation allows later reconciliation. Preserve the original error.
            report($exception);
        }
    }

    public function reconcile(int $limit): array
    {
        $result = ['cleaned' => 0, 'skipped' => 0, 'errors' => 0];
        $records = TicketAttachment::where(fn ($query) => $query->where(fn ($q) => $q->where('state', 'pending')->where('expires_at', '<=', now()))
            ->orWhere(fn ($q) => $q->where('state', 'failed')->whereNull('cleaned_at')))->orderBy('id')->limit($limit)->get();
        foreach ($records as $record) {
            try {
                $cleaned = $this->storage->withLock($record, fn () => $this->fail($record, true), false);
                $result[$cleaned ? 'cleaned' : 'skipped']++;
            } catch (Throwable $exception) {
                report($exception);
                $result['errors']++;
            }
        }

        return $result;
    }
}
