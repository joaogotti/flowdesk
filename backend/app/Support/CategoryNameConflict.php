<?php

namespace App\Support;

use Illuminate\Database\QueryException;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class CategoryNameConflict
{
    public static function throwIfDuplicate(QueryException $exception): void
    {
        if ($exception instanceof UniqueConstraintViolationException && (
            in_array($exception->index, ['categories_name_unique', 'categories_name_normalized_unique'], true) ||
            (DB::getDriverName() === 'sqlite' && in_array($exception->columns, [['name'], ["index 'categories_name_normalized_unique'"]], true))
        )) {
            throw ValidationException::withMessages(['name' => ['Já existe uma categoria com esse nome.']]);
        }
    }
}
