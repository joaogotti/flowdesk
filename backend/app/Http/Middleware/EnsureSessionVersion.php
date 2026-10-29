<?php

namespace App\Http\Middleware;

use App\Models\User;
use App\Support\SessionVersion;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class EnsureSessionVersion
{
    public function handle(Request $request, Closure $next): Response
    {
        SessionVersion::capture($request);
        // The guard may already hold an identity loaded earlier in this request.
        SessionVersion::assertCurrent($request, User::query()->find($request->user()->id));

        return $next($request);
    }
}
