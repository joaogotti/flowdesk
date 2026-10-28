<?php

namespace App\Http\Controllers\Dashboard;

use App\Http\Controllers\Controller;
use App\Models\Category;
use App\Models\Ticket;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class CategoriesController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        abort_unless(
            in_array($request->user()?->role, ['requester', 'technician', 'admin'], true),
            403,
            'Acesso não permitido.',
        );

        $visibleCounts = Ticket::query()->visibleTo($request->user())
            ->select('category_id')->selectRaw('COUNT(*) AS ticket_count')
            ->groupBy('category_id');

        $categories = Category::query()
            ->leftJoinSub($visibleCounts, 'visible_counts', 'categories.id', '=', 'visible_counts.category_id')
            ->select(['categories.id', 'categories.name'])
            ->selectRaw('COALESCE(visible_counts.ticket_count, 0) AS count')
            ->orderByDesc('count')->orderBy('categories.name')->orderBy('categories.id')
            ->toBase()->get()
            ->map(fn (object $category): array => [
                'id' => (int) $category->id,
                'name' => $category->name,
                'count' => (int) $category->count,
            ]);

        return response()->json(['data' => $categories]);
    }
}
