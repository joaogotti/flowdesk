<?php

namespace Tests\Feature;

use Tests\TestCase;

class ApiHealthTest extends TestCase
{
    public function test_api_health_is_public_and_returns_application_status(): void
    {
        $this->getJson('/api/health')
            ->assertOk()
            ->assertHeader('Content-Type', 'application/json')
            ->assertExactJson([
                'status' => 'ok',
                'application' => 'Flowdesk',
            ]);
    }
}
