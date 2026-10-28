<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;

class UpdateCategoryStatusRequest extends FormRequest
{
    public function authorize(): bool
    {
        if ($this->user()?->role !== 'admin') {
            abort(response()->json(['message' => 'Acesso não permitido.'], 403));
        }

        return true;
    }

    public function rules(): array
    {
        return ['is_active' => ['bail', 'required', 'boolean:strict']];
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            if (array_diff(array_keys($this->all()), ['is_active']) !== []) {
                $validator->errors()->add('payload', 'Envie somente o campo is_active.');
            }
        }];
    }

    public function messages(): array
    {
        return [
            'is_active.required' => 'Informe a situação da categoria.',
            'is_active.boolean' => 'A situação da categoria deve ser um booleano (true ou false).',
        ];
    }
}
