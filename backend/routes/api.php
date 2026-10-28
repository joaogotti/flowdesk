<?php

use App\Http\Controllers\Auth\LoginController;
use App\Http\Controllers\Auth\LogoutController;
use App\Http\Controllers\Auth\UserController;
use App\Http\Controllers\Categories\IndexCategoryController;
use App\Http\Controllers\Technicians\IndexTechnicianController;
use App\Http\Controllers\Tickets\IndexTicketController;
use App\Http\Controllers\Tickets\ShowTicketController;
use App\Http\Controllers\Tickets\StoreTicketCommentController;
use App\Http\Controllers\Tickets\StoreTicketController;
use App\Http\Controllers\Tickets\UpdateTicketAssignmentController;
use App\Http\Controllers\Tickets\UpdateTicketDetailsController;
use App\Http\Controllers\Tickets\UpdateTicketStatusController;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Route;

Route::post('/login', LoginController::class);

Route::post('/logout', LogoutController::class)->middleware('auth:sanctum');

Route::middleware(['auth:sanctum', 'user.active'])->group(function (): void {
    Route::get('/user', UserController::class);
    Route::get('/categories', IndexCategoryController::class);
    Route::get('/technicians', IndexTechnicianController::class);
    Route::get('/tickets', IndexTicketController::class);
    Route::get('/tickets/{id}', ShowTicketController::class)->whereNumber('id');
    Route::post('/tickets', StoreTicketController::class);
    Route::post('/tickets/{id}/comments', StoreTicketCommentController::class)->whereNumber('id');
    Route::patch('/tickets/{id}/assignment', UpdateTicketAssignmentController::class)->whereNumber('id');
    Route::patch('/tickets/{id}/status', UpdateTicketStatusController::class)->whereNumber('id');
    Route::patch('/tickets/{id}/details', UpdateTicketDetailsController::class)->whereNumber('id');
});

Route::get('/health', function (): JsonResponse {
    return response()->json([
        'status' => 'ok',
        'application' => 'Flowdesk',
    ]);
});
