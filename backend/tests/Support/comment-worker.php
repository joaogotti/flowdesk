<?php

// Independent processes are allowed only on the disposable comments database.
use App\Http\Requests\StoreTicketCommentRequest;
use App\Models\TicketComment;
use App\Models\User;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

require dirname(__DIR__, 2).'/vendor/autoload.php';

$input = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
if (($input['connection']['driver'] ?? null) !== 'pgsql' ||
    ($input['connection']['database'] ?? null) !== 'flowdesk_comment_test' ||
    ! preg_match('/^flowdesk-comment-test-[a-f0-9]+$/', $input['connection']['host'] ?? '')) {
    throw new RuntimeException('The worker requires a disposable comments PostgreSQL database.');
}
putenv('APP_ENV=testing');
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$kernel->bootstrap();
config([
    'database.default' => 'comment_pg', 'database.connections.comment_pg' => $input['connection'],
    'session.driver' => 'array', 'cache.default' => 'array', 'sanctum.stateful' => [], 'logging.default' => 'null',
]);
$updatingRole = ($input['operation'] ?? 'comment') === 'role_update';
DB::statement("SET application_name = '".($updatingRole ? 'flowdesk_comment_role_writer' : 'flowdesk_comment_worker')."'");
DB::statement("SET statement_timeout = '60s'");
if ($updatingRole) {
    // Simulates a future profile writer, not an HTTP endpoint.
    User::whereKey($input['user_id'])->update(['role' => $input['role']]);
    fwrite(STDOUT, "role_committed\n");
    DB::disconnect();
    exit(0);
}
$writes = [];
$locks = [];
DB::listen(function ($query) use (&$writes, &$locks): void {
    if (preg_match('/^\s*(insert|update|delete)\b/i', $query->sql, $match)) {
        $writes[] = strtolower($match[1]);
    }
    if (str_contains($query->sql, 'for update') && str_contains($query->sql, '"tickets"')) {
        $locks[] = 'ticket';
    } elseif (str_contains($query->sql, 'for share') && str_contains($query->sql, '"users"')) {
        $locks[] = 'user';
    }
});
$app->afterResolving(StoreTicketCommentRequest::class, function (): void {
    fwrite(STDOUT, "validated\n");
    fflush(STDOUT);
});
if (isset($input['barrier'])) {
    TicketComment::created(function () use ($input): void {
        fwrite(STDOUT, "comment_inserted\n");
        fflush(STDOUT);
        DB::select('SELECT pg_advisory_xact_lock(?)', [$input['barrier']]);
    });
}
$request = Request::create('/api/tickets/'.$input['ticket_id'].'/comments', 'POST', server: [
    'HTTP_ACCEPT' => 'application/json', 'CONTENT_TYPE' => 'application/json',
], content: json_encode($input['payload'], JSON_THROW_ON_ERROR));
$app->instance('request', $request);
Auth::guard('web')->setUser(User::findOrFail($input['user_id']));
$response = $kernel->handle($request);
fwrite(STDOUT, json_encode([
    'status' => $response->getStatusCode(), 'body' => json_decode($response->getContent(), true),
    'writes' => $writes, 'locks' => $locks,
], JSON_THROW_ON_ERROR)."\n");
$kernel->terminate($request, $response);
DB::disconnect();
