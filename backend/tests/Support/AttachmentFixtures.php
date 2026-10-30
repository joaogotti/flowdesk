<?php

namespace Tests\Support;

use App\Models\Ticket;
use App\Models\TicketAttachment;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Storage;

trait AttachmentFixtures
{
    use AssignmentFixtures;

    protected string $attachmentRoot;

    protected function createAttachmentFixtures(): void
    {
        $this->createAssignmentFixtures();
        (require database_path('migrations/2026_10_29_210000_create_ticket_attachments_table.php'))->up();
        $this->attachmentRoot = sys_get_temp_dir().'/flowdesk-attachment-fixture-'.bin2hex(random_bytes(12));
        config(['filesystems.disks.attachments.root' => $this->attachmentRoot, 'logging.default' => 'null']);
        Storage::forgetDisk('attachments');
    }

    protected function removeAttachmentFiles(): void
    {
        if (isset($this->attachmentRoot) && realpath(dirname($this->attachmentRoot)) === realpath(sys_get_temp_dir()) &&
            str_starts_with(basename($this->attachmentRoot), 'flowdesk-attachment-fixture-') && ! is_link($this->attachmentRoot)) {
            File::deleteDirectory($this->attachmentRoot);
        }
    }

    protected function attachmentFile(string $name = 'evidence.txt', string $body = 'Valid UTF-8 evidence'): UploadedFile
    {
        return UploadedFile::fake()->createWithContent($name, $body);
    }

    protected function attachment(Ticket $ticket, string $state = 'ready', array $overrides = [], string $content = 'Evidence'): TicketAttachment
    {
        $record = TicketAttachment::create(array_replace([
            'ticket_id' => $ticket->id, 'uploaded_by' => $this->requester->id,
            'storage_key' => 'tickets/'.$ticket->id.'/'.bin2hex(random_bytes(16)).'.txt', 'original_name' => 'evidence.txt',
            'mime_type' => 'text/plain', 'size_bytes' => strlen($content), 'sha256' => hash('sha256', $content),
            'state' => $state, 'created_at' => now(), 'confirmed_at' => $state === 'ready' ? now() : null, 'expires_at' => now()->addDay(),
        ], $overrides));
        if ($state === 'ready') {
            Storage::disk('attachments')->put($record->storage_key, $content);
        }

        return $record;
    }
}
