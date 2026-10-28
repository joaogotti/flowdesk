<?php

namespace App\Http\Requests;

use App\Models\Ticket;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

class UpdateTicketAssignmentRequest extends FormRequest
{
    public function authorize(): bool
    {
        if (! in_array($this->user()->role, ['technician', 'admin'], true)) {
            abort(response()->json(['message' => 'Você não tem permissão para alterar responsáveis.'], 403));
        }

        $id = $this->route('id');
        if (filter_var($id, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) === false ||
            ! Ticket::query()->visibleTo($this->user())->whereKey($id)->exists()) {
            abort(response()->json(['message' => 'Chamado não encontrado.'], 404));
        }

        return true;
    }

    public function rules(): array
    {
        return [
            'assigned_to' => [
                'bail', 'present', 'nullable', 'integer:strict', 'min:1',
                Rule::exists('users', 'id')->where('role', 'technician')->whereNull('disabled_at'),
            ],
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            // ConvertEmptyStringsToNull não deve transformar uma string JSON em
            // uma solicitação válida de remoção do responsável.
            $original = json_decode($this->getContent(), true);
            if (is_array($original) && is_string($original['assigned_to'] ?? null)) {
                $validator->errors()->add('assigned_to', 'O responsável deve ser um ID inteiro válido ou null.');
            }
            if (array_diff(array_keys($this->all()), ['assigned_to']) !== []) {
                $validator->errors()->add('payload', 'Envie somente o campo assigned_to.');
            }
        }];
    }

    public function messages(): array
    {
        return [
            'assigned_to.present' => 'Informe o responsável ou null para remover a atribuição.',
            'assigned_to.integer' => 'O responsável deve ser um ID inteiro válido.',
            'assigned_to.min' => 'O responsável deve ser um ID inteiro positivo.',
            'assigned_to.exists' => 'Selecione um técnico ativo válido.',
        ];
    }
}
