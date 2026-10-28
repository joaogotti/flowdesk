<?php

namespace App\Support;

use Illuminate\Database\QueryException;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class UserEmailConflict
{
    public static function throwIfDuplicate(QueryException $exception): void
    {
        if ($exception instanceof UniqueConstraintViolationException && (
            $exception->index === 'users_email_unique' ||
            (DB::getDriverName() === 'sqlite' && $exception->columns === ['email'] && str_contains($exception->getMessage(), 'UNIQUE constraint failed: users.email'))
        )) {
            throw ValidationException::withMessages(['email' => ['Já existe um usuário com esse e-mail.']]);
        }
    }
}
