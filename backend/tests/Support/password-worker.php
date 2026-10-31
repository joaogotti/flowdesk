<?php

use App\Http\Requests\UpdateUserPasswordRequest;
use App\Http\Requests\UpdateUserProfileRequest;
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
    ($input['connection']['database'] ?? null) !== 'flowdesk_password_test' ||
    ! preg_match('/^flowdesk-password-test-[a-f0-9]+$/', $input['connection']['host'] ?? '') ||
    ! preg_match('/^[a-f0-9]+$/', $input['key'] ?? '')) {
    throw new RuntimeException('Disposable password PostgreSQL required.');
}
putenv('APP_ENV=testing');
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$kernel->bootstrap();
config(['database.default' => 'password_pg', 'database.connections.password_pg' => $input['connection'],
    'session.driver' => 'database', 'session.connection' => 'password_pg', 'cache.default' => 'array',
    'sanctum.stateful' => ['localhost:5173'], 'logging.default' => 'null']);
DB::select("SELECT set_config('application_name', ?, false)", ['flowdesk_password_'.$input['key']]);
DB::statement("SET statement_timeout = '60s'");
$signal = function (string $marker): void {
    fwrite(STDOUT, $marker."\n");
    fflush(STDOUT);
};
$barrier = function (string $marker) use ($signal): void {
    $signal($marker);
    DB::select('SELECT pg_advisory_lock(706405, 1)');
    DB::select('SELECT pg_advisory_unlock(706405, 1)');
};
$operation = $input['operation'];
if (in_array($operation, ['password', 'profile'], true)) {
    $app->afterResolving($operation === 'password' ? UpdateUserPasswordRequest::class : UpdateUserProfileRequest::class,
        fn () => $signal('validated'));
}
if ($input['hold_password'] ?? false) {
    User::updated(function (User $user) use ($barrier): void {
        if ($user->wasChanged('password')) {
            $barrier('password_written');
        }
    });
}
if ($input['late_login_save'] ?? false) {
    $app['events']->listen(Login::class, fn () => DB::afterCommit(fn () => $barrier('login_committed')));
}
if ($operation === 'login') {
    DB::listen(function ($query) use ($signal): void {
        if (str_starts_with($query->sql, 'select') && str_contains($query->sql, '"email" = ?')) {
            $signal('candidate_read');
        }
    });
}
[$method, $path] = match ($operation) {
    'password' => ['PUT', '/api/user/password'],
    'profile' => ['PATCH', '/api/user/profile'],
    'login' => ['POST', '/api/login'],
    'probe' => ['GET', '/api/user'],
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
], JSON_THROW_ON_ERROR)."\n");
$kernel->terminate($request, $response);
DB::disconnect();
