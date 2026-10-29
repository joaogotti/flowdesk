<?php

namespace App\Http\Requests;

use App\Models\User;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;

class UpdateAdminUserStatusRequest extends FormRequest
{
    public function authorize(): bool
    {
        if ($this->user()?->role !== 'admin') {
            abort(response()->json(['message' => 'Acesso não permitido.'], 403));
        }
        $id = filter_var($this->route('user'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($id === false || ! User::query()->whereKey($id)->exists()) {
            abort(response()->json(['message' => 'Usuário não encontrado.'], 404));
        }
        if ($id === $this->user()->id && $this->input('is_active') === false) {
            abort(response()->json(['message' => 'Não é permitido desativar a própria conta.'], 403));
        }

        return true;
    }

    public function rules(): array
    {
        return [
            'is_active' => ['bail', 'required', 'boolean:strict'],
            'expected_is_active' => ['bail', 'required', 'boolean:strict'],
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            if ($this->query->count() > 0 || array_diff(array_keys($this->all()), ['is_active', 'expected_is_active']) !== []) {
                $validator->errors()->add('payload', 'Envie somente is_active e expected_is_active no corpo da requisição.');
            }
        }];
    }

    public function messages(): array
    {
        return [
            'is_active.required' => 'Informe a situação desejada.',
            'expected_is_active.required' => 'Informe a situação atual esperada.',
            '*.boolean' => 'Informe true ou false para a situação.',
        ];
    }
}
