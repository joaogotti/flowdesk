<?php

use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\URL;

$guard = getenv('FLOWDESK_ATTACHMENT_INFRA_TEST');
if (! is_string($guard) || ! preg_match('/^[a-f0-9]{16}$/', $guard) ||
    getenv('APP_ENV') !== 'testing' || getenv('DB_CONNECTION') !== 'sqlite' || getenv('DB_DATABASE') !== ':memory:') {
    throw new RuntimeException('Disposable attachment infrastructure runner required.');
}
require dirname(__DIR__, 2).'/vendor/autoload.php';
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
if (config('filesystems.disks.attachments.root') !== '/var/www/html/storage/app/attachments') {
    throw new RuntimeException('Unexpected disposable mount path.');
}
$disk = Storage::disk('attachments');
$key = 'verification/'.$guard.'.txt';
$contents = 'isolated-'.$guard;
if (($argv[1] ?? '') === 'write') {
    $disk->put($key, $contents);
} elseif (($argv[1] ?? '') !== 'read') {
    throw new RuntimeException('Unknown verification action.');
}
if ($disk->get($key) !== $contents) {
    throw new RuntimeException('Attachment did not survive container recreation.');
}
URL::forceRootUrl('http://127.0.0.1:8000');
echo json_encode([
    'root' => config('filesystems.disks.attachments.root'),
    'root_mode' => decoct(fileperms($disk->path('')) & 0777),
    'file_mode' => decoct(fileperms($disk->path($key)) & 0777),
    'directory_mode' => decoct(fileperms($disk->path('verification')) & 0777),
    'temporary_urls' => $disk->providesTemporaryUrls(),
    'upload_max_filesize' => ini_get('upload_max_filesize'),
    'post_max_size' => ini_get('post_max_size'),
    'max_file_uploads' => ini_get('max_file_uploads'),
    'urls' => [
        '/attachments/'.$key, '/storage/'.$key, '/storage/attachments/'.$key,
        '/storage/app/attachments/'.$key,
        URL::temporarySignedRoute('storage.local', now()->addMinute(), ['path' => '../attachments/'.$key], absolute: false),
    ],
], JSON_THROW_ON_ERROR).PHP_EOL;
