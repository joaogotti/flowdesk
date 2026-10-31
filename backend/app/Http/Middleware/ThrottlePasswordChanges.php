<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Symfony\Component\HttpFoundation\Response;

class ThrottlePasswordChanges
{
    public function handle(Request $request, Closure $next): Response
    {
        $limits = [
            'password-change:user:'.hash('sha256', (string) $request->user()->id) => 5,
            'password-change:ip:'.hash('sha256', (string) $request->ip()) => 20,
        ];
        $retryAfter = 0;
        foreach ($limits as $key => $limit) {
            if (RateLimiter::tooManyAttempts($key, $limit)) {
                $retryAfter = max($retryAfter, max(1, RateLimiter::availableIn($key)));
            }
        }
        if ($retryAfter > 0) {
            return response()->json(['message' => 'Muitas tentativas de alteração de senha. Aguarde antes de tentar novamente.'], 429)
                ->header('Retry-After', (string) $retryAfter);
        }
        // Count invalid payloads too, before FormRequest validation and password hashing.
        foreach ($limits as $key => $limit) {
            RateLimiter::hit($key, 60);
        }

        return $next($request);
    }
}
