<?php

// Kernel independente, restrito ao PostgreSQL descartável de cadastro de categorias.
use App\Models\User;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

require dirname(__DIR__, 2).'/vendor/autoload.php';

$input = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
if (($input['connection']['driver'] ?? null) !== 'pgsql' ||
    ($input['connection']['database'] ?? null) !== 'flowdesk_category_create_test' ||
    ! preg_match('/^flowdesk-category-create-test-[a-f0-9]+$/', $input['connection']['host'] ?? '')) {
    throw new RuntimeException('O worker exige um PostgreSQL de categorias descartável.');
}

putenv('APP_ENV=testing');
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$kernel->bootstrap();
config([
    'database.default' => 'category_creation_pg', 'database.connections.category_creation_pg' => $input['connection'],
    'session.driver' => 'array', 'cache.default' => 'array', 'sanctum.stateful' => [], 'logging.default' => 'null',
]);
DB::statement("SET application_name = 'flowdesk_category_creation_worker'");
DB::statement("SET statement_timeout = '60s'");
$request = Request::create('/api/admin/categories', 'POST', server: [
    'HTTP_ACCEPT' => 'application/json', 'CONTENT_TYPE' => 'application/json',
], content: json_encode(['name' => $input['name']], JSON_THROW_ON_ERROR));
$app->instance('request', $request);
Auth::guard('web')->setUser(User::findOrFail($input['user_id']));
fwrite(STDOUT, "ready\n");
fflush(STDOUT);
$response = $kernel->handle($request);
fwrite(STDOUT, json_encode(['status' => $response->getStatusCode(), 'body' => json_decode($response->getContent(), true)], JSON_THROW_ON_ERROR)."\n");
$kernel->terminate($request, $response);
DB::disconnect();
