<?php

// Kernel independente, restrito ao PostgreSQL descartável dos testes de detalhes.
use App\Http\Requests\UpdateTicketDetailsRequest;
use App\Models\User;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Date;
use Illuminate\Support\Facades\DB;

require dirname(__DIR__, 2).'/vendor/autoload.php';

$input = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
if (($input['connection']['driver'] ?? null) !== 'pgsql' ||
    ($input['connection']['database'] ?? null) !== 'flowdesk_details_test' ||
    ! preg_match('/^flowdesk-details-test-[a-f0-9]+$/', $input['connection']['host'] ?? '')) {
    throw new RuntimeException('O worker exige um PostgreSQL de detalhes descartável.');
}

putenv('APP_ENV=testing');
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$kernel->bootstrap();
config([
    'database.default' => 'details_pg', 'database.connections.details_pg' => $input['connection'],
    'session.driver' => 'array', 'cache.default' => 'array', 'sanctum.stateful' => [], 'logging.default' => 'null',
]);
DB::statement("SET application_name = 'flowdesk_details_worker'");
DB::statement("SET statement_timeout = '25s'");
Date::setTestNow($input['now']);
// A barreira é posterior à autorização e à validação, antes do controller.
$app->afterResolving(UpdateTicketDetailsRequest::class, function (): void {
    fwrite(STDOUT, "ready\n");
    fflush(STDOUT);
});
$request = Request::create('/api/tickets/'.$input['ticket_id'].'/details', 'PATCH', server: [
    'HTTP_ACCEPT' => 'application/json', 'CONTENT_TYPE' => 'application/json',
], content: json_encode($input['payload'], JSON_THROW_ON_ERROR));
$app->instance('request', $request);
Auth::guard('web')->setUser(User::findOrFail($input['user_id']));
$response = $kernel->handle($request);
fwrite(STDOUT, json_encode(['status' => $response->getStatusCode(), 'body' => json_decode($response->getContent(), true)], JSON_THROW_ON_ERROR)."\n");
$kernel->terminate($request, $response);
DB::disconnect();
