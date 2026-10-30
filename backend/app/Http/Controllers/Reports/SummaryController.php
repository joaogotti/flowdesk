<?php

namespace App\Http\Controllers\Reports;

use App\Http\Controllers\Controller;
use App\Http\Requests\ReportSummaryRequest;
use App\Services\ReportSummary;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;

class SummaryController extends Controller
{
    public function __invoke(ReportSummaryRequest $request, ReportSummary $summary): JsonResponse
    {
        $now = CarbonImmutable::now('UTC')->startOfSecond();
        $period = $request->period($now);
        try {
            $data = $summary->summarize($period['start_utc'], $period['end_exclusive_utc'], $now);
        } catch (QueryException $exception) {
            report($exception);

            return response()->json(['message' => 'Relatórios temporariamente indisponíveis.', 'code' => 'report_unavailable'], 503);
        }
        // Revalidate outside the historical read snapshot, immediately before delivery.
        $request->assertCurrentAdministrator();

        return response()->json(['data' => $data, 'meta' => [
            'as_of' => $now->toISOString(), 'timezone' => ReportSummaryRequest::TIMEZONE,
            'start_date' => $period['start_date'], 'end_date' => $period['end_date'],
            'start_utc' => $period['start_utc']->toISOString(), 'end_exclusive_utc' => $period['end_exclusive_utc']->toISOString(),
            'resolution_source' => 'distinct_tickets_with_recorded_status_changed_to_resolved_events',
        ]])->header('Cache-Control', 'private, no-store');
    }
}
