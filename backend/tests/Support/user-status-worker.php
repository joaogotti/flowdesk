<?php

use App\Http\Requests\StoreTicketCommentRequest;
use App\Http\Requests\UpdateAdminUserRequest;
use App\Http\Requests\UpdateAdminUserRoleRequest;
use App\Http\Requests\UpdateAdminUserStatusRequest;
use App\Http\Requests\UpdateTicketAssignmentRequest;
use App\Models\TicketActivity;
use App\Models\TicketComment;
use App\Models\UserStatusChange;
use App\Support\SessionVersion;
use Illuminate\Auth\Events\Login;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Cookie\CookieValuePrefix;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

require dirname(__DIR__, 2).'/vendor/autoload.php';
$input = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
if (($input['connection']['driver'] ?? null) !== 'pgsql' ||
    ($input['connection']['database'] ?? null) !== 'flowdesk_user_status_test' ||
    ! preg_match('/^flowdesk-user-status-test-[a-f0-9]+$/', $input['connection']['host'] ?? '') ||
    ! preg_match('/^[a-f0-9]+$/', $input['key'] ?? '')) {
    throw new RuntimeException('Disposable user-status PostgreSQL required.');
}
putenv('APP_ENV=testing');
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$kernel->bootstrap();
config(['database.default' => 'user_status_pg', 'database.connections.user_status_pg' => $input['connection'],
    'session.driver' => 'database', 'session.connection' => 'user_status_pg', 'cache.default' => 'array',
    'sanctum.stateful' => ['localhost:5173'], 'logging.default' => 'null']);
DB::select("SELECT set_config('application_name', ?, false)", ['flowdesk_user_status_'.$input['key']]);
DB::statement("SET statement_timeout = '30s'");
[$method, $path, $form] = match ($input['operation']) {
    'status' => ['PATCH', '/api/admin/users/'.$input['target_id'].'/status', UpdateAdminUserStatusRequest::class],
    'role' => ['PATCH', '/api/admin/users/'.$input['target_id'].'/role', UpdateAdminUserRoleRequest::class],
    'name' => ['PATCH', '/api/admin/users/'.$input['target_id'], UpdateAdminUserRequest::class],
    'assignment' => ['PATCH', '/api/tickets/'.$input['ticket_id'].'/assignment', UpdateTicketAssignmentRequest::class],
    'comment' => ['POST', '/api/tickets/'.$input['ticket_id'].'/comments', StoreTicketCommentRequest::class],
    'login' => ['POST', '/api/login', null],
    'probe' => ['GET', '/api/user', null],
};
$signal = function (string $message): void {
    fwrite(STDOUT, $message."\n");
    fflush(STDOUT);
};
$barrier = function () use ($signal): void {
    $signal('mutation_written');
    DB::select('SELECT pg_advisory_xact_lock(706404, 1)');
};
if ($form !== null) {
    $app->afterResolving($form, fn () => $signal('validated'));
}
if ($input['hold'] ?? false) {
    match ($input['operation']) {
        'status' => UserStatusChange::created($barrier),
        'assignment' => TicketActivity::created($barrier),
        'comment' => TicketComment::created($barrier),
        'login' => $app['events']->listen(Login::class, fn () => DB::afterCommit($barrier)),
    };
}
$writes = [];
DB::listen(function ($query) use (&$writes): void {
    if (preg_match('/^\s*(insert into|update|delete from) "(users|user_status_changes|user_role_changes|tickets|ticket_comments|ticket_activities)"/i', $query->sql)) {
        $writes[] = $query->sql;
    }
});
$cookies = [];
if (isset($input['session_id'])) {
    $name = config('session.cookie');
    $cookies[$name] = $app['encrypter']->encrypt(CookieValuePrefix::create($name, $app['encrypter']->getKey()).$input['session_id'], false);
}
$request = Request::create($path, $method, cookies: $cookies, server: [
    'HTTP_ACCEPT' => 'application/json', 'CONTENT_TYPE' => 'application/json', 'HTTP_ORIGIN' => 'http://localhost:5173',
], content: json_encode($input['payload'] ?? [], JSON_THROW_ON_ERROR));
$response = $kernel->handle($request);
fwrite(STDOUT, json_encode(['status' => $response->getStatusCode(), 'body' => json_decode($response->getContent(), true),
    'session_id' => $request->hasSession() ? $request->session()->getId() : null,
    'version' => $request->hasSession() ? $request->session()->get(SessionVersion::KEY) : null,
    'writes' => $writes], JSON_THROW_ON_ERROR)."\n");
$kernel->terminate($request, $response);
DB::disconnect();
