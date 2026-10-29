<?php

namespace App\Http\Controllers\Auth;

use App\Http\Controllers\Controller;
use App\Models\User;
use App\Support\SessionVersion;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
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

        $credentials = [
            'email' => $email,
            'password' => $validated['password'],
            'disabled_at' => null,
        ];
        $candidate = User::query()->where('email', $email)->whereNull('disabled_at')->first();
        $authenticated = DB::transaction(function () use ($guard, $candidate, $credentials, $request, $email): bool {
            // Only a user row is locked. Exclusive locking also supports the guard's
            // password rehash without a shared-to-exclusive lock upgrade.
            $current = $candidate === null ? null : User::query()->whereKey($candidate->id)->lockForUpdate()->first();
            if ($current === null || $current->disabled_at !== null || $current->email !== $email ||
                SessionVersion::current($current) !== SessionVersion::current($candidate)) {
                // Preserve the guard's failed-attempt events and credential timing.
                return $guard->attemptWhen($credentials, fn () => false);
            }
            if (! $guard->attempt($credentials)) {
                return false;
            }
            $request->session()->regenerate();
            $request->session()->put(SessionVersion::KEY, SessionVersion::current($current));

            return true;
        });

        if (! $authenticated) {
            RateLimiter::hit($key, 60);

            return response()->json(['message' => 'Credenciais inválidas.'], 401);
        }

        RateLimiter::clear($key);

        return response()->json($guard->user()->only(['id', 'name', 'email', 'role']));
    }
}
