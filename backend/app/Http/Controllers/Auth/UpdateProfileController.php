<?php

namespace App\Http\Controllers\Auth;

use App\Http\Controllers\Controller;
use App\Http\Requests\UpdateUserProfileRequest;
use App\Models\User;
use App\Support\SessionVersion;
use App\Support\UserProfilePreconditions;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

class UpdateProfileController extends Controller
{
    public function __invoke(UpdateUserProfileRequest $request): JsonResponse
    {
        try {
            $updated = DB::transaction(function () use ($request): User {
                $user = User::query()->whereKey($request->user()->id)->lockForUpdate()->first();
                SessionVersion::assertCurrent($request, $user);
                if ($user->disabled_at !== null) {
                    abort(response()->json(['message' => 'Acesso não permitido.'], 403));
                }
                UserProfilePreconditions::assertMatches($user, $request->validated());
                $user->name = $request->validated('name');
                if ($user->isDirty('name')) {
                    $user->save();
                }

                return $user;
            });
        } catch (QueryException $exception) {
            report($exception);

            return response()->json(['message' => 'Não foi possível alterar o nome no momento.'], 503);
        }

        return response()->json(['data' => $updated->only(['id', 'name', 'email', 'role'])])
            ->header('Cache-Control', 'private, no-store');
    }
}
