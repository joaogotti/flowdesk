<?php

namespace Database\Seeders;

use App\Models\SlaPolicy;
use Illuminate\Database\Seeder;

class SlaPolicySeeder extends Seeder
{
    public function run(): void
    {
        $policies = [
            ['priority' => 'low', 'first_response_minutes' => 480, 'resolution_minutes' => 4320],
            ['priority' => 'medium', 'first_response_minutes' => 240, 'resolution_minutes' => 1440],
            ['priority' => 'high', 'first_response_minutes' => 60, 'resolution_minutes' => 480],
            ['priority' => 'urgent', 'first_response_minutes' => 15, 'resolution_minutes' => 240],
        ];

        foreach ($policies as $policy) {
            SlaPolicy::updateOrCreate(
                ['priority' => $policy['priority']],
                [
                    'first_response_minutes' => $policy['first_response_minutes'],
                    'resolution_minutes' => $policy['resolution_minutes'],
                ],
            );
        }
    }
}
