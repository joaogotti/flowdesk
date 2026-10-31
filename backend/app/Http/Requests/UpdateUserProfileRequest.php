<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Support\Str;
use Illuminate\Validation\Validator;

class UpdateUserProfileRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user() !== null;
    }

    protected function prepareForValidation(): void
    {
        if (is_string($this->input('name')) && ! str_contains($this->input('name'), "\0")) {
            $this->merge(['name' => Str::trim($this->input('name'))]);
        }
    }

    public function rules(): array
    {
        return [
            'name' => ['bail', 'required', 'string', 'max:255', 'not_regex:/\x00/u'],
            'expected_name' => ['bail', 'required', 'string', 'max:255', 'not_regex:/\x00/u'],
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            if (array_diff(array_keys($this->all()), ['name', 'expected_name']) !== [] || $this->query->count() || $this->allFiles()) {
                $validator->errors()->add('payload', 'Envie somente name e expected_name no corpo da requisição.');
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
            'expected_name.required' => 'Informe o nome originalmente carregado.',
            'expected_name.string' => 'O nome original deve ser um texto.',
            'expected_name.max' => 'O nome original deve ter no máximo 255 caracteres.',
            'expected_name.not_regex' => 'O nome original contém caracteres inválidos.',
        ];
    }
}
