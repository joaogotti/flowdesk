<?php

namespace App\Http\Controllers\Tickets;

use App\Http\Controllers\Controller;
use App\Http\Requests\IndexTicketRequest;
use App\Models\Ticket;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;

class IndexTicketController extends Controller
{
    public function __invoke(IndexTicketRequest $request): JsonResponse
    {
        $filters = $request->validated();
        $query = Ticket::query()->visibleTo($request->user());

        if (isset($filters['status'])) {
            $query->whereHas('status', fn (Builder $query) => $query->where('code', $filters['status']));
        }
        foreach (['priority', 'category_id', 'assigned_to'] as $field) {
            if (isset($filters[$field])) {
                $query->where($field, $filters[$field]);
            }
        }
        if (isset($filters['search'])) {
            $pattern = '%'.str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $filters['search']).'%';
            $query->where(function (Builder $query) use ($pattern): void {
                // O padrão é vinculado como parâmetro; curingas digitados são tratados literalmente.
                $query->whereRaw("LOWER(title) LIKE LOWER(?) ESCAPE '!'", [$pattern])
                    ->orWhereRaw("LOWER(description) LIKE LOWER(?) ESCAPE '!'", [$pattern]);
            });
        }

        $tickets = $query->with(['status:id,code,name', 'category:id,name', 'requester:id,name', 'assignee:id,name'])
            ->orderByDesc('created_at')->orderByDesc('id')
            ->paginate($filters['per_page'] ?? 15, [
                'id', 'title', 'priority', 'status_id', 'category_id', 'requester_id', 'assigned_to',
                'created_at', 'first_response_due_at', 'resolution_due_at',
            ], 'page', $filters['page'] ?? 1)
            ->appends($filters)
            ->through(fn (Ticket $ticket): array => [
                'id' => $ticket->id,
                'title' => $ticket->title,
                'priority' => $ticket->priority,
                'status' => $ticket->status->only(['id', 'code', 'name']),
                'category' => $ticket->category->only(['id', 'name']),
                'requester' => $ticket->requester->only(['id', 'name']),
                'assignee' => $ticket->assignee?->only(['id', 'name']),
                'created_at' => $ticket->created_at->toISOString(),
                'first_response_due_at' => $ticket->first_response_due_at->toISOString(),
                'resolution_due_at' => $ticket->resolution_due_at->toISOString(),
            ]);

        return response()->json($tickets);
    }
}
