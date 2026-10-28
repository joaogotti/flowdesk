<?php

namespace App\Http\Requests;

use App\Models\User;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

class UpdateAdminUserRoleRequest extends FormRequest
{
    public function authorize(): bool
    {
        if ($this->user()?->role !== 'admin') {
            abort(response()->json(['message' => 'Acesso não permitido.'], 403));
        }
        $id = filter_var($this->route('user'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($id === false) {
            abort(response()->json(['message' => 'Usuário não encontrado.'], 404));
        }
        if ($id === $this->user()->id) {
            abort(response()->json(['message' => 'Não é permitido alterar o próprio perfil.'], 403));
        }
        if (! User::query()->whereKey($id)->exists()) {
            abort(response()->json(['message' => 'Usuário não encontrado.'], 404));
        }

        return true;
    }

    public function rules(): array
    {
        return [
            'role' => ['bail', 'required', 'string', Rule::in(['requester', 'technician', 'admin'])],
            'expected_role' => ['bail', 'required', 'string', Rule::in(['requester', 'technician', 'admin'])],
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            if ($this->query->count() > 0 || array_diff(array_keys($this->all()), ['role', 'expected_role']) !== []) {
                $validator->errors()->add('payload', 'Envie somente role e expected_role no corpo da requisição.');
            }
        }];
    }

    public function messages(): array
    {
        return [
            'role.required' => 'Informe o novo perfil.',
            'expected_role.required' => 'Informe o perfil atual esperado.',
            '*.string' => 'O perfil deve ser um texto.',
            '*.in' => 'Informe um perfil válido: requester, technician ou admin.',
        ];
    }
}
