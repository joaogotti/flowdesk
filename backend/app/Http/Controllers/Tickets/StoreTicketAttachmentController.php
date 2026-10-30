<?php

namespace App\Http\Controllers\Tickets;

use App\Exceptions\SessionVersionMismatch;
use App\Http\Controllers\Controller;
use App\Http\Requests\StoreTicketAttachmentRequest;
use App\Services\TicketAttachments;
use App\Support\AttachmentFile;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Throwable;

class StoreTicketAttachmentController extends Controller
{
    public function __invoke(StoreTicketAttachmentRequest $request, string $ticket, TicketAttachments $service): JsonResponse
    {
        $metadata = AttachmentFile::inspect($request->file('file'));
        try {
            $record = $service->reserve($request, $ticket, $metadata);
            $ready = $service->storage->withLock($record, function () use ($record, $request, $service) {
                try {
                    $service->assertPending($record->fresh());
                    $service->storage->write($record, $request->file('file'));

                    return $service->confirm($request, $record);
                } catch (Throwable $exception) {
                    $service->compensate($record);
                    throw $exception;
                }
            });
        } catch (SessionVersionMismatch|HttpResponseException|HttpExceptionInterface $exception) {
            throw $exception;
        } catch (Throwable $exception) {
            report($exception);

            return response()->json(['message' => 'Não foi possível confirmar o anexo. Atualize a lista antes de tentar novamente.', 'code' => 'attachment_unavailable'], 503);
        }

        return response()->json(['data' => $ready->publicData()], 201);
    }
}
