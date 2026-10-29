<?php

namespace App\Http\Controllers\Admin\Categories;

use App\Http\Controllers\Controller;
use App\Http\Requests\UpdateCategoryRequest;
use App\Models\Category;
use App\Models\User;
use App\Support\CategoryNameConflict;
use App\Support\SessionVersion;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

class UpdateCategoryController extends Controller
{
    public function __invoke(UpdateCategoryRequest $request, string $category): JsonResponse
    {
        if (filter_var($category, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) === false) {
            return response()->json(['message' => 'Categoria não encontrada.'], 404);
        }

        try {
            $updated = DB::transaction(function () use ($request, $category): Category {
                $user = User::query()->whereKey($request->user()->id)->sharedLock()->first();
                if ($user !== null) {
                    SessionVersion::assertCurrent($request, $user);
                }
                if ($user === null || $user->disabled_at !== null || $user->role !== 'admin') {
                    abort(response()->json(['message' => 'Acesso não permitido.'], 403));
                }

                $record = Category::query()->whereKey($category)->lockForUpdate()->first();
                if ($record === null) {
                    abort(response()->json(['message' => 'Categoria não encontrada.'], 404));
                }
                $record->name = $request->validated('name');
                if ($record->isDirty('name')) {
                    $record->save();
                }

                return $record->loadCount('tickets');
            });
        } catch (QueryException $exception) {
            CategoryNameConflict::throwIfDuplicate($exception);
            report($exception);

            return response()->json(['message' => 'Não foi possível alterar a categoria no momento.'], 503);
        }

        return response()->json(['data' => [
            'id' => (int) $updated->id,
            'name' => $updated->name,
            'is_active' => $updated->is_active,
            'tickets_count' => (int) $updated->tickets_count,
        ]]);
    }
}
