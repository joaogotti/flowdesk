<?php

namespace App\Http\Controllers\Reports;

use App\Http\Controllers\Controller;
use App\Http\Requests\ReportFiltersRequest;
use App\Services\ReportFilters;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;

class FiltersController extends Controller
{
    public function __invoke(ReportFiltersRequest $request, ReportFilters $filters): JsonResponse
    {
        $now = CarbonImmutable::now('UTC')->startOfSecond();
        $period = $request->period($now);
        try {
            $data = $filters->options();
        } catch (QueryException $exception) {
            report($exception);

            return response()->json(['message' => 'Relatórios temporariamente indisponíveis.', 'code' => 'report_unavailable'], 503);
        }
        $request->assertCurrentAdministrator();

        return response()->json(['data' => $data, 'meta' => [
            'as_of' => $now->toISOString(), 'timezone' => $request::TIMEZONE,
            'start_date' => $period['start_date'], 'end_date' => $period['end_date'],
            'options_scope' => 'administrative_catalog_across_all_periods',
        ]])->header('Cache-Control', 'private, no-store');
    }
}
