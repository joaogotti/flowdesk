<?php

use App\Http\Requests\StoreTicketCommentRequest;
use App\Http\Requests\UpdateTicketAssignmentRequest;
use App\Models\TicketActivity;
use App\Models\TicketComment;
use App\Models\User;
use App\Support\SessionVersion;
use Illuminate\Auth\Events\Login;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Cookie\CookieValuePrefix;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

require dirname(__DIR__, 2).'/vendor/autoload.php';
$input = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
if (($input['connection']['driver'] ?? null) !== 'pgsql' ||
    ($input['connection']['database'] ?? null) !== 'flowdesk_session_test' ||
    ! preg_match('/^flowdesk-session-test-[a-f0-9]+$/', $input['connection']['host'] ?? '') ||
    ! preg_match('/^[a-f0-9]+$/', $input['key'] ?? '')) {
    throw new RuntimeException('Disposable session-version PostgreSQL required.');
}
putenv('APP_ENV=testing');
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$kernel->bootstrap();
config([
    'database.default' => 'session_pg', 'database.connections.session_pg' => $input['connection'],
    'session.driver' => 'database', 'session.connection' => 'session_pg',
    'cache.default' => 'array', 'sanctum.stateful' => ['localhost:5173'], 'logging.default' => 'null',
]);
DB::select("SELECT set_config('application_name', ?, false)", ['flowdesk_session_'.$input['key']]);
DB::statement("SET statement_timeout = '30s'");
$signal = function (string $marker): void {
    fwrite(STDOUT, $marker."\n");
    fflush(STDOUT);
};
$barrier = function (string $marker) use ($signal): void {
    $signal($marker);
    DB::select('SELECT pg_advisory_lock(706403, 1)');
    DB::select('SELECT pg_advisory_unlock(706403, 1)');
};
if ($input['operation'] === 'revoke') {
    DB::transaction(function () use ($input, $signal): void {
        $signal('revoke_ready');
        $user = User::whereKey($input['actor_id'])->lockForUpdate()->firstOrFail();
        DB::table('users')->where('id', $user->id)->update(['session_version' => $user->session_version + 2, 'disabled_at' => null]);
        DB::table('sessions')->where('user_id', $user->id)->delete();
    });
    fwrite(STDOUT, json_encode(['status' => 200], JSON_THROW_ON_ERROR)."\n");
    exit;
}
$writes = [];
DB::listen(function ($query) use ($input, &$writes, $signal): void {
    if ($input['operation'] === 'login' && str_starts_with($query->sql, 'select') && str_contains($query->sql, '"email" = ?')) {
        $signal('candidate_read');
    }
    if (preg_match('/^\s*(insert into|update|delete from) "(tickets|ticket_comments|ticket_activities)"/i', $query->sql)) {
        $writes[] = $query->sql;
    }
});
if (in_array($input['operation'], ['comment', 'assignment'], true)) {
    $form = $input['operation'] === 'comment' ? StoreTicketCommentRequest::class : UpdateTicketAssignmentRequest::class;
    $app->afterResolving($form, fn () => $signal('validated'));
    if ($input['hold_writer'] ?? false) {
        if ($input['operation'] === 'comment') {
            TicketComment::created(fn () => $barrier('writer_locked'));
        } else {
            TicketActivity::created(fn () => $barrier('writer_locked'));
        }
    }
}
if ($input['late_save'] ?? false) {
    $app['events']->listen(Login::class, function () use ($barrier): void {
        DB::afterCommit(fn () => $barrier('login_committed'));
    });
}
[$method, $path] = match ($input['operation']) {
    'login' => ['POST', '/api/login'],
    'probe' => ['GET', '/api/user'],
    'comment' => ['POST', '/api/tickets/'.$input['ticket_id'].'/comments'],
    'assignment' => ['PATCH', '/api/tickets/'.$input['ticket_id'].'/assignment'],
};
$cookies = [];
if (isset($input['session_id'])) {
    $name = config('session.cookie');
    $cookies[$name] = $app['encrypter']->encrypt(CookieValuePrefix::create($name, $app['encrypter']->getKey()).$input['session_id'], false);
}
$request = Request::create($path, $method, cookies: $cookies, server: [
    'HTTP_ACCEPT' => 'application/json', 'CONTENT_TYPE' => 'application/json', 'HTTP_ORIGIN' => 'http://localhost:5173',
], content: json_encode($input['payload'] ?? [], JSON_THROW_ON_ERROR));
$response = $kernel->handle($request);
fwrite(STDOUT, json_encode([
    'status' => $response->getStatusCode(), 'body' => json_decode($response->getContent(), true),
    'session_id' => $request->hasSession() ? $request->session()->getId() : null,
    'version' => $request->hasSession() ? $request->session()->get(SessionVersion::KEY) : null,
    'writes' => $writes,
], JSON_THROW_ON_ERROR)."\n");
$kernel->terminate($request, $response);
DB::disconnect();
