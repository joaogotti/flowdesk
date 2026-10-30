<?php

namespace Tests\Feature;

use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\URL;
use League\Flysystem\PathTraversalDetected;
use League\Flysystem\UnableToCreateDirectory;
use RuntimeException;
use Tests\TestCase;

class AttachmentStorageTest extends TestCase
{
    private string $temporaryRoot;

    private FilesystemAdapter $disk;

    protected function setUp(): void
    {
        parent::setUp();
        $this->temporaryRoot = sys_get_temp_dir().'/flowdesk-attachments-'.bin2hex(random_bytes(12));
        mkdir($this->temporaryRoot, 0700);
        // Never resolve the configured development disk: all writes use this temporary root.
        $this->disk = Storage::build([...config('filesystems.disks.attachments'), 'root' => $this->temporaryRoot.'/files']);
    }

    protected function tearDown(): void
    {
        try {
            if (isset($this->temporaryRoot) && realpath(dirname($this->temporaryRoot)) === realpath(sys_get_temp_dir()) &&
                str_starts_with(basename($this->temporaryRoot), 'flowdesk-attachments-') && ! is_link($this->temporaryRoot)) {
                File::deleteDirectory($this->temporaryRoot);
            }
        } finally {
            parent::tearDown();
        }
    }

    public function test_root_is_private_separate_from_served_disks_and_not_linked(): void
    {
        $config = config('filesystems.disks.attachments');
        $this->assertSame('local', $config['driver']);
        $this->assertSame(storage_path('app/attachments'), $config['root']);
        $this->assertSame('private', $config['visibility']);
        $this->assertSame('private', $config['directory_visibility']);
        $this->assertFalse($config['serve']);
        $this->assertTrue($config['throw']);
        foreach ([public_path(), config('filesystems.disks.local.root'), config('filesystems.disks.public.root')] as $root) {
            $this->assertFalse(str_starts_with($config['root'], rtrim($root, '/\\').DIRECTORY_SEPARATOR));
        }
        foreach (config('filesystems.links') as $target) {
            $this->assertNotSame($config['root'], $target);
        }
        $this->assertFalse($this->app['router']->getRoutes()->hasNamedRoute('storage.attachments'));
        $this->assertFalse($this->app['router']->getRoutes()->hasNamedRoute('storage.attachments.upload'));
    }

    public function test_local_storage_reads_writes_and_uses_private_permissions(): void
    {
        $this->assertTrue($this->disk->put('tickets/1/probe.txt', 'isolated attachment'));
        $this->assertSame('isolated attachment', $this->disk->get('tickets/1/probe.txt'));
        $this->assertSame('private', $this->disk->getVisibility('tickets/1/probe.txt'));
        if (DIRECTORY_SEPARATOR === '/') {
            $this->assertSame(0600, fileperms($this->disk->path('tickets/1/probe.txt')) & 0777);
            $this->assertSame(0700, fileperms($this->disk->path('tickets/1')) & 0777);
        }
    }

    public function test_temporary_urls_cannot_be_generated(): void
    {
        $this->assertFalse($this->disk->providesTemporaryUrls());
        $this->expectException(RuntimeException::class);
        $this->disk->temporaryUrl('probe.txt', now()->addMinute());
    }

    public function test_path_traversal_is_rejected(): void
    {
        file_put_contents($this->temporaryRoot.'/outside.txt', 'outside');
        $this->expectException(PathTraversalDetected::class);
        $this->disk->get('../outside.txt');
    }

    public function test_failed_writes_throw_instead_of_reporting_success(): void
    {
        $this->disk->put('occupied', 'a file, not a directory');
        $this->expectException(UnableToCreateDirectory::class);
        $this->disk->put('occupied/probe.txt', 'must fail');
    }

    public function test_public_and_signed_storage_routes_do_not_expose_attachments(): void
    {
        $marker = 'private-attachment-'.bin2hex(random_bytes(8));
        $this->disk->put('probe.txt', $marker);
        config(['filesystems.disks.attachments.root' => $this->disk->path(''),
            'filesystems.disks.local.root' => $this->temporaryRoot.'/local',
            'filesystems.disks.public.root' => $this->temporaryRoot.'/public']);
        foreach (['/attachments/probe.txt', '/storage/attachments/probe.txt',
            URL::temporarySignedRoute('storage.local', now()->addMinute(), ['path' => '../files/probe.txt'], absolute: false)] as $url) {
            $response = $this->get($url);
            $this->assertContains($response->status(), [403, 404]);
            $response->assertDontSee($marker);
        }
    }
}
