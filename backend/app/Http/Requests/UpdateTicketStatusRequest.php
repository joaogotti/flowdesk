<?php

namespace App\Http\Requests;

use App\Models\Ticket;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

class UpdateTicketStatusRequest extends FormRequest
{
    public function authorize(): bool
    {
        $user = $this->user();
        if (! in_array($user->role, ['technician', 'admin'], true)) {
            abort(response()->json(['message' => 'Você não tem permissão para alterar o status.'], 403));
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
            abort(response()->json(['message' => 'Somente o técnico responsável pode alterar o status deste chamado.'], 403));
        }

        return true;
    }

    public function rules(): array
    {
        return [
            'status' => [
                'bail', 'required', 'string',
                Rule::in(['open', 'in_progress', 'waiting_requester', 'resolved', 'closed', 'cancelled']),
                Rule::exists('ticket_statuses', 'code'),
            ],
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            if (array_diff(array_keys($this->all()), ['status']) !== []) {
                $validator->errors()->add('payload', 'Envie somente o campo status.');
            }
        }];
    }

    public function messages(): array
    {
        return [
            'status.required' => 'Informe o status desejado.',
            'status.string' => 'O status deve ser informado pelo código.',
            'status.in' => 'Informe um código de status válido.',
            'status.exists' => 'O status informado não está disponível.',
        ];
    }
}
