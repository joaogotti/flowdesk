<?php

namespace App\Http\Controllers\Admin\Users;

use App\Http\Controllers\Controller;
use App\Http\Requests\UpdateAdminUserRequest;
use App\Models\User;
use App\Support\SessionVersion;
use App\Support\UserEmailConflict;
use App\Support\UserProfilePreconditions;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

class UpdateUserController extends Controller
{
    public function __invoke(UpdateAdminUserRequest $request, string $user): JsonResponse
    {
        try {
            $updated = DB::transaction(function () use ($request, $user): User {
                // Ordem única também para autoedição e administradores editando uns aos outros.
                $records = User::query()->whereIn('id', [$request->user()->id, (int) $user])
                    ->orderBy('id')->lockForUpdate()->get()->keyBy('id');
                $actor = $records->get($request->user()->id);
                if ($actor !== null) {
                    SessionVersion::assertCurrent($request, $actor);
                }
                if ($actor === null || $actor->disabled_at !== null || $actor->role !== 'admin') {
                    abort(response()->json(['message' => 'Acesso não permitido.'], 403));
                }
                $record = $records->get((int) $user);
                if ($record === null) {
                    abort(response()->json(['message' => 'Usuário não encontrado.'], 404));
                }

                UserProfilePreconditions::assertMatches($record, $request->validated());
                $record->fill($request->safe()->only(['name', 'email']));
                if ($record->isDirty(['name', 'email'])) {
                    $record->save();
                }

                return $record;
            });
        } catch (QueryException $exception) {
            UserEmailConflict::throwIfDuplicate($exception);
            report($exception);

            return response()->json(['message' => 'Não foi possível alterar o usuário no momento.'], 503);
        }

        return response()->json(['data' => [
            'id' => (int) $updated->id,
            'name' => $updated->name,
            'email' => $updated->email,
            'role' => $updated->role,
            'disabled_at' => $updated->disabled_at?->toISOString(),
            'created_at' => $updated->created_at?->toISOString(),
        ]]);
    }
}
