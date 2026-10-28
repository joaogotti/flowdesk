<?php

namespace App\Http\Controllers\Dashboard;

use App\Http\Controllers\Controller;
use App\Models\Ticket;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class SlaController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        abort_unless(
            in_array($request->user()?->role, ['requester', 'technician', 'admin'], true),
            403,
            'Acesso não permitido.',
        );

        // Um único instante de referência, com a precisão de segundos usada na gravação dos SLAs.
        $now = now()->utc()->startOfSecond();
        $pending = Ticket::query()->visibleTo($request->user())
            ->join('ticket_statuses', 'tickets.status_id', '=', 'ticket_statuses.id')
            ->join('sla_policies', 'tickets.sla_policy_id', '=', 'sla_policies.id')
            ->whereIn('ticket_statuses.code', ['open', 'in_progress', 'waiting_requester'])
            ->whereNull('tickets.resolved_at')
            ->whereNull('tickets.closed_at')
            // Datas incoerentes ficam indisponíveis, como na apresentação atual dos prazos.
            ->where('tickets.created_at', '<=', $now)
            ->whereColumn('tickets.first_response_due_at', '>=', 'tickets.created_at')
            ->whereColumn('tickets.resolution_due_at', '>=', 'tickets.created_at')
            ->where(function (Builder $query) use ($now): void {
                $query->whereNull('tickets.first_responded_at')
                    ->orWhere(function (Builder $query) use ($now): void {
                        $query->whereColumn('tickets.first_responded_at', '>=', 'tickets.created_at')
                            ->where('tickets.first_responded_at', '<=', $now);
                    });
            });

        // Segundos inteiros em SQLite e intervalo exato em PostgreSQL, sem erro de ponto flutuante em datas.
        $secondsUntil = fn (string $column): string => $pending->getConnection()->getDriverName() === 'pgsql'
            ? "EXTRACT(EPOCH FROM ({$column} - CAST(? AS timestamp with time zone)))"
            : "(unixepoch({$column}) - unixepoch(?))";
        $pending->select(['sla_policies.first_response_minutes', 'sla_policies.resolution_minutes'])
            ->selectRaw('CASE WHEN tickets.first_responded_at IS NULL THEN '.$secondsUntil('tickets.first_response_due_at').' ELSE NULL END AS first_remaining', [$now])
            ->selectRaw($secondsUntil('tickets.resolution_due_at').' AS resolution_remaining', [$now]);

        // Uma única classificação por chamado; prazo cumprido é NULL e não participa das comparações.
        $classified = DB::query()->fromSub($pending->toBase(), 'pending_sla')->selectRaw("CASE
            WHEN resolution_remaining < 0 OR first_remaining < 0 THEN 'overdue'
            WHEN resolution_remaining <= resolution_minutes * 60 * 0.20
                OR first_remaining <= first_response_minutes * 60 * 0.20 THEN 'at_risk'
            ELSE 'on_track'
        END AS classification");
        $aggregate = DB::query()->fromSub($classified, 'classified_sla');
        foreach (['on_track', 'at_risk', 'overdue'] as $classification) {
            $aggregate->selectRaw("COUNT(CASE WHEN classification = ? THEN 1 END) AS {$classification}", [$classification]);
        }
        $counts = $aggregate->first();

        return response()->json(['data' => [
            'on_track' => (int) $counts->on_track,
            'at_risk' => (int) $counts->at_risk,
            'overdue' => (int) $counts->overdue,
        ]]);
    }
}
