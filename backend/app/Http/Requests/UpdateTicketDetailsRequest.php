<?php

namespace App\Http\Requests;

use App\Models\Ticket;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

class UpdateTicketDetailsRequest extends FormRequest
{
    public function authorize(): bool
    {
        $user = $this->user();
        if (! in_array($user->role, ['technician', 'admin'], true)) {
            abort(response()->json(['message' => 'Você não tem permissão para alterar os detalhes.'], 403));
        }

        $id = $this->route('id');
        if (filter_var($id, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) === false) {
            abort(response()->json(['message' => 'Chamado não encontrado.'], 404));
        }
        $ticket = Ticket::query()->visibleTo($user)->whereKey($id)->first(['id', 'assigned_to']);
        if ($ticket === null) {
            abort(response()->json(['message' => 'Chamado não encontrado.'], 404));
        }
        if ($user->role === 'technician' && $ticket->assigned_to !== $user->id) {
            abort(response()->json(['message' => 'Somente o técnico responsável pode alterar os detalhes deste chamado.'], 403));
        }

        return true;
    }

    public function rules(): array
    {
        return [
            'category_id' => ['bail', 'sometimes', 'required', 'integer:strict', 'min:1', Rule::exists('categories', 'id')->where('is_active', true)],
            'priority' => ['bail', 'sometimes', 'required', 'string', Rule::in(['low', 'medium', 'high', 'urgent'])],
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            $fields = array_keys($this->all());
            if (array_intersect($fields, ['category_id', 'priority']) === []) {
                $validator->errors()->add('payload', 'Informe category_id e/ou priority.');
            }
            if (array_diff($fields, ['category_id', 'priority']) !== []) {
                $validator->errors()->add('payload', 'Envie somente os campos category_id e priority.');
            }
        }];
    }

    public function messages(): array
    {
        return [
            'category_id.required' => 'Informe a categoria do chamado.',
            'category_id.integer' => 'A categoria deve ser um ID inteiro válido.',
            'category_id.min' => 'A categoria deve ser um ID inteiro positivo.',
            'category_id.exists' => 'Selecione uma categoria disponível.',
            'priority.required' => 'Informe a prioridade do chamado.',
            'priority.string' => 'Informe uma prioridade válida.',
            'priority.in' => 'Informe uma prioridade válida.',
        ];
    }
}
