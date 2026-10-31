<?php

namespace App\Http\Requests;

use App\Models\User;
use App\Support\UserPasswordPolicy;
use Closure;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

class StoreAdminUserRequest extends FormRequest
{
    public function authorize(): bool
    {
        if ($this->user()?->role !== 'admin') {
            abort(response()->json(['message' => 'Acesso não permitido.'], 403));
        }

        return true;
    }

    protected function prepareForValidation(): void
    {
        foreach (['name', 'email'] as $field) {
            if (is_string($this->input($field))) {
                // Keep invalid email bytes intact until the shared validation rejects them.
                if ($field === 'email' && str_contains($this->input($field), "\0")) {
                    continue;
                }
                $value = Str::trim($this->input($field));
                $this->merge([$field => $field === 'email' ? Str::lower($value) : $value]);
            }
        }
    }

    public function rules(): array
    {
        return [
            'name' => ['bail', 'required', 'string', 'max:255', 'not_regex:/\x00/u'],
            'email' => $this->emailRules(),
            'password' => UserPasswordPolicy::newPasswordRules(),
            'password_confirmation' => ['required', 'string'],
            'role' => ['bail', 'required', 'string', Rule::in(['requester', 'technician'])],
        ];
    }

    protected function emailRules(?int $ignoreUserId = null): array
    {
        return ['bail', 'required', 'string', 'max:255', 'not_regex:/\x00/u', 'email', function (string $attribute, mixed $value, Closure $fail) use ($ignoreUserId): void {
            $query = User::query()->whereRaw('LOWER(email) = ?', [$value]);
            if ($ignoreUserId !== null) {
                $query->where('id', '!=', $ignoreUserId);
            }
            if ($query->exists()) {
                $fail('Já existe um usuário com esse e-mail.');
            }
        }];
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            if (array_diff(array_keys($this->all()), ['name', 'email', 'password', 'password_confirmation', 'role']) !== []) {
                $validator->errors()->add('payload', 'Envie somente name, email, password, password_confirmation e role.');
            }
        }];
    }

    public function messages(): array
    {
        return [
            'name.required' => 'Informe o nome completo.',
            'name.string' => 'O nome deve ser um texto.',
            'name.max' => 'O nome deve ter no máximo 255 caracteres.',
            'name.not_regex' => 'O nome contém caracteres inválidos.',
            'email.required' => 'Informe o e-mail.',
            'email.string' => 'O e-mail deve ser um texto.',
            'email.max' => 'O e-mail deve ter no máximo 255 caracteres.',
            'email.email' => 'Informe um e-mail válido.',
            'email.not_regex' => 'Informe um e-mail válido.',
            'password.required' => 'Informe a senha inicial.',
            'password.string' => 'A senha deve ser um texto.',
            'password.not_regex' => 'A senha contém caracteres inválidos.',
            'password.min' => 'A senha deve ter pelo menos 12 caracteres.',
            'password.mixed' => 'A senha deve conter letras maiúsculas e minúsculas.',
            'password.numbers' => 'A senha deve conter um número.',
            'password.symbols' => 'A senha deve conter um símbolo.',
            'password.confirmed' => 'A confirmação da senha não corresponde.',
            'password_confirmation.required' => 'Confirme a senha inicial.',
            'password_confirmation.string' => 'A confirmação da senha deve ser um texto.',
            'role.required' => 'Informe o perfil.',
            'role.string' => 'O perfil deve ser um texto.',
            'role.in' => 'Selecione Solicitante ou Técnico.',
        ];
    }
}
