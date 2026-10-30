<?php

namespace Tests\Support;

use App\Models\Category;
use App\Models\SlaPolicy;
use App\Models\Ticket;
use App\Models\TicketStatus;
use App\Models\User;
use Database\Seeders\CategorySeeder;
use Database\Seeders\SlaPolicySeeder;
use Database\Seeders\TicketStatusSeeder;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

trait AssignmentFixtures
{
    protected User $requester;

    protected function createAssignmentFixtures(): void
    {
        // Nunca preparar o esquema no banco da aplicação.
        $driver = DB::connection()->getDriverName();
        $this->assertTrue(
            ($driver === 'sqlite' && DB::connection()->getDatabaseName() === ':memory:') ||
            ($driver === 'pgsql' && in_array(DB::connection()->getDatabaseName(), ['flowdesk_assignment_test', 'flowdesk_status_test', 'flowdesk_details_test', 'flowdesk_comment_test', 'flowdesk_role_test', 'flowdesk_session_test', 'flowdesk_user_status_test', 'flowdesk_attachments_test'], true))
        );
        $this->assertFalse(Schema::hasTable('users'));
        (require database_path('migrations/0001_01_01_000000_create_users_table.php'))->up();
        Schema::table('users', function (Blueprint $table) {
            $table->string('role', 20)->default('requester');
            $table->timestampTz('disabled_at')->nullable();
            $table->bigInteger('session_version')->default(0);
        });
        (require database_path('migrations/2026_10_19_194356_create_categories_table.php'))->up();
        Schema::create('ticket_statuses', function (Blueprint $table) {
            $table->id();
            $table->string('code', 30)->unique();
            $table->string('name', 80);
            $table->integer('position');
            $table->timestampsTz();
        });
        Schema::create('sla_policies', function (Blueprint $table) {
            $table->id();
            $table->string('priority', 10)->unique();
            $table->integer('first_response_minutes');
            $table->integer('resolution_minutes');
            $table->timestampsTz();
        });
        // Mesmo isolamento SQLite da suíte existente, sem CHECK exclusivo do PostgreSQL.
        Schema::create('tickets', function (Blueprint $table) {
            $table->id();
            $table->foreignId('requester_id')->constrained('users')->restrictOnDelete();
            $table->foreignId('assigned_to')->nullable()->constrained('users')->restrictOnDelete();
            $table->foreignId('category_id')->constrained('categories')->restrictOnDelete();
            $table->foreignId('status_id')->constrained('ticket_statuses')->restrictOnDelete();
            $table->foreignId('sla_policy_id')->constrained('sla_policies')->restrictOnDelete();
            $table->string('title', 200);
            $table->text('description');
            $table->string('priority', 10)->default('medium');
            $table->timestampTz('first_response_due_at');
            $table->timestampTz('resolution_due_at');
            $table->timestampTz('first_responded_at')->nullable();
            $table->timestampTz('resolved_at')->nullable();
            $table->timestampTz('closed_at')->nullable();
            $table->timestampsTz();
        });
        (require database_path('migrations/2026_10_19_195904_create_ticket_comments_table.php'))->up();
        (require database_path('migrations/2026_10_19_200056_create_ticket_activities_table.php'))->up();
        $this->seed([CategorySeeder::class, TicketStatusSeeder::class, SlaPolicySeeder::class]);
        $this->requester = User::factory()->create(['role' => 'requester']);
        $this->travelTo(now()->startOfSecond());
        config(['sanctum.stateful' => ['localhost:5173']]);
        $this->withHeader('Origin', 'http://localhost:5173');
    }

    protected function ticket(array $overrides = []): Ticket
    {
        return Ticket::create(array_replace([
            'requester_id' => $this->requester->id, 'assigned_to' => null,
            'category_id' => Category::firstOrFail()->id,
            'status_id' => TicketStatus::where('code', 'open')->sole()->id,
            'sla_policy_id' => SlaPolicy::where('priority', 'medium')->sole()->id,
            'title' => 'Solicitação de teste', 'description' => 'Descrição de teste', 'priority' => 'medium',
            'first_response_due_at' => now()->addHours(4), 'resolution_due_at' => now()->addDay(),
        ], $overrides));
    }

    protected function snapshot(): array
    {
        $snapshot = [];
        foreach (['users', 'tickets', 'ticket_comments', 'ticket_activities', 'categories', 'ticket_statuses', 'sla_policies', 'sessions'] as $table) {
            $snapshot[$table] = DB::table($table)->orderBy('id')->get()->toJson();
        }

        return $snapshot;
    }
}
