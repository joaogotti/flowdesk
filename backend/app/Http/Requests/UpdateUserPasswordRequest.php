<?php

namespace App\Http\Requests;

use App\Support\UserPasswordPolicy;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;

class UpdateUserPasswordRequest extends FormRequest
{
    public function authorize(): bool
    {
        abort_unless($this->hasSession(), 419, 'Inicialize a sessão e a proteção CSRF antes de continuar.');

        return $this->user() !== null;
    }

    public function rules(): array
    {
        // These standard field names are excluded from Laravel's TrimStrings/dontFlash.
        return [
            'current_password' => UserPasswordPolicy::valueRules(),
            'password' => UserPasswordPolicy::newPasswordRules(),
            'password_confirmation' => UserPasswordPolicy::valueRules(),
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            if (array_diff(array_keys($this->all()), ['current_password', 'password', 'password_confirmation']) !== [] || $this->query->count() || $this->allFiles()) {
                $validator->errors()->add('payload', 'Envie somente senha atual, nova senha e confirmação no corpo da requisição.');
            }
        }];
    }

    public function messages(): array
    {
        return [
            'current_password.required' => 'Informe a senha atual.',
            'password.required' => 'Informe a nova senha.',
            'password_confirmation.required' => 'Confirme a nova senha.',
            '*.string' => 'A senha deve ser um texto.',
            '*.not_regex' => 'A senha contém caracteres inválidos.',
            'password.min' => 'A nova senha deve ter pelo menos 12 caracteres.',
            'password.mixed' => 'A nova senha deve conter letras maiúsculas e minúsculas.',
            'password.numbers' => 'A nova senha deve conter um número.',
            'password.symbols' => 'A nova senha deve conter um símbolo.',
            'password.confirmed' => 'A confirmação da senha não corresponde.',
        ];
    }
}
