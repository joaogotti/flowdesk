<?php

namespace Database\Seeders;

use App\Models\TicketStatus;
use Illuminate\Database\Seeder;

class TicketStatusSeeder extends Seeder
{
    public function run(): void
    {
        $statuses = [
            ['code' => 'open', 'name' => 'Aberto', 'position' => 1],
            ['code' => 'in_progress', 'name' => 'Em andamento', 'position' => 2],
            ['code' => 'waiting_requester', 'name' => 'Aguardando solicitante', 'position' => 3],
            ['code' => 'resolved', 'name' => 'Resolvido', 'position' => 4],
            ['code' => 'closed', 'name' => 'Fechado', 'position' => 5],
            ['code' => 'cancelled', 'name' => 'Cancelado', 'position' => 6],
        ];

        foreach ($statuses as $status) {
            TicketStatus::updateOrCreate(
                ['code' => $status['code']],
                ['name' => $status['name'], 'position' => $status['position']],
            );
        }
    }
}
