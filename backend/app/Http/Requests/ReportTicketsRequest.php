<?php

namespace App\Http\Requests;

use Illuminate\Validation\Rule;

class ReportTicketsRequest extends ReportSummaryRequest
{
    public function filters(): array
    {
        $filters = array_intersect_key($this->validated(), array_flip(['assigned_to', 'category_id', 'priority', 'status']));
        foreach (['assigned_to', 'category_id'] as $field) {
            if (isset($filters[$field]) && $filters[$field] !== 'unassigned') {
                $filters[$field] = (int) $filters[$field];
            }
        }

        return $filters;
    }

    protected function allowedQueryFields(): array
    {
        return ['start_date', 'end_date', 'assigned_to', 'category_id', 'priority', 'status', 'page', 'per_page'];
    }

    protected function queryFieldsMessage(): string
    {
        return 'Informe somente '.implode(', ', $this->allowedQueryFields()).' na query string.';
    }

    public function rules(): array
    {
        return [...parent::rules(),
            'assigned_to' => $this->input('assigned_to') === 'unassigned'
                ? ['sometimes', 'required', Rule::in(['unassigned'])]
                : ['bail', 'sometimes', 'required', 'integer', 'min:1', 'max:'.PHP_INT_MAX, Rule::exists('users', 'id')],
            'category_id' => ['bail', 'sometimes', 'required', 'integer', 'min:1', 'max:'.PHP_INT_MAX, Rule::exists('categories', 'id')],
            'priority' => ['bail', 'sometimes', 'required', 'string', Rule::in(['low', 'medium', 'high', 'urgent'])],
            'status' => ['bail', 'sometimes', 'required', 'string', 'max:30', Rule::exists('ticket_statuses', 'code')],
            'page' => ['bail', 'sometimes', 'required', 'integer', 'min:1', 'max:1000000'],
            'per_page' => ['bail', 'sometimes', 'required', 'integer', 'min:1', 'max:100'],
        ];
    }

    public function messages(): array
    {
        return [...parent::messages(), 'assigned_to.required' => 'Informe um responsável ou unassigned.',
            'category_id.required' => 'Informe uma categoria.', 'priority.required' => 'Informe uma prioridade.',
            'status.required' => 'Informe um status.', 'page.required' => 'Informe a página.', 'per_page.required' => 'Informe o tamanho da página.',
            '*.integer' => 'Informe um número inteiro válido.', '*.exists' => 'O valor do filtro não existe.',
            '*.min' => 'Informe um valor maior ou igual a 1.', '*.max' => 'O valor excede o limite permitido.',
            'priority.in' => 'Informe uma prioridade válida.'];
    }
}
