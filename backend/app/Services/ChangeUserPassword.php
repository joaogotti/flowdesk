<?php

namespace App\Services;

use App\Models\User;
use App\Support\SessionVersion;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;
use LogicException;

class ChangeUserPassword
{
    public function change(Request $request, array $validated): void
    {
        if (DB::transactionLevel() !== 0) {
            throw new LogicException('Password changes require an outermost transaction.');
        }
        DB::transaction(function () use ($request, $validated): void {
            $user = User::query()->whereKey($request->user()->id)->lockForUpdate()->first();
            SessionVersion::assertCurrent($request, $user);
            if ($user->disabled_at !== null || ! in_array($user->role, ['requester', 'technician', 'admin'], true)) {
                abort(response()->json(['message' => 'Acesso não permitido.'], 403));
            }
            if (! Hash::check($validated['current_password'], $user->password)) {
                throw ValidationException::withMessages(['current_password' => ['A senha atual não confere.']]);
            }
            if (Hash::check($validated['password'], $user->password)) {
                throw ValidationException::withMessages(['password' => ['A nova senha deve ser diferente da senha atual.']]);
            }
            $version = SessionVersion::current($user);
            if ($version === PHP_INT_MAX) {
                abort(response()->json(['message' => 'Não foi possível renovar a autenticação desta conta.', 'code' => 'session_version_exhausted'], 409));
            }
            $driver = config('session.driver');
            if (($driver !== 'database' && ! ($driver === 'array' && app()->runningUnitTests())) ||
                ($driver === 'database' && (config('session.connection') ?? DB::getDefaultConnection()) !== DB::getDefaultConnection())) {
                abort(response()->json(['message' => 'Armazenamento de sessões indisponível para esta operação.'], 503));
            }
            // Explicit hashing also treats a hash-shaped input as a literal password.
            $user->password = Hash::make($validated['password']);
            $user->session_version = $version + 1;
            $user->save();
            DB::table(config('session.table', 'sessions'))->where('user_id', $user->id)->delete();
        }, 3);
    }
}
