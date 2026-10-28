<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Support\Str;
use Illuminate\Validation\Validator;

class StoreCategoryRequest extends FormRequest
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
        if (is_string($this->input('name'))) {
            $this->merge(['name' => Str::trim($this->input('name'))]);
        }
    }

    public function rules(): array
    {
        return ['name' => ['bail', 'required', 'string', 'max:100', 'not_regex:/\x00/u']];
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            if (array_diff(array_keys($this->all()), ['name']) !== []) {
                $validator->errors()->add('payload', 'Envie somente o campo name.');
            }
        }];
    }

    public function messages(): array
    {
        return [
            'name.required' => 'Informe o nome da categoria.',
            'name.string' => 'O nome da categoria deve ser um texto.',
            'name.max' => 'O nome da categoria deve ter no máximo 100 caracteres.',
            'name.not_regex' => 'O nome da categoria contém caracteres inválidos.',
        ];
    }
}
