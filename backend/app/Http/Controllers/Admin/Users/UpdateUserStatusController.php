<?php

namespace App\Http\Controllers\Admin\Users;

use App\Http\Controllers\Controller;
use App\Http\Requests\UpdateAdminUserStatusRequest;
use App\Models\User;
use App\Models\UserStatusChange;
use App\Support\AdminUserSecurity;
use App\Support\SessionVersion;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

class UpdateUserStatusController extends Controller
{
    public function __invoke(UpdateAdminUserStatusRequest $request, string $user): JsonResponse
    {
        try {
            $updated = DB::transaction(function () use ($request, $user): User {
                $actorId = (int) $request->user()->id;
                $targetId = (int) $user;
                $records = AdminUserSecurity::lockUsers($actorId, $targetId);
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
                $next = $request->validated('is_active');
                if ($actorId === $targetId && ! $next) {
                    abort(response()->json(['message' => 'Não é permitido desativar a própria conta.'], 403));
                }
                $current = $record->disabled_at === null;
                if ($current !== $request->validated('expected_is_active')) {
                    $this->conflict('status_changed', 'A situação deste usuário foi alterada. Atualize a listagem.');
                }
                if ($current === $next) {
                    return $record;
                }
                if (! $next && $record->role === 'admin' && User::query()->where('role', 'admin')->whereNull('disabled_at')->count() <= 1) {
                    $this->conflict('last_active_admin', 'O sistema deve manter ao menos um administrador ativo.');
                }
                if (! $next && $record->role === 'technician' && AdminUserSecurity::hasBlockingAssignments($targetId)) {
                    $this->conflict('active_assignments', 'Este técnico possui chamados atribuídos que impedem a desativação.');
                }
                $version = SessionVersion::current($record);
                if ($version === PHP_INT_MAX) {
                    $this->conflict('session_version_exhausted', 'Não foi possível renovar a autenticação desta conta.');
                }
                // Physical deletion must use the same transaction as the user and audit.
                $driver = config('session.driver');
                if (! in_array($driver, ['database', 'array'], true) ||
                    ($driver === 'database' && (config('session.connection') ?? DB::getDefaultConnection()) !== DB::getDefaultConnection())) {
                    abort(response()->json(['message' => 'Armazenamento de sessões indisponível para esta operação.'], 503));
                }
                $previous = $record->disabled_at;
                $changedAt = now()->startOfSecond();
                $record->disabled_at = $next ? null : $changedAt;
                $record->session_version = $version + 1;
                $record->updated_at = $changedAt;
                $record->save();
                DB::table(config('session.table', 'sessions'))->where('user_id', $targetId)->delete();
                UserStatusChange::create([
                    'actor_id' => $actorId, 'target_user_id' => $targetId,
                    'previous_disabled_at' => $previous, 'new_disabled_at' => $record->disabled_at,
                    'created_at' => $changedAt,
                ]);

                return $record;
            }, 3);
        } catch (QueryException $exception) {
            report($exception);

            return response()->json(['message' => 'Não foi possível alterar a situação no momento.'], 503);
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
