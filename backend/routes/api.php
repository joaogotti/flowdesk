<?php

use App\Http\Controllers\Auth\LoginController;
use App\Http\Controllers\Auth\LogoutController;
use App\Http\Controllers\Auth\UserController;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Route;

Route::post('/login', LoginController::class);

Route::post('/logout', LogoutController::class)->middleware('auth:sanctum');

Route::middleware(['auth:sanctum', 'user.active'])->group(function (): void {
    Route::get('/user', UserController::class);
});

Route::get('/health', function (): JsonResponse {
    return response()->json([
        'status' => 'ok',
        'application' => 'Flowdesk',
    ]);
});
