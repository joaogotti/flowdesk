<?php

namespace Database\Seeders;

use App\Models\Category;
use Illuminate\Database\Seeder;

class CategorySeeder extends Seeder
{
    public function run(): void
    {
        $categories = [
            [
                'name' => 'Hardware',
                'description' => 'Problemas relacionados a computadores, periféricos e equipamentos físicos.',
                'is_active' => true,
            ],
            [
                'name' => 'Software',
                'description' => 'Problemas relacionados a programas, aplicativos e sistemas.',
                'is_active' => true,
            ],
            [
                'name' => 'Rede',
                'description' => 'Problemas relacionados à conexão de rede, internet e conectividade.',
                'is_active' => true,
            ],
            [
                'name' => 'Acesso',
                'description' => 'Solicitações e problemas relacionados a contas, senhas e permissões.',
                'is_active' => true,
            ],
        ];

        foreach ($categories as $category) {
            Category::updateOrCreate(
                ['name' => $category['name']],
                ['description' => $category['description'], 'is_active' => $category['is_active']],
            );
        }
    }
}
