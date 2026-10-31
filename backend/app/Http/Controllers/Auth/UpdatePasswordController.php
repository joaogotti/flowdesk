<?php

namespace App\Http\Controllers\Auth;

use App\Exceptions\SessionVersionMismatch;
use App\Http\Controllers\Controller;
use App\Http\Requests\UpdateUserPasswordRequest;
use App\Services\ChangeUserPassword;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;
use Throwable;

class UpdatePasswordController extends Controller
{
    public function __invoke(UpdateUserPasswordRequest $request, ChangeUserPassword $password): JsonResponse
    {
        try {
            $password->change($request, $request->validated());
        } catch (HttpResponseException|ValidationException|SessionVersionMismatch $exception) {
            throw $exception;
        } catch (Throwable) {
            // SQL exception bindings can contain the hash. Never report the original exception.
            Log::error('Falha ao alterar senha.', ['code' => 'password_change_unavailable']);

            return response()->json(['message' => 'Não foi possível alterar a senha no momento.', 'code' => 'password_change_unavailable'], 503);
        }

        // The service has committed. Never adopt the new version in this old session.
        Auth::guard('web')->logoutCurrentDevice();
        // The database session handler uses the default Sanctum guard's identity.
        // Clear its cached user too, so the new anonymous session has no user_id.
        Auth::guard('sanctum')->forgetUser();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->json([
            'message' => 'Senha alterada. Todas as sessões foram encerradas. Entre novamente.',
            'code' => 'password_changed',
            'reauthentication_required' => true,
        ])->header('Cache-Control', 'private, no-store');
    }
}
