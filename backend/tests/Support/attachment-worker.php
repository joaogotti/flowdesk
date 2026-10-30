<?php

use App\Http\Requests\StoreTicketAttachmentRequest;
use App\Models\TicketAttachment;
use App\Services\AttachmentStorage;
use App\Services\TicketAttachments;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Cookie\CookieValuePrefix;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\StreamedResponse;

require dirname(__DIR__, 2).'/vendor/autoload.php';
$input = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
if (($input['connection']['database'] ?? '') !== 'flowdesk_attachments_test' ||
    ($input['connection']['driver'] ?? '') !== 'pgsql' ||
    ! preg_match('/^flowdesk-attachments-test-[a-f0-9]+$/', $input['connection']['host'] ?? '') ||
    ! preg_match('#^/tmp/flowdesk-attachment-fixture-[a-f0-9]{24}$#D', $input['root'] ?? '') ||
    ! preg_match('/^[a-f0-9]{8}$/', $input['key'] ?? '')) {
    throw new RuntimeException('Disposable attachment PostgreSQL and storage required.');
}
putenv('APP_ENV=testing');
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$kernel->bootstrap();
config(['database.default' => 'attachments_pg', 'database.connections.attachments_pg' => $input['connection'],
    'session.driver' => 'database', 'session.connection' => 'attachments_pg', 'sanctum.stateful' => ['localhost:5173'],
    'cache.default' => 'database', 'cache.stores.database.connection' => 'attachments_pg',
    'filesystems.disks.attachments.root' => $input['root'], 'logging.default' => 'null']);
DB::select("SELECT set_config('application_name', ?, false)", ['attachment_worker_'.$input['key']]);
DB::statement("SET statement_timeout = '30s'");
$signal = function (string $value): void {
    fwrite(STDOUT, $value."\n");
    fflush(STDOUT);
};
$barrier = function () use ($signal): void {
    $signal('io_barrier');
    DB::select('SELECT pg_advisory_lock(706406, 1)');
    DB::select('SELECT pg_advisory_unlock(706406, 1)');
};
if ($input['hold'] ?? false) {
    $app->bind(AttachmentStorage::class, fn () => new class($barrier, $input['operation']) extends AttachmentStorage
    {
        public function __construct(private $barrier, private string $operation) {}

        public function write(TicketAttachment $attachment, UploadedFile $file): void
        {
            if ($this->operation === 'upload') {
                ($this->barrier)();
            }
            parent::write($attachment, $file);
        }

        public function verifiedStream(TicketAttachment $attachment): mixed
        {
            $stream = parent::verifiedStream($attachment);
            if ($this->operation === 'download') {
                ($this->barrier)();
            }

            return $stream;
        }
    });
}
if ($input['operation'] === 'reconcile') {
    echo json_encode($app->make(TicketAttachments::class)->reconcile(100), JSON_THROW_ON_ERROR)."\n";
    exit;
}
$app->afterResolving(StoreTicketAttachmentRequest::class, fn () => $signal('validated'));
$ticket = $input['ticket_id'] ?? 0;
$target = $input['target_id'] ?? 0;
[$method, $path] = match ($input['operation']) {
    'upload' => ['POST', '/api/tickets/'.$ticket.'/attachments'],
    'download' => ['GET', '/api/tickets/'.$ticket.'/attachments/'.$input['attachment_id'].'/download'],
    'assign' => ['PATCH', '/api/tickets/'.$ticket.'/assignment'],
    'role' => ['PATCH', '/api/admin/users/'.$target.'/role'],
    'status' => ['PATCH', '/api/admin/users/'.$target.'/status'],
    'ticket_status' => ['PATCH', '/api/tickets/'.$ticket.'/status'],
};
$name = config('session.cookie');
$cookie = $app['encrypter']->encrypt(CookieValuePrefix::create($name, $app['encrypter']->getKey()).$input['session_id'], false);
$files = $input['operation'] === 'upload' ? ['file' => UploadedFile::fake()->createWithContent('evidence.txt', str_repeat('a', $input['bytes'] ?? 100))] : [];
$request = Request::create($path, $method, cookies: [$name => $cookie], files: $files,
    server: ['HTTP_ACCEPT' => 'application/json', 'HTTP_ORIGIN' => 'http://localhost:5173',
        'CONTENT_TYPE' => $files ? 'multipart/form-data' : 'application/json'],
    content: $files ? null : json_encode($input['payload'] ?? []));
$response = $kernel->handle($request);
if ($response instanceof StreamedResponse && $response->isSuccessful()) {
    ob_start();
    $response->sendContent();
    $content = ob_get_clean();
    $body = ['bytes' => strlen($content), 'sha256' => hash('sha256', $content)];
} else {
    $body = json_decode($response->getContent(), true);
}
echo json_encode(['status' => $response->getStatusCode(), 'body' => $body], JSON_THROW_ON_ERROR)."\n";
$kernel->terminate($request, $response);
DB::disconnect();
