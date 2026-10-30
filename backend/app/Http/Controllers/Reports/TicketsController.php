<?php

namespace App\Http\Controllers\Reports;

use App\Http\Controllers\Controller;
use App\Http\Requests\ReportTicketsRequest;
use App\Services\ReportTickets;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;

class TicketsController extends Controller
{
    public function __invoke(ReportTicketsRequest $request, ReportTickets $tickets): JsonResponse
    {
        $now = CarbonImmutable::now('UTC')->startOfSecond();
        $period = $request->period($now);
        $filters = $request->filters();
        try {
            $page = $tickets->paginate($period['start_utc'], $period['end_exclusive_utc'], $now, $filters,
                (int) $request->validated('page', 1), (int) $request->validated('per_page', 15));
        } catch (QueryException $exception) {
            report($exception);

            return response()->json(['message' => 'Relatórios temporariamente indisponíveis.', 'code' => 'report_unavailable'], 503);
        }
        $request->assertCurrentAdministrator();
        $page->appends([...$filters, 'start_date' => $period['start_date'], 'end_date' => $period['end_date'], 'per_page' => $page->perPage()]);

        return response()->json([...$page->toArray(), 'meta' => [
            'scope' => 'tickets_created_in_period', 'as_of' => $now->toISOString(), 'timezone' => $request::TIMEZONE,
            'start_date' => $period['start_date'], 'end_date' => $period['end_date'],
            'start_utc' => $period['start_utc']->toISOString(), 'end_exclusive_utc' => $period['end_exclusive_utc']->toISOString(),
            'filters' => (object) $filters, 'sla_basis' => 'currently_recorded_deadlines',
            'summary_filters_applied' => false,
        ]])->header('Cache-Control', 'private, no-store');
    }
}
