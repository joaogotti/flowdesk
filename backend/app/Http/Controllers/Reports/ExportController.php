<?php

namespace App\Http\Controllers\Reports;

use App\Http\Controllers\Controller;
use App\Http\Requests\ReportExportRequest;
use App\Services\ReportTicketExport;
use Carbon\CarbonImmutable;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Throwable;

class ExportController extends Controller
{
    public function __invoke(ReportExportRequest $request, ReportTicketExport $export): StreamedResponse|JsonResponse
    {
        $now = CarbonImmutable::now('UTC')->startOfSecond();
        $period = $request->period($now);
        try {
            $stream = $export->generate($period['start_utc'], $period['end_exclusive_utc'], $now, $request->filters());
        } catch (HttpResponseException $exception) {
            throw $exception;
        } catch (Throwable $exception) {
            report($exception);

            return response()->json(['message' => 'Relatórios temporariamente indisponíveis.', 'code' => 'report_unavailable'], 503);
        }
        try {
            // Outside the export snapshot: observe role/status/version changes during generation.
            $request->assertCurrentAdministrator();
        } catch (Throwable $exception) {
            fclose($stream);
            throw $exception;
        }

        return response()->streamDownload(function () use ($stream): void {
            try {
                fpassthru($stream);
            } finally {
                fclose($stream);
            }
        }, 'flowdesk-chamados-'.$now->format('Ymd_His').'Z.csv', [
            'Content-Type' => 'text/csv; charset=UTF-8', 'Content-Length' => (string) fstat($stream)['size'],
            'Cache-Control' => 'private, no-store, max-age=0, must-revalidate', 'Pragma' => 'no-cache', 'Expires' => '0',
            'X-Content-Type-Options' => 'nosniff', 'Content-Security-Policy' => "default-src 'none'; sandbox",
        ]);
    }
}
