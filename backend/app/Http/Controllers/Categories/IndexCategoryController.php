<?php

namespace App\Http\Controllers\Categories;

use App\Http\Controllers\Controller;
use App\Models\Category;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class IndexCategoryController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        abort_unless(
            in_array($request->user()?->role, ['requester', 'technician', 'admin'], true),
            403,
            'Acesso não permitido.',
        );

        $categories = Category::query()
            ->where('is_active', true)
            ->orderBy('name')
            ->orderBy('id')
            ->get(['id', 'name'])
            ->map(fn (Category $category): array => $category->only(['id', 'name']));

        return response()->json(['data' => $categories]);
    }
}
