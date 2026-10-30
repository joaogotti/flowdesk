<?php

namespace Tests\Feature;

use App\Models\TicketActivity;
use App\Models\TicketAttachment;
use App\Models\TicketStatus;
use App\Models\User;
use App\Services\AttachmentStorage;
use App\Services\TicketAttachments;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\Support\AttachmentFixtures;
use Tests\TestCase;

class TicketAttachmentsTest extends TestCase
{
    use AttachmentFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertSame(':memory:', DB::connection()->getDatabaseName());
        $this->createAttachmentFixtures();
        $this->actingAs($this->requester, 'web');
    }

    protected function tearDown(): void
    {
        try {
            $this->removeAttachmentFiles();
        } finally {
            parent::tearDown();
        }
    }

    private function upload($ticket, ?UploadedFile $file = null, array $extra = [])
    {
        return $this->post('/api/tickets/'.$ticket->id.'/attachments', ['file' => $file ?? $this->attachmentFile(), ...$extra], ['Accept' => 'application/json']);
    }

    public static function formats(): array
    {
        return [['txt', 'Olá, evidência UTF-8'], ['pdf', "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n"],
            ['png', base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=')],
            ['jpg', hex2bin('ffd8ffe000104a46494600010100000100010000ffc00011080001000103012200021101031101ffd9')]];
    }

    #[DataProvider('formats')]
    public function test_upload_listing_download_integrity_and_history(string $extension, string $content): void
    {
        $ticket = $this->ticket();
        $before = $ticket->fresh()->getAttributes();
        $this->travel(1)->seconds();
        $response = $this->upload($ticket, $this->attachmentFile('evidência.'.$extension, $content))->assertCreated();
        $record = TicketAttachment::sole();
        $this->assertSame('ready', $record->state);
        $this->assertSame(hash('sha256', $content), $record->sha256);
        $this->assertSame($content, Storage::disk('attachments')->get($record->storage_key));
        $this->assertStringNotContainsString($record->storage_key, $response->getContent());
        $this->assertSame($ticket->id, $record->ticket->id);
        $this->assertSame(1, $this->requester->ticketAttachments()->count());
        $event = TicketActivity::sole();
        $this->assertSame('attachment_added', $event->action);
        $this->assertSame(['attachment_id' => $record->id], $event->changes);
        $after = $ticket->fresh()->getAttributes();
        unset($before['updated_at'], $after['updated_at']);
        $this->assertSame($before, $after);
        $this->getJson('/api/tickets/'.$ticket->id.'/attachments')->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $record->id);
        $download = $this->get('/api/tickets/'.$ticket->id.'/attachments/'.$record->id.'/download');
        $download->assertOk()->assertHeader('X-Content-Type-Options', 'nosniff')->assertHeader('Content-Type', $record->mime_type === 'text/plain' ? 'text/plain; charset=utf-8' : $record->mime_type);
        $this->assertStringContainsString('attachment;', $download->headers->get('Content-Disposition'));
        $this->assertStringContainsString('no-store', $download->headers->get('Cache-Control'));
        $this->assertSame($content, $download->streamedContent());
    }

    public static function invalidFiles(): array
    {
        return [['script.php', '<?php echo 1;'], ['fake.jpg', 'not an image'], ['fake.pdf', 'not a pdf'],
            ['fake.png', '%PDF-1.7'], ['evil.php.txt', 'text'], ['../escape.txt', 'text'], ['C:\\escape.txt', 'text'],
            ["nul\0.txt", 'text'], ["header\r\n.txt", 'text'], ['bidi'."\u{202E}".'.txt', 'text'],
            ['empty.txt', ''], ['binary.txt', "abc\0def"], ['latin.txt', "invalid\xff UTF8"],
            ['code.svg', '<svg/>'], ['archive.zip', 'PK zip'], ['huge.txt', str_repeat('a', 5242881)],
            [str_repeat('a', 201).'.txt', 'text'],
            ['wide.png', substr_replace(base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII='), pack('N', 5001), 16, 4)]];
    }

    #[DataProvider('invalidFiles')]
    public function test_invalid_files_do_not_reserve_or_write(string $name, string $content): void
    {
        $this->upload($this->ticket(), $this->attachmentFile($name, $content))->assertUnprocessable();
        $this->assertSame(0, TicketAttachment::count());
        $this->assertSame([], Storage::disk('attachments')->allFiles());
        $this->assertSame(0, TicketActivity::count());
    }

    public function test_exact_five_mib_is_allowed(): void
    {
        $this->upload($this->ticket(), $this->attachmentFile('limit.txt', str_repeat('a', 5242880)))->assertCreated();
        $this->assertSame(5242880, TicketAttachment::sole()->size_bytes);
    }

    public function test_payload_is_strict_and_accepts_one_file_only(): void
    {
        $ticket = $this->ticket();
        $url = '/api/tickets/'.$ticket->id.'/attachments';
        $this->upload($ticket, extra: ['uploaded_by' => 1])->assertUnprocessable();
        $this->post($url, ['file' => [$this->attachmentFile(), $this->attachmentFile()]], ['Accept' => 'application/json'])->assertUnprocessable();
        $this->post($url.'?disk=public', ['file' => $this->attachmentFile()], ['Accept' => 'application/json'])->assertUnprocessable();
        $this->post($url, ['file' => $this->attachmentFile(), 'second' => $this->attachmentFile()], ['Accept' => 'application/json'])->assertUnprocessable();
        $this->assertSame(0, TicketAttachment::count());
    }

    public static function statuses(): array
    {
        return [['open', true], ['in_progress', true], ['waiting_requester', true], ['resolved', false], ['closed', false], ['cancelled', false]];
    }

    #[DataProvider('statuses')]
    public function test_status_limits_only_upload_and_not_reading(string $status, bool $allowed): void
    {
        $ticket = $this->ticket(['status_id' => TicketStatus::where('code', $status)->sole()->id]);
        $record = $this->attachment($ticket);
        $this->upload($ticket)->assertStatus($allowed ? 201 : 409);
        $this->getJson('/api/tickets/'.$ticket->id.'/attachments')->assertOk();
        $this->get('/api/tickets/'.$ticket->id.'/attachments/'.$record->id.'/download')->assertOk()->streamedContent();
    }

    public function test_permissions_scope_membership_and_hidden_reservations(): void
    {
        $ticket = $this->ticket();
        $record = $this->attachment($ticket);
        $this->attachment($ticket, 'pending');
        $this->attachment($ticket, 'failed');
        $this->getJson('/api/tickets/'.$ticket->id.'/attachments')->assertJsonCount(1, 'data');
        $other = User::factory()->create(['role' => 'requester']);
        Auth::forgetGuards();
        $this->actingAs($other, 'web');
        $this->upload($ticket)->assertNotFound();
        $this->getJson('/api/tickets/'.$ticket->id.'/attachments')->assertNotFound();
        $this->getJson('/api/tickets/'.$ticket->id.'/attachments/'.$record->id.'/download')->assertNotFound();
        $admin = User::factory()->create(['role' => 'admin']);
        Auth::forgetGuards();
        $this->actingAs($admin, 'web')->getJson('/api/tickets/'.$ticket->id.'/attachments')->assertOk();
        $second = $this->ticket();
        $this->getJson('/api/tickets/'.$second->id.'/attachments/'.$record->id.'/download')->assertNotFound();
        foreach (TicketAttachment::where('state', '!=', 'ready')->get() as $hidden) {
            $this->getJson('/api/tickets/'.$ticket->id.'/attachments/'.$hidden->id.'/download')->assertNotFound();
        }
        $tech = User::factory()->create(['role' => 'technician']);
        Auth::forgetGuards();
        $this->actingAs($tech, 'web')->getJson('/api/tickets/'.$ticket->id.'/attachments')->assertOk();
        $ticket->update(['assigned_to' => User::factory()->create(['role' => 'technician'])->id]);
        $this->getJson('/api/tickets/'.$ticket->id.'/attachments')->assertNotFound();
    }

    public function test_guest_disabled_and_revoked_sessions_are_denied(): void
    {
        $ticket = $this->ticket();
        Auth::forgetGuards();
        $this->upload($ticket)->assertUnauthorized();
        $this->actingAs($this->requester, 'web');
        $this->requester->update(['disabled_at' => now()]);
        $this->upload($ticket)->assertForbidden();
        $this->requester->forceFill(['disabled_at' => null, 'session_version' => 2])->save();
        $this->upload($ticket)->assertUnauthorized()->assertJsonPath('code', 'session_revoked');
        $this->assertSame(0, TicketAttachment::count());
    }

    public function test_pending_reservations_count_against_both_quotas(): void
    {
        $ticket = $this->ticket();
        for ($i = 0; $i < 10; $i++) {
            $this->attachment($ticket, 'pending');
        }
        $this->upload($ticket)->assertConflict()->assertJsonPath('code', 'attachment_limit_reached');
        $other = $this->ticket();
        for ($i = 0; $i < 5; $i++) {
            $this->attachment($other, 'pending', ['size_bytes' => 5242880]);
        }
        $this->upload($other)->assertConflict()->assertJsonPath('code', 'attachment_limit_reached');
    }

    public function test_ten_attempts_per_user_include_invalid_requests(): void
    {
        $ticket = $this->ticket();
        for ($i = 0; $i < 10; $i++) {
            $this->upload($ticket, $this->attachmentFile('bad.exe'))->assertUnprocessable();
        }
        $this->upload($ticket)->assertStatus(429);
        Auth::forgetGuards();
        $this->actingAs(User::factory()->create(['role' => 'admin']), 'web');
        $this->upload($ticket)->assertCreated();
    }

    public function test_storage_write_is_outside_transactions_and_revocation_prevents_confirmation(): void
    {
        $owner = $this;
        $user = $this->requester;
        $this->app->bind(AttachmentStorage::class, fn () => new class($owner, $user) extends AttachmentStorage
        {
            public function __construct(private $test, private $user) {}

            public function write(TicketAttachment $attachment, UploadedFile $file): void
            {
                $this->test->assertSame(0, DB::transactionLevel());
                parent::write($attachment, $file);
                DB::table('users')->where('id', $this->user->id)->increment('session_version');
            }
        });
        $this->upload($this->ticket())->assertUnauthorized()->assertJsonPath('code', 'session_revoked');
        $record = TicketAttachment::sole();
        $this->assertSame('failed', $record->state);
        $this->assertNotNull($record->cleaned_at);
        $this->assertFalse(Storage::disk('attachments')->exists($record->storage_key));
        $this->assertSame(0, TicketActivity::count());
    }

    public function test_failed_history_insert_rolls_back_ready_and_cleans_file(): void
    {
        TicketActivity::creating(fn () => throw new RuntimeException('simulated audit failure'));
        $ticket = $this->ticket();
        $before = $ticket->fresh()->getAttributes();
        $this->upload($ticket)->assertStatus(503);
        $record = TicketAttachment::sole();
        $this->assertSame('failed', $record->state);
        $this->assertNull($record->confirmed_at);
        $this->assertSame(0, TicketActivity::count());
        $this->assertSame($before, $ticket->fresh()->getAttributes());
        $this->assertFalse(Storage::disk('attachments')->exists($record->storage_key));
    }

    public function test_reconciliation_retries_failed_deletion_and_never_deletes_ready_files(): void
    {
        $this->app->bind(AttachmentStorage::class, fn () => new class extends AttachmentStorage
        {
            public function write(TicketAttachment $attachment, UploadedFile $file): void
            {
                parent::write($attachment, $file);
                throw new RuntimeException('simulated interruption');
            }

            public function deleteFailed(TicketAttachment $attachment): void
            {
                throw new RuntimeException('simulated disk outage');
            }
        });
        $ticket = $this->ticket();
        $this->upload($ticket)->assertStatus(503);
        $failed = TicketAttachment::sole();
        $this->assertNull($failed->cleaned_at);
        $this->assertTrue(Storage::disk('attachments')->exists($failed->storage_key));
        $this->app->bind(AttachmentStorage::class, fn () => new AttachmentStorage);
        $ready = $this->attachment($ticket);
        $pending = $this->attachment($ticket, 'pending');
        $this->travel(25)->hours();
        $storage = new AttachmentStorage;
        $storage->withLock($pending, function () use ($pending): void {
            $result = $this->app->make(TicketAttachments::class)->reconcile(100);
            $this->assertSame(1, $result['skipped']);
            $this->assertSame('pending', $pending->fresh()->state);
        });
        $this->artisan('attachments:reconcile')->assertSuccessful();
        $this->assertSame('failed', $pending->fresh()->state);
        $this->assertNotNull($pending->fresh()->cleaned_at);
        $this->assertNotNull($failed->fresh()->cleaned_at);
        $this->assertTrue(Storage::disk('attachments')->exists($ready->storage_key));
        $this->assertFalse(Storage::disk('attachments')->exists($failed->storage_key));
        $this->artisan('attachments:reconcile', ['--limit' => 0])->assertFailed();
    }

    public function test_download_revalidates_session_after_reading_and_never_exposes_corruption(): void
    {
        $ticket = $this->ticket();
        $record = $this->attachment($ticket);
        Storage::disk('attachments')->put($record->storage_key, 'corrupt');
        $this->getJson('/api/tickets/'.$ticket->id.'/attachments/'.$record->id.'/download')->assertStatus(503);
        Storage::disk('attachments')->put($record->storage_key, 'Evidence');
        $user = $this->requester;
        $this->app->bind(AttachmentStorage::class, fn () => new class($user) extends AttachmentStorage
        {
            public function __construct(private $user) {}

            public function verifiedStream(TicketAttachment $attachment): mixed
            {
                $stream = parent::verifiedStream($attachment);
                DB::table('users')->where('id', $this->user->id)->increment('session_version');

                return $stream;
            }
        });
        $this->getJson('/api/tickets/'.$ticket->id.'/attachments/'.$record->id.'/download')->assertUnauthorized()->assertJsonPath('code', 'session_revoked');
    }

    public function test_uploader_does_not_keep_access_after_assignment_changes(): void
    {
        $tech = User::factory()->create(['role' => 'technician']);
        $this->actingAs($tech, 'web');
        $ticket = $this->ticket();
        $this->upload($ticket)->assertCreated();
        $record = TicketAttachment::sole();
        $this->assertSame($tech->id, $record->uploaded_by);
        $ticket->update(['assigned_to' => User::factory()->create(['role' => 'technician'])->id]);
        $this->getJson('/api/tickets/'.$ticket->id.'/attachments/'.$record->id.'/download')->assertNotFound();
        $this->assertTrue(Storage::disk('attachments')->exists($record->storage_key));
    }

    public function test_missing_migration_fails_closed_without_disclosing_sql_or_paths(): void
    {
        $ticket = $this->ticket();
        Schema::drop('ticket_attachments');
        config(['app.debug' => true]);
        foreach ([$this->getJson('/api/tickets/'.$ticket->id.'/attachments'),
            $this->getJson('/api/tickets/'.$ticket->id.'/attachments/1/download'), $this->upload($ticket)] as $response) {
            $response->assertStatus(503)->assertJsonPath('code', 'attachment_unavailable');
            $this->assertStringNotContainsString('SQL', $response->getContent());
            $this->assertStringNotContainsString($this->attachmentRoot, $response->getContent());
        }
    }

    public function test_partial_write_failure_is_compensated(): void
    {
        $this->app->bind(AttachmentStorage::class, fn () => new class extends AttachmentStorage
        {
            public function write(TicketAttachment $attachment, UploadedFile $file): void
            {
                Storage::disk('attachments')->put($attachment->storage_key, 'partial');
                throw new RuntimeException('partial write');
            }
        });
        $this->upload($this->ticket())->assertStatus(503);
        $record = TicketAttachment::sole();
        $this->assertSame('failed', $record->state);
        $this->assertNotNull($record->cleaned_at);
        $this->assertFalse(Storage::disk('attachments')->exists($record->storage_key));
    }

    public function test_uncertain_commit_never_deletes_a_confirmed_attachment(): void
    {
        $this->app->bind(TicketAttachments::class, fn ($app) => new class($app->make(AttachmentStorage::class)) extends TicketAttachments
        {
            public function confirm(Request $request, TicketAttachment $reservation): TicketAttachment
            {
                parent::confirm($request, $reservation);
                throw new RuntimeException('connection lost after confirmed commit');
            }
        });
        $ticket = $this->ticket();
        $this->upload($ticket)->assertStatus(503);
        $record = TicketAttachment::sole();
        $this->assertSame('ready', $record->state);
        $this->assertTrue(Storage::disk('attachments')->exists($record->storage_key));
        $this->assertSame(1, TicketActivity::count());
        $this->getJson('/api/tickets/'.$ticket->id.'/attachments')->assertOk()->assertJsonCount(1, 'data');
    }

    public function test_payload_requires_csrf_for_stateful_upload(): void
    {
        Auth::forgetGuards();
        $this->postJson('/api/login', ['email' => $this->requester->email, 'password' => 'password'])->assertOk();
        $id = session()->getId();
        $token = session()->token();
        $ticket = $this->ticket();
        $this->app->instance('env', 'local');
        Auth::forgetGuards();
        $this->withCredentials()->withCookie(config('session.cookie'), $id);
        $this->upload($ticket)->assertStatus(419);
        $this->withHeader('X-CSRF-TOKEN', $token);
        $this->upload($ticket)->assertCreated();
    }
}
