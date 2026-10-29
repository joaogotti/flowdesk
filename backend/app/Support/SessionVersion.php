<?php

namespace App\Support;

use App\Exceptions\SessionVersionMismatch;
use App\Models\User;
use Illuminate\Http\Request;

class SessionVersion
{
    public const KEY = 'auth_session_version';

    private const SNAPSHOT = 'flowdesk.authenticated_session_version';

    public static function current(User $user): int
    {
        // Missing migration is not a legacy session. Fail closed until deployment.
        if (! array_key_exists('session_version', $user->getAttributes())) {
            abort(response()->json(['message' => 'Autenticação temporariamente indisponível.'], 503));
        }

        return $user->session_version;
    }

    public static function capture(Request $request): void
    {
        $version = $request->hasSession() ? $request->session()->get(self::KEY, 0) : 0;
        if (! is_int($version) || $version < 0) {
            throw new SessionVersionMismatch;
        }
        // Missing legacy session values remain zero; never adopt the database version.
        $request->attributes->set(self::SNAPSHOT, $version);
    }

    public static function assertCurrent(Request $request, ?User $user): void
    {
        if ($user === null || ! $request->attributes->has(self::SNAPSHOT) ||
            $request->attributes->get(self::SNAPSHOT) !== self::current($user)) {
            throw new SessionVersionMismatch;
        }
    }
}
