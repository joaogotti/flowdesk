<?php

namespace App\Services;

use Closure;
use Illuminate\Database\Connection;
use LogicException;

class ReportReadSnapshot
{
    public static function run(Connection $connection, Closure $read): mixed
    {
        if ($connection->getDriverName() === 'pgsql' && $connection->transactionLevel() !== 0) {
            throw new LogicException('Reports require an outermost read snapshot.');
        }

        return $connection->transaction(function () use ($connection, $read) {
            if ($connection->getDriverName() === 'pgsql') {
                $connection->statement('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
            }

            return $read();
        });
    }
}
