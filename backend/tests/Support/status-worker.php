<?php

// Kernel HTTP independente, restrito ao banco PostgreSQL descartável de status.
use App\Models\User;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Date;
use Illuminate\Support\Facades\DB;

require dirname(__DIR__, 2).'/vendor/autoload.php';

$input = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
if (($input['connection']['driver'] ?? null) !== 'pgsql' ||
    ($input['connection']['database'] ?? null) !== 'flowdesk_status_test' ||
    ! preg_match('/^flowdesk-status-test-[a-f0-9]+$/', $input['connection']['host'] ?? '')) {
    throw new RuntimeException('O worker exige um PostgreSQL de status descartável.');
}

putenv('APP_ENV=testing');
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$kernel->bootstrap();
config([
    'database.default' => 'status_pg', 'database.connections.status_pg' => $input['connection'],
    'session.driver' => 'array', 'cache.default' => 'array', 'sanctum.stateful' => [],
]);
Date::setTestNow($input['now']);
$ready = false;
DB::listen(function ($query) use (&$ready): void {
    if (! $ready && str_contains($query->sql, '"tickets"') && ! str_contains($query->sql, 'for update')) {
        $ready = true;
        fwrite(STDOUT, "ready\n");
        fflush(STDOUT);
    }
});
$request = Request::create('/api/tickets/'.$input['ticket_id'].'/status', 'PATCH', server: [
    'HTTP_ACCEPT' => 'application/json', 'CONTENT_TYPE' => 'application/json',
], content: json_encode(['status' => $input['status']], JSON_THROW_ON_ERROR));
$app->instance('request', $request);
Auth::guard('web')->setUser(User::findOrFail($input['user_id']));
$response = $kernel->handle($request);
fwrite(STDOUT, json_encode(['status' => $response->getStatusCode(), 'body' => json_decode($response->getContent(), true)], JSON_THROW_ON_ERROR)."\n");
$kernel->terminate($request, $response);
DB::disconnect();
