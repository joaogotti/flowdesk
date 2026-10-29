<?php

use App\Http\Middleware\EnsureSessionVersion;
use App\Http\Middleware\EnsureUserIsActive;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // Preserve NUL for validation; TrimStrings would silently remove it at the edges.
        $middleware->trimStrings(except: [fn (Request $request): bool => in_array($request->method(), ['POST', 'PATCH'], true)
            && $request->is('api/admin/users', 'api/admin/users/*')
            && is_string($request->input('email'))
            && str_contains($request->input('email'), "\0")]);
        $middleware->statefulApi();
        $middleware->alias([
            'auth.session.version' => EnsureSessionVersion::class,
            'user.active' => EnsureUserIsActive::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();
