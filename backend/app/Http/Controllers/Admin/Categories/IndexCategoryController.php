<?php

namespace App\Http\Controllers\Admin\Categories;

use App\Http\Controllers\Controller;
use App\Models\Category;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class IndexCategoryController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        if ($request->user()?->role !== 'admin') {
            return response()->json(['message' => 'Acesso não permitido.'], 403);
        }

        $categories = Category::query()
            ->select(['id', 'name', 'is_active'])
            ->withCount('tickets')
            ->orderBy('name')->orderBy('id')
            ->get()
            ->map(fn (Category $category): array => [
                'id' => (int) $category->id,
                'name' => $category->name,
                'is_active' => $category->is_active,
                'tickets_count' => (int) $category->tickets_count,
            ]);

        return response()->json(['data' => $categories]);
    }
}
