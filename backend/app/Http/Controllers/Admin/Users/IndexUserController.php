<?php

namespace App\Http\Controllers\Admin\Users;

use App\Http\Controllers\Controller;
use App\Http\Requests\IndexAdminUserRequest;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;

class IndexUserController extends Controller
{
    public function __invoke(IndexAdminUserRequest $request): JsonResponse
    {
        $filters = $request->validated();
        $query = User::query();

        if (isset($filters['role'])) {
            $query->where('role', $filters['role']);
        }
        if (isset($filters['status'])) {
            if ($filters['status'] === 'active') {
                $query->whereNull('disabled_at');
            } else {
                $query->whereNotNull('disabled_at');
            }
        }
        if (isset($filters['search'])) {
            $pattern = '%'.str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $filters['search']).'%';
            $query->where(function (Builder $query) use ($pattern): void {
                $query->whereRaw("LOWER(name) LIKE LOWER(?) ESCAPE '!'", [$pattern])
                    ->orWhereRaw("LOWER(email) LIKE LOWER(?) ESCAPE '!'", [$pattern]);
            });
        }

        $users = $query->orderBy('name')->orderBy('id')
            ->paginate($filters['per_page'] ?? 15, ['id', 'name', 'email', 'role', 'disabled_at', 'created_at'], 'page', $filters['page'] ?? 1)
            ->appends($filters)
            ->through(fn (User $user): array => [
                'id' => (int) $user->id,
                'name' => $user->name,
                'email' => $user->email,
                'role' => $user->role,
                'disabled_at' => $user->disabled_at?->toISOString(),
                'created_at' => $user->created_at?->toISOString(),
            ]);

        return response()->json($users);
    }
}
