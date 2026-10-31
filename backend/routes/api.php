<?php

use App\Http\Controllers\Admin\Categories\IndexCategoryController as AdminIndexCategoryController;
use App\Http\Controllers\Admin\Categories\StoreCategoryController;
use App\Http\Controllers\Admin\Categories\UpdateCategoryController;
use App\Http\Controllers\Admin\Categories\UpdateCategoryStatusController;
use App\Http\Controllers\Admin\Users\IndexUserController;
use App\Http\Controllers\Admin\Users\StoreUserController;
use App\Http\Controllers\Admin\Users\UpdateUserController;
use App\Http\Controllers\Admin\Users\UpdateUserRoleController;
use App\Http\Controllers\Admin\Users\UpdateUserStatusController;
use App\Http\Controllers\Auth\LoginController;
use App\Http\Controllers\Auth\LogoutController;
use App\Http\Controllers\Auth\UpdatePasswordController;
use App\Http\Controllers\Auth\UpdateProfileController;
use App\Http\Controllers\Auth\UserController;
use App\Http\Controllers\Categories\IndexCategoryController;
use App\Http\Controllers\Dashboard\CategoriesController;
use App\Http\Controllers\Dashboard\RecentTicketsController;
use App\Http\Controllers\Dashboard\SlaController;
use App\Http\Controllers\Dashboard\StatsController;
use App\Http\Controllers\Reports\ExportController as ReportExportController;
use App\Http\Controllers\Reports\FiltersController as ReportFiltersController;
use App\Http\Controllers\Reports\SummaryController as ReportSummaryController;
use App\Http\Controllers\Reports\TicketsController as ReportTicketsController;
use App\Http\Controllers\Technicians\IndexTechnicianController;
use App\Http\Controllers\Tickets\DownloadTicketAttachmentController;
use App\Http\Controllers\Tickets\IndexTicketAttachmentController;
use App\Http\Controllers\Tickets\IndexTicketController;
use App\Http\Controllers\Tickets\ShowTicketController;
use App\Http\Controllers\Tickets\StoreTicketAttachmentController;
use App\Http\Controllers\Tickets\StoreTicketCommentController;
use App\Http\Controllers\Tickets\StoreTicketController;
use App\Http\Controllers\Tickets\UpdateTicketAssignmentController;
use App\Http\Controllers\Tickets\UpdateTicketDetailsController;
use App\Http\Controllers\Tickets\UpdateTicketStatusController;
use App\Http\Middleware\ThrottleAttachmentUploads;
use App\Http\Middleware\ThrottlePasswordChanges;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Route;

Route::post('/login', LoginController::class);

Route::post('/logout', LogoutController::class)->middleware(['auth:sanctum', 'auth.session.version']);

Route::middleware(['auth:sanctum', 'auth.session.version', 'user.active'])->group(function (): void {
    Route::get('/user', UserController::class);
    Route::patch('/user/profile', UpdateProfileController::class);
    Route::put('/user/password', UpdatePasswordController::class)->middleware(ThrottlePasswordChanges::class);
    Route::get('/reports/summary', ReportSummaryController::class);
    Route::get('/reports/tickets', ReportTicketsController::class);
    Route::get('/reports/tickets/export', ReportExportController::class);
    Route::get('/reports/filters', ReportFiltersController::class);
    Route::get('/dashboard/stats', StatsController::class);
    Route::get('/dashboard/recent-tickets', RecentTicketsController::class);
    Route::get('/dashboard/sla', SlaController::class);
    Route::get('/dashboard/categories', CategoriesController::class);
    Route::get('/categories', IndexCategoryController::class);
    Route::get('/admin/categories', AdminIndexCategoryController::class);
    Route::get('/admin/users', IndexUserController::class);
    Route::post('/admin/users', StoreUserController::class);
    Route::patch('/admin/users/{user}', UpdateUserController::class)->whereNumber('user');
    Route::patch('/admin/users/{user}/role', UpdateUserRoleController::class)->whereNumber('user');
    Route::patch('/admin/users/{user}/status', UpdateUserStatusController::class)->whereNumber('user');
    Route::post('/admin/categories', StoreCategoryController::class);
    Route::patch('/admin/categories/{category}', UpdateCategoryController::class)->whereNumber('category');
    Route::patch('/admin/categories/{category}/status', UpdateCategoryStatusController::class)->whereNumber('category');
    Route::get('/technicians', IndexTechnicianController::class);
    Route::get('/tickets', IndexTicketController::class);
    Route::get('/tickets/{ticket}/attachments', IndexTicketAttachmentController::class)->whereNumber('ticket');
    Route::post('/tickets/{ticket}/attachments', StoreTicketAttachmentController::class)->whereNumber('ticket')->middleware(ThrottleAttachmentUploads::class);
    Route::get('/tickets/{ticket}/attachments/{attachment}/download', DownloadTicketAttachmentController::class)->whereNumber(['ticket', 'attachment']);
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
