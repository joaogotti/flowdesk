<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class IndexTicketRequest extends FormRequest
{
    public function authorize(): bool
    {
        return in_array($this->user()?->role, ['requester', 'technician', 'admin'], true);
    }

    public function rules(): array
    {
        return [
            'status' => ['sometimes', 'required', 'string', Rule::exists('ticket_statuses', 'code')],
            'priority' => ['sometimes', 'required', 'string', Rule::in(['low', 'medium', 'high', 'urgent'])],
            'category_id' => ['sometimes', 'required', 'integer', 'min:1', Rule::exists('categories', 'id')],
            'search' => ['sometimes', 'required', 'string', 'max:255'],
            'assigned_to' => $this->user()?->role === 'admin'
                ? ['sometimes', 'required', 'integer', 'min:1', Rule::exists('users', 'id')->where('role', 'technician')]
                : ['missing'],
            'page' => ['sometimes', 'required', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'required', 'integer', 'min:1', 'max:100'],
        ];
    }

    public function messages(): array
    {
        return [
            '*.required' => 'Informe um valor válido para o filtro.',
            '*.string' => 'O filtro deve ser um texto.',
            '*.integer' => 'O filtro deve ser um número inteiro.',
            '*.min' => 'O valor deve ser maior ou igual a 1.',
            'status.exists' => 'Informe um status válido.',
            'priority.in' => 'Informe uma prioridade válida.',
            'category_id.exists' => 'Informe uma categoria existente.',
            'assigned_to.exists' => 'Informe um técnico existente.',
            'assigned_to.missing' => 'Este filtro está disponível somente para administradores.',
            'search.max' => 'A pesquisa deve ter no máximo 255 caracteres.',
            'per_page.max' => 'Solicite no máximo 100 chamados por página.',
        ];
    }
}
