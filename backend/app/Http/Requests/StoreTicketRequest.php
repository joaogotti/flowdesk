<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

class StoreTicketRequest extends FormRequest
{
    public function authorize(): bool
    {
        return in_array($this->user()?->role, ['requester', 'technician', 'admin'], true);
    }

    public function rules(): array
    {
        return [
            'title' => ['bail', 'required', 'string', 'max:255'],
            'description' => ['bail', 'required', 'string', 'max:10000'],
            'category_id' => ['bail', 'required', 'integer:strict', 'min:1', Rule::exists('categories', 'id')->where('is_active', true)],
            'priority' => ['required', 'string', Rule::in(['low', 'medium', 'high', 'urgent'])],
        ];
    }

    protected function prepareForValidation(): void
    {
        $normalized = [];
        foreach (['title', 'description'] as $field) {
            if (is_string($this->input($field))) {
                $normalized[$field] = trim($this->input($field));
            }
        }
        $this->merge($normalized);
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            if (array_diff(array_keys($this->all()), ['title', 'description', 'category_id', 'priority']) !== []) {
                $validator->errors()->add('payload', 'Envie somente title, description, category_id e priority.');
            }
        }];
    }

    public function messages(): array
    {
        return [
            'title.required' => 'Informe o título do chamado.',
            'title.string' => 'O título deve ser um texto.',
            'title.max' => 'O título deve ter no máximo 255 caracteres.',
            'description.required' => 'Informe a descrição do chamado.',
            'description.string' => 'A descrição deve ser um texto.',
            'description.max' => 'A descrição deve ter no máximo 10.000 caracteres.',
            'category_id.required' => 'Informe a categoria do chamado.',
            'category_id.integer' => 'Informe uma categoria válida.',
            'category_id.min' => 'A categoria deve ser um ID inteiro positivo.',
            'category_id.exists' => 'Selecione uma categoria disponível.',
            'priority.required' => 'Informe a prioridade do chamado.',
            'priority.string' => 'Informe uma prioridade válida.',
            'priority.in' => 'Informe uma prioridade válida.',
        ];
    }
}
