<?php

namespace App\Http\Controllers\Tickets;

use App\Http\Controllers\Controller;
use App\Http\Requests\UpdateTicketDetailsRequest;
use App\Models\Category;
use App\Models\SlaPolicy;
use App\Models\Ticket;
use App\Models\TicketActivity;
use App\Models\User;
use App\Support\SessionVersion;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class UpdateTicketDetailsController extends Controller
{
    public function __invoke(UpdateTicketDetailsRequest $request, string $id): JsonResponse
    {
        $ticket = DB::transaction(function () use ($request, $id): Ticket {
            $ticket = Ticket::query()->whereKey($id)->lockForUpdate()->first();
            if ($ticket === null) {
                abort(response()->json(['message' => 'Chamado não encontrado.'], 404));
            }

            $user = User::query()->whereKey($request->user()->id)->sharedLock()->first();
            if ($user !== null) {
                SessionVersion::assertCurrent($request, $user);
            }
            if ($user === null || $user->disabled_at !== null || ! in_array($user->role, ['technician', 'admin'], true)) {
                abort(response()->json(['message' => 'Você não tem permissão para alterar os detalhes.'], 403));
            }
            if ($user->role === 'technician' && $ticket->assigned_to !== $user->id) {
                if ($ticket->assigned_to !== null) {
                    abort(response()->json(['message' => 'Chamado não encontrado.'], 404));
                }
                abort(response()->json(['message' => 'Somente o técnico responsável pode alterar os detalhes deste chamado.'], 403));
            }
            if (! in_array($ticket->status->code, ['open', 'in_progress', 'waiting_requester'], true)) {
                abort(response()->json(['message' => 'Não é possível alterar os detalhes neste status.'], 409));
            }

            $data = $request->validated();
            $changes = [];
            if (array_key_exists('category_id', $data)) {
                // A categoria pode ter sido desativada após a validação inicial.
                $category = Category::query()->whereKey($data['category_id'])->sharedLock()->first();
                if ($category === null || ! $category->is_active) {
                    throw ValidationException::withMessages(['category_id' => ['Selecione uma categoria disponível.']]);
                }
                if ($ticket->category_id !== $category->id) {
                    $changes['category_id'] = ['from' => $ticket->category_id, 'to' => $category->id];
                    $ticket->category_id = $category->id;
                }
                $ticket->setRelation('category', $category);
            }
            if (array_key_exists('priority', $data) && $ticket->priority !== $data['priority']) {
                $policy = SlaPolicy::query()->where('priority', $data['priority'])->sharedLock()->first();
                if ($policy === null) {
                    throw ValidationException::withMessages(['priority' => ['A política de SLA desta prioridade não está disponível.']]);
                }
                $changes['priority'] = ['from' => $ticket->priority, 'to' => $data['priority']];
                $ticket->priority = $data['priority'];
                $ticket->sla_policy_id = $policy->id;
                // Mesma regra da criação, ancorada na abertura original do chamado.
                $ticket->first_response_due_at = $ticket->created_at->copy()->addMinutes($policy->first_response_minutes);
                $ticket->resolution_due_at = $ticket->created_at->copy()->addMinutes($policy->resolution_minutes);
            }

            if ($changes !== []) {
                $changedAt = now()->startOfSecond();
                $ticket->updated_at = $changedAt;
                $ticket->save();
                $activity = new TicketActivity([
                    'actor_id' => $user->id, 'action' => 'details_changed', 'changes' => $changes,
                ]);
                $activity->created_at = $changedAt;
                $ticket->activities()->save($activity);
            }

            return $ticket->loadMissing('category:id,name');
        });

        return response()->json([
            'id' => $ticket->id,
            'category' => $ticket->category->only(['id', 'name']),
            'priority' => $ticket->priority,
            'updated_at' => $ticket->updated_at->toISOString(),
        ]);
    }
}
