<?php

// Kernel independente, restrito ao PostgreSQL descartável de edição de usuários.
use App\Models\User;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

require dirname(__DIR__, 2).'/vendor/autoload.php';

$input = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
if (($input['connection']['driver'] ?? null) !== 'pgsql' ||
    ($input['connection']['database'] ?? null) !== 'flowdesk_user_edit_test' ||
    ! preg_match('/^flowdesk-user-edit-test-[a-f0-9]+$/', $input['connection']['host'] ?? '')) {
    throw new RuntimeException('O worker exige um PostgreSQL de edição descartável.');
}
$method = $input['method'] ?? 'PATCH';
if (! in_array($method, ['POST', 'PATCH'], true)) {
    throw new RuntimeException('Método de teste inválido.');
}

putenv('APP_ENV=testing');
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$kernel->bootstrap();
config([
    'database.default' => 'user_edit_pg', 'database.connections.user_edit_pg' => $input['connection'],
    'session.driver' => 'array', 'cache.default' => 'array', 'sanctum.stateful' => [], 'logging.default' => 'null',
]);
DB::statement("SET application_name = 'flowdesk_user_edit_worker'");
DB::statement("SET statement_timeout = '60s'");
$path = '/api/admin/users'.($method === 'PATCH' ? '/'.$input['target_id'] : '');
if ($input['self_profile'] ?? false) {
    if ($method !== 'PATCH' || $input['target_id'] !== $input['actor_id']) {
        throw new RuntimeException('Autoedição exige o próprio usuário.');
    }
    $path = '/api/user/profile';
}
$request = Request::create($path, $method, server: [
    'HTTP_ACCEPT' => 'application/json', 'CONTENT_TYPE' => 'application/json',
], content: json_encode($input['payload'], JSON_THROW_ON_ERROR));
$app->instance('request', $request);
Auth::guard('web')->setUser(User::findOrFail($input['actor_id']));
$response = $kernel->handle($request);
fwrite(STDOUT, json_encode(['status' => $response->getStatusCode(), 'body' => json_decode($response->getContent(), true)], JSON_THROW_ON_ERROR)."\n");
$kernel->terminate($request, $response);
DB::disconnect();
