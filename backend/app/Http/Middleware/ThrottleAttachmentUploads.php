<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\RateLimiter;
use Symfony\Component\HttpFoundation\Response;

class ThrottleAttachmentUploads
{
    public function handle(Request $request, Closure $next): Response
    {
        $key = 'attachment-upload:'.$request->user()->id;
        DB::transaction(function () use ($key): void {
            // Separate namespace; no ticket/user locks are held here. A shared cache is
            // required across workers. Hash collisions only serialize unrelated users.
            if (DB::getDriverName() === 'pgsql') {
                DB::select('SELECT pg_advisory_xact_lock(706405, hashtext(?))', [$key]);
            }
            if (RateLimiter::tooManyAttempts($key, 10)) {
                abort(response()->json(['message' => 'Limite de 10 tentativas de upload por minuto atingido.'], 429)
                    ->header('Retry-After', (string) RateLimiter::availableIn($key)));
            }
            RateLimiter::hit($key, 60);
        });

        return $next($request);
    }
}
