<?php

namespace App\Http\Controllers\Admin\Categories;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreCategoryRequest;
use App\Models\Category;
use App\Models\User;
use App\Support\CategoryNameConflict;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

class StoreCategoryController extends Controller
{
    public function __invoke(StoreCategoryRequest $request): JsonResponse
    {
        try {
            $category = DB::transaction(function () use ($request): Category {
                $user = User::query()->whereKey($request->user()->id)->sharedLock()->first();
                if ($user === null || $user->disabled_at !== null || $user->role !== 'admin') {
                    abort(response()->json(['message' => 'Acesso não permitido.'], 403));
                }

                // O índice normalizado é a autoridade de unicidade, inclusive sob concorrência.
                return Category::create(['name' => $request->validated('name')])->refresh();
            });
        } catch (QueryException $exception) {
            CategoryNameConflict::throwIfDuplicate($exception);

            report($exception);

            return response()->json(['message' => 'Não foi possível criar a categoria no momento.'], 503);
        }

        return response()->json(['data' => [
            'id' => (int) $category->id,
            'name' => $category->name,
            'is_active' => $category->is_active,
            'tickets_count' => 0,
        ]], 201);
    }
}
