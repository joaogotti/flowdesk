<?php

namespace App\Exceptions;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use RuntimeException;

class SessionVersionMismatch extends RuntimeException
{
    public function report(): bool
    {
        // Laravel stops default reporting when this hook returns a non-false value.
        return true;
    }

    public function render(Request $request): JsonResponse
    {
        // Rendering happens after the controller's transaction has rolled back.
        // Never rotate another device's remember token or change the user record.
        Auth::guard('web')->logoutCurrentDevice();
        if ($request->hasSession()) {
            $request->session()->invalidate();
            $request->session()->regenerateToken();
        }

        return response()->json([
            'message' => 'Sua sessão foi revogada. Entre novamente.',
            'code' => 'session_revoked',
        ], 401);
    }
}
