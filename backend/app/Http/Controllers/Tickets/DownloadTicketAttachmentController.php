<?php

namespace App\Http\Controllers\Tickets;

use App\Exceptions\SessionVersionMismatch;
use App\Http\Controllers\Controller;
use App\Models\TicketAttachment;
use App\Services\AttachmentStorage;
use App\Support\TicketAttachmentAccess;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Throwable;

class DownloadTicketAttachmentController extends Controller
{
    public function __invoke(Request $request, string $ticket, string $attachment, AttachmentStorage $storage): StreamedResponse
    {
        $authorize = function () use ($request, $ticket, $attachment): TicketAttachment {
            return DB::transaction(function () use ($request, $ticket, $attachment): TicketAttachment {
                TicketAttachmentAccess::lock($request, $ticket);
                if (filter_var($attachment, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) === false) {
                    abort(response()->json(['message' => 'Anexo não encontrado.'], 404));
                }

                return TicketAttachment::where('ticket_id', $ticket)->whereKey($attachment)->where('state', 'ready')->firstOr(function () {
                    abort(response()->json(['message' => 'Anexo não encontrado.'], 404));
                });
            });
        };
        $stream = null;
        try {
            $record = $authorize();
            // Verify the file without DB locks, then revalidate authorization before sending bytes.
            $stream = $storage->verifiedStream($record);
            $authorize();
        } catch (Throwable $exception) {
            if (is_resource($stream)) {
                fclose($stream);
            }
            if ($exception instanceof SessionVersionMismatch || $exception instanceof HttpExceptionInterface || $exception instanceof HttpResponseException) {
                throw $exception;
            }
            report($exception);
            abort(response()->json(['message' => 'Anexo temporariamente indisponível.', 'code' => 'attachment_unavailable'], 503));
        }

        return response()->streamDownload(function () use ($stream): void {
            try {
                fpassthru($stream);
            } finally {
                fclose($stream);
            }
        }, $record->original_name, ['Content-Type' => $record->mime_type, 'Content-Length' => (string) $record->size_bytes,
            'Cache-Control' => 'private, no-store, max-age=0', 'Pragma' => 'no-cache',
            'X-Content-Type-Options' => 'nosniff', 'Content-Security-Policy' => "default-src 'none'; sandbox"]);
    }
}
