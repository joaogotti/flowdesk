<?php

namespace App\Http\Controllers\Tickets;

use App\Http\Controllers\Controller;
use App\Models\TicketAttachment;
use App\Support\TicketAttachmentAccess;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class IndexTicketAttachmentController extends Controller
{
    public function __invoke(Request $request, string $ticket): JsonResponse
    {
        try {
            $records = DB::transaction(function () use ($request, $ticket) {
                TicketAttachmentAccess::lock($request, $ticket);

                return TicketAttachment::where('ticket_id', $ticket)->where('state', 'ready')->with('uploader:id,name')
                    ->orderBy('created_at')->orderBy('id')->limit(10)->get();
            });
        } catch (QueryException $exception) {
            report($exception);

            return response()->json(['message' => 'Anexos temporariamente indisponíveis.', 'code' => 'attachment_unavailable'], 503);
        }

        return response()->json(['data' => $records->map(fn ($record) => $record->publicData())->all()])->header('Cache-Control', 'private, no-store');
    }
}
