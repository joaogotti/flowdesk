<?php

namespace App\Http\Controllers\Admin\Users;

use App\Http\Controllers\Controller;
use App\Http\Requests\UpdateAdminUserRoleRequest;
use App\Models\Ticket;
use App\Models\User;
use App\Models\UserRoleChange;
use App\Support\SessionVersion;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

class UpdateUserRoleController extends Controller
{
    public function __invoke(UpdateAdminUserRoleRequest $request, string $user): JsonResponse
    {
        try {
            $updated = DB::transaction(function () use ($request, $user): User {
                // Reserved transaction mutex for all role changes. See docs/admin-user-roles.md.
                if (DB::connection()->getDriverName() === 'pgsql') {
                    DB::select('SELECT pg_advisory_xact_lock(706402, 1)');
                }
                $actorId = (int) $request->user()->id;
                $targetId = (int) $user;
                if ($actorId === $targetId) {
                    abort(response()->json(['message' => 'Não é permitido alterar o próprio perfil.'], 403));
                }

                // Ascending user IDs match name/email edits. Only the target needs an exclusive lock.
                // Shared actor locks remain compatible with assignment's shared user locks.
                $ids = [$actorId, $targetId];
                sort($ids, SORT_NUMERIC);
                $records = [];
                foreach ($ids as $id) {
                    $query = User::query()->whereKey($id);
                    $records[$id] = ($id === $targetId ? $query->lockForUpdate() : $query->sharedLock())->first();
                }
                $actor = $records[$actorId];
                if ($actor !== null) {
                    SessionVersion::assertCurrent($request, $actor);
                }
                if ($actor === null || $actor->disabled_at !== null || $actor->role !== 'admin') {
                    abort(response()->json(['message' => 'Acesso não permitido.'], 403));
                }
                $record = $records[$targetId];
                if ($record === null) {
                    abort(response()->json(['message' => 'Usuário não encontrado.'], 404));
                }
                if ($record->disabled_at !== null) {
                    $this->conflict('target_disabled', 'Não é permitido alterar o perfil de um usuário desativado.');
                }
                if ($record->role !== $request->validated('expected_role')) {
                    $this->conflict('role_changed', 'O perfil deste usuário foi alterado. Atualize a listagem.');
                }
                $next = $request->validated('role');
                if ($record->role === $next) {
                    return $record;
                }
                if ($record->role === 'admin' && User::query()->where('role', 'admin')->whereNull('disabled_at')->count() <= 1) {
                    $this->conflict('last_active_admin', 'O sistema deve manter ao menos um administrador ativo.');
                }
                // Never lock tickets here: ticket writers lock ticket -> user, not user -> ticket.
                // The exclusive target lock coordinates this read with assignment's revalidation.
                if ($record->role === 'technician' && Ticket::query()->where('assigned_to', $targetId)
                    ->whereHas('status', fn ($query) => $query->whereIn('code', ['open', 'in_progress', 'waiting_requester', 'resolved']))->exists()) {
                    $this->conflict('active_assignments', 'Este técnico possui chamados atribuídos que impedem a mudança de perfil.');
                }

                $previous = $record->role;
                $changedAt = now()->startOfSecond();
                $record->role = $next;
                $record->updated_at = $changedAt;
                $record->save();
                UserRoleChange::create([
                    'actor_id' => $actorId, 'target_user_id' => $targetId,
                    'previous_role' => $previous, 'new_role' => $next, 'created_at' => $changedAt,
                ]);

                return $record;
            }, 3);
        } catch (QueryException $exception) {
            report($exception);

            return response()->json(['message' => 'Não foi possível alterar o perfil no momento.'], 503);
        }

        return response()->json(['data' => [
            'id' => (int) $updated->id, 'name' => $updated->name, 'email' => $updated->email,
            'role' => $updated->role, 'disabled_at' => $updated->disabled_at?->toISOString(),
            'created_at' => $updated->created_at?->toISOString(),
        ]]);
    }

    private function conflict(string $code, string $message): never
    {
        abort(response()->json(['message' => $message, 'code' => $code], 409));
    }
}
