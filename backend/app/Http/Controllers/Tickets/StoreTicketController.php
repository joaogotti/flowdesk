<?php

namespace App\Http\Controllers\Tickets;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreTicketRequest;
use App\Models\Category;
use App\Models\SlaPolicy;
use App\Models\Ticket;
use App\Models\TicketActivity;
use App\Models\TicketStatus;
use App\Models\User;
use App\Support\SessionVersion;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class StoreTicketController extends Controller
{
    public function __invoke(StoreTicketRequest $request): JsonResponse
    {
        $ticket = DB::transaction(function () use ($request): Ticket {
            $data = $request->validated();
            $user = User::query()->whereKey($request->user()->id)->sharedLock()->first();
            if ($user !== null) {
                SessionVersion::assertCurrent($request, $user);
            }
            if ($user === null || $user->disabled_at !== null || ! in_array($user->role, ['requester', 'technician', 'admin'], true)) {
                abort(response()->json(['message' => 'Acesso não permitido.'], 403));
            }
            $category = Category::query()->whereKey($data['category_id'])->sharedLock()->first();
            if ($category === null || ! $category->is_active) {
                throw ValidationException::withMessages(['category_id' => ['Selecione uma categoria disponível.']]);
            }
            $status = TicketStatus::where('code', 'open')->sharedLock()->first();
            $policy = SlaPolicy::where('priority', $data['priority'])->sharedLock()->first();

            if ($status === null || $policy === null) {
                abort(response()->json(['message' => 'Não foi possível criar o chamado no momento.'], 503));
            }

            $createdAt = now()->startOfSecond();
            $ticket = new Ticket([
                'title' => $data['title'],
                'description' => $data['description'],
                'category_id' => $data['category_id'],
                'priority' => $data['priority'],
                'requester_id' => $user->id,
                'status_id' => $status->id,
                'sla_policy_id' => $policy->id,
                'assigned_to' => null,
                'first_responded_at' => null,
                'resolved_at' => null,
                'closed_at' => null,
                'first_response_due_at' => $createdAt->copy()->addMinutes($policy->first_response_minutes),
                'resolution_due_at' => $createdAt->copy()->addMinutes($policy->resolution_minutes),
            ]);
            $ticket->created_at = $createdAt;
            $ticket->updated_at = $createdAt;
            $ticket->save();

            $activity = new TicketActivity([
                'actor_id' => $user->id,
                'action' => 'ticket_created',
                'changes' => null,
            ]);
            $activity->created_at = $createdAt;
            $ticket->activities()->save($activity);

            return $ticket->setRelation('requester', $user)->setRelation('category', $category)->setRelation('status', $status);
        });

        return response()->json([
            'id' => $ticket->id,
            'title' => $ticket->title,
            'description' => $ticket->description,
            'priority' => $ticket->priority,
            'requester' => $ticket->requester->only(['id', 'name']),
            'category' => $ticket->category->only(['id', 'name']),
            'status' => $ticket->status->only(['id', 'code', 'name']),
            'created_at' => $ticket->created_at->toISOString(),
            'first_response_due_at' => $ticket->first_response_due_at->toISOString(),
            'resolution_due_at' => $ticket->resolution_due_at->toISOString(),
        ], 201);
    }
}
