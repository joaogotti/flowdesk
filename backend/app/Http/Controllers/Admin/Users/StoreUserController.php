<?php

namespace App\Http\Controllers\Admin\Users;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreAdminUserRequest;
use App\Models\User;
use App\Support\UserEmailConflict;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

class StoreUserController extends Controller
{
    public function __invoke(StoreAdminUserRequest $request): JsonResponse
    {
        // Hash explícito impede que uma senha com formato de hash seja armazenada literalmente.
        // O cast hashed de User reconhece o resultado e não aplica um segundo hash.
        $password = Hash::make($request->validated('password'));

        try {
            $user = DB::transaction(function () use ($request, $password): User {
                $actor = User::query()->whereKey($request->user()->id)->sharedLock()->first();
                if ($actor === null || $actor->disabled_at !== null || $actor->role !== 'admin') {
                    abort(response()->json(['message' => 'Acesso não permitido.'], 403));
                }

                return User::create([
                    'name' => $request->validated('name'),
                    'email' => $request->validated('email'),
                    'password' => $password,
                    'role' => $request->validated('role'),
                    'disabled_at' => null,
                ])->refresh();
            });
        } catch (QueryException $exception) {
            UserEmailConflict::throwIfDuplicate($exception);
            report($exception);

            return response()->json(['message' => 'Não foi possível cadastrar o usuário no momento.'], 503);
        }

        return response()->json(['data' => [
            'id' => (int) $user->id,
            'name' => $user->name,
            'email' => $user->email,
            'role' => $user->role,
            'disabled_at' => $user->disabled_at?->toISOString(),
            'created_at' => $user->created_at?->toISOString(),
        ]], 201);
    }
}
