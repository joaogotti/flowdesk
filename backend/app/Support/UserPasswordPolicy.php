<?php

namespace App\Support;

use Closure;
use Illuminate\Validation\Rules\Password;

class UserPasswordPolicy
{
    public static function valueRules(): array
    {
        return ['bail', 'required', 'string', 'not_regex:/\x00/u', function (string $attribute, mixed $value, Closure $fail): void {
            // bcrypt's limit is in bytes, not Unicode characters.
            if (strlen($value) > 72) {
                $fail('A senha deve ter no máximo 72 bytes.');
            }
        }];
    }

    public static function newPasswordRules(): array
    {
        return [...self::valueRules(), Password::min(12)->mixedCase()->numbers()->symbols(), 'confirmed'];
    }
}
