<?php

namespace App\Http\Controllers\Auth;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Str;

class LoginController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'email' => ['required', 'email'],
            'password' => ['required', 'string'],
        ]);

        abort_unless($request->hasSession(), 419, 'Inicialize a sessão e a proteção CSRF antes de entrar.');

        $email = Str::lower(trim($validated['email']));
        $key = 'login:'.hash('sha256', $email.'|'.$request->ip());

        if (RateLimiter::tooManyAttempts($key, 5)) {
            return response()->json([
                'message' => 'Muitas tentativas de login. Aguarde antes de tentar novamente.',
            ], 429)->header('Retry-After', (string) RateLimiter::availableIn($key));
        }

        $guard = Auth::guard('web');

        if (! $guard->attempt([
            'email' => $email,
            'password' => $validated['password'],
            'disabled_at' => null,
        ])) {
            RateLimiter::hit($key, 60);

            return response()->json(['message' => 'Credenciais inválidas.'], 401);
        }

        RateLimiter::clear($key);
        $request->session()->regenerate();

        return response()->json($guard->user()->only(['id', 'name', 'email', 'role']));
    }
}
