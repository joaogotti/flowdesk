<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

class IndexAdminUserRequest extends FormRequest
{
    public function authorize(): bool
    {
        if ($this->user()?->role !== 'admin') {
            abort(response()->json(['message' => 'Acesso não permitido.'], 403));
        }

        return true;
    }

    public function validationData(): array
    {
        return $this->query();
    }

    public function rules(): array
    {
        return [
            'search' => ['sometimes', 'required', 'string', 'max:255', 'not_regex:/\x00/'],
            'role' => ['sometimes', 'required', 'string', Rule::in(['requester', 'technician', 'admin'])],
            'status' => ['sometimes', 'required', 'string', Rule::in(['active', 'disabled'])],
            'page' => ['sometimes', 'required', 'integer', 'min:1', 'max:1000000'],
            'per_page' => ['sometimes', 'required', 'integer', 'min:1', 'max:100'],
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            if (array_diff(array_keys($this->query()), ['search', 'role', 'status', 'page', 'per_page']) !== []) {
                $validator->errors()->add('query', 'Utilize somente os parâmetros search, role, status, page e per_page.');
            }
        }];
    }

    public function messages(): array
    {
        return [
            '*.required' => 'Informe um valor válido para o filtro.',
            '*.string' => 'O filtro deve ser um texto.',
            '*.integer' => 'O filtro deve ser um número inteiro.',
            '*.min' => 'O valor deve ser maior ou igual a 1.',
            'search.max' => 'A pesquisa deve ter no máximo 255 caracteres.',
            'search.not_regex' => 'A pesquisa contém caracteres inválidos.',
            'role.in' => 'Informe um perfil válido: requester, technician ou admin.',
            'status.in' => 'Informe uma situação válida: active ou disabled.',
            'page.max' => 'Solicite uma página de até 1000000.',
            'per_page.max' => 'Solicite no máximo 100 usuários por página.',
        ];
    }
}
