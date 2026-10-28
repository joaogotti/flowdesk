<?php

// Real HTTP kernels, strictly restricted to the disposable role-test database.
use App\Http\Requests\StoreTicketCommentRequest;
use App\Http\Requests\UpdateAdminUserRequest;
use App\Http\Requests\UpdateAdminUserRoleRequest;
use App\Http\Requests\UpdateTicketAssignmentRequest;
use App\Models\TicketActivity;
use App\Models\TicketComment;
use App\Models\User;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

require dirname(__DIR__, 2).'/vendor/autoload.php';
$input = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
if (($input['connection']['driver'] ?? null) !== 'pgsql' ||
    ($input['connection']['database'] ?? null) !== 'flowdesk_role_test' ||
    ! preg_match('/^flowdesk-role-test-[a-f0-9]+$/', $input['connection']['host'] ?? '') ||
    ! preg_match('/^[a-f0-9]+$/', $input['worker_key'] ?? '')) {
    throw new RuntimeException('The worker requires a disposable role-test database.');
}
[$method, $path, $form] = match ($input['operation']) {
    'role' => ['PATCH', '/api/admin/users/'.$input['target_id'].'/role', UpdateAdminUserRoleRequest::class],
    'assignment' => ['PATCH', '/api/tickets/'.$input['ticket_id'].'/assignment', UpdateTicketAssignmentRequest::class],
    'comment' => ['POST', '/api/tickets/'.$input['ticket_id'].'/comments', StoreTicketCommentRequest::class],
    'name' => ['PATCH', '/api/admin/users/'.$input['target_id'], UpdateAdminUserRequest::class],
};
putenv('APP_ENV=testing');
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$kernel->bootstrap();
config([
    'database.default' => 'role_pg', 'database.connections.role_pg' => $input['connection'],
    'session.driver' => 'array', 'cache.default' => 'array', 'sanctum.stateful' => [], 'logging.default' => 'null',
]);
DB::select("SELECT set_config('application_name', ?, false)", ['flowdesk_role_worker_'.$input['worker_key']]);
DB::statement("SET statement_timeout = '60s'");
$writes = [];
$locks = [];
DB::listen(function ($query) use (&$writes, &$locks): void {
    if (preg_match('/^\s*(insert|update|delete)\b/i', $query->sql, $match)) {
        $writes[] = strtolower($match[1]);
    }
    if (str_contains($query->sql, '"users"') && (str_contains($query->sql, 'for share') || str_contains($query->sql, 'for update'))) {
        $locks[] = ['id' => (int) $query->bindings[0], 'mode' => str_contains($query->sql, 'for share') ? 'share' : 'update'];
    }
});
$app->afterResolving($form, function (): void {
    fwrite(STDOUT, "validated\n");
    fflush(STDOUT);
});
if ($input['hold_before_commit'] ?? false) {
    $barrier = function (): void {
        fwrite(STDOUT, "mutation_written\n");
        fflush(STDOUT);
        DB::select('SELECT pg_advisory_xact_lock(706402, 2)');
    };
    if ($input['operation'] === 'assignment') {
        TicketActivity::created($barrier);
    } else {
        TicketComment::created($barrier);
    }
}
$request = Request::create($path, $method, server: [
    'HTTP_ACCEPT' => 'application/json', 'CONTENT_TYPE' => 'application/json',
], content: json_encode($input['payload'], JSON_THROW_ON_ERROR));
$app->instance('request', $request);
Auth::guard('web')->setUser(User::findOrFail($input['actor_id']));
$response = $kernel->handle($request);
fwrite(STDOUT, json_encode([
    'status' => $response->getStatusCode(), 'body' => json_decode($response->getContent(), true),
    'writes' => $writes, 'locks' => $locks,
], JSON_THROW_ON_ERROR)."\n");
$kernel->terminate($request, $response);
DB::disconnect();
