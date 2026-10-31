<?php

namespace App\Support;

use App\Models\User;

class UserProfilePreconditions
{
    public static function assertMatches(User $user, array $validated): void
    {
        // Compare the original bytes, not the normalized replacement values.
        foreach (['name', 'email'] as $field) {
            if (array_key_exists($field, $validated) && $user->{$field} !== $validated['expected_'.$field]) {
                abort(response()->json([
                    'message' => 'Os dados do usuário foram alterados. Atualize os dados antes de tentar novamente.',
                    'code' => 'profile_changed',
                ], 409));
            }
        }
    }
}
