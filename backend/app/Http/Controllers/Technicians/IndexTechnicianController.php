<?php

namespace App\Http\Controllers\Technicians;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class IndexTechnicianController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        if ($request->user()?->role !== 'admin') {
            return response()->json(['message' => 'Acesso não permitido.'], 403);
        }

        $technicians = User::query()
            ->where('role', 'technician')
            ->whereNull('disabled_at')
            ->orderBy('name')
            ->orderBy('id')
            ->get(['id', 'name'])
            ->map(fn (User $user): array => $user->only(['id', 'name']));

        return response()->json(['data' => $technicians]);
    }
}
