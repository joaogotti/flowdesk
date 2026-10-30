<?php

namespace App\Services;

use App\Models\TicketAttachment;
use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use RuntimeException;

class AttachmentStorage
{
    protected function disk(): FilesystemAdapter
    {
        $config = config('filesystems.disks.attachments');
        if (($config['driver'] ?? null) !== 'local' || ($config['visibility'] ?? null) !== 'private' ||
            ($config['serve'] ?? true) || ($config['throw'] ?? false) !== true) {
            throw new RuntimeException('Private attachment storage is unavailable.');
        }

        return Storage::disk('attachments');
    }

    private function key(TicketAttachment $attachment): string
    {
        if (! preg_match('#^tickets/'.(int) $attachment->ticket_id.'/[a-f0-9]{32}\.(jpg|png|pdf|txt)$#D', $attachment->storage_key)) {
            throw new RuntimeException('Invalid attachment key.');
        }

        return $attachment->storage_key;
    }

    // No database locks may be held when acquiring this cooperative filesystem lock.
    // Keep lock files: removing a locked inode would allow a second independent lock.
    public function withLock(TicketAttachment $attachment, callable $callback, bool $wait = true): mixed
    {
        $key = $this->key($attachment);
        $disk = $this->disk();
        $disk->makeDirectory('.locks');
        $handle = fopen($disk->path('.locks/'.hash('sha256', $key).'.lock'), 'c');
        if ($handle === false) {
            throw new RuntimeException('Cannot open attachment lock.');
        }
        try {
            if (! chmod($disk->path('.locks/'.hash('sha256', $key).'.lock'), 0600)) {
                throw new RuntimeException('Cannot secure attachment lock.');
            }
            if (! flock($handle, LOCK_EX | ($wait ? 0 : LOCK_NB))) {
                return false;
            }

            return $callback();
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    public function write(TicketAttachment $attachment, UploadedFile $file): void
    {
        $stream = fopen($file->getPathname(), 'rb');
        if ($stream === false) {
            throw new RuntimeException('Cannot read uploaded file.');
        }
        try {
            if (! $this->disk()->put($this->key($attachment), $stream)) {
                throw new RuntimeException('Cannot store attachment.');
            }
        } finally {
            fclose($stream);
        }
        $verified = $this->verifiedStream($attachment);
        fclose($verified);
    }

    public function verifiedStream(TicketAttachment $attachment): mixed
    {
        $stream = $this->disk()->readStream($this->key($attachment));
        if (! is_resource($stream)) {
            throw new RuntimeException('Attachment unavailable.');
        }
        $hash = hash_init('sha256');
        if ((fstat($stream)['size'] ?? null) !== $attachment->size_bytes) {
            fclose($stream);
            throw new RuntimeException('Attachment size mismatch.');
        }
        $bytes = hash_update_stream($hash, $stream);
        if ($bytes !== $attachment->size_bytes || ! hash_equals($attachment->sha256, hash_final($hash)) || ! rewind($stream)) {
            fclose($stream);
            throw new RuntimeException('Attachment integrity mismatch.');
        }

        return $stream;
    }

    public function deleteFailed(TicketAttachment $attachment): void
    {
        if ($attachment->state !== 'failed') {
            throw new RuntimeException('Only failed reservations can be cleaned.');
        }
        $disk = $this->disk();
        $key = $this->key($attachment);
        if ($disk->exists($key) && ! $disk->delete($key)) {
            throw new RuntimeException('Attachment cleanup failed.');
        }
    }
}
