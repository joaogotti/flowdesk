<?php

namespace App\Http\Requests;

use App\Models\Ticket;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Support\Str;

class StoreTicketCommentRequest extends FormRequest
{
    public function authorize(): bool
    {
        $id = $this->route('id');
        // Verifica a visibilidade antes de validar o conteúdo, sem revelar chamados restritos.
        if (filter_var($id, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) === false ||
            ! Ticket::query()->visibleTo($this->user())->whereKey($id)->exists()) {
            abort(response()->json(['message' => 'Chamado não encontrado.'], 404));
        }

        if ($this->user()->role === 'requester' && $this->input('is_internal') === true) {
            abort(response()->json(['message' => 'Somente técnicos e administradores podem criar comentários internos.'], 403));
        }

        return true;
    }

    protected function prepareForValidation(): void
    {
        if (is_string($this->input('body'))) {
            $this->merge(['body' => Str::trim($this->input('body'))]);
        }
    }

    public function rules(): array
    {
        return [
            'body' => ['bail', 'required', 'string', 'max:10000', 'not_regex:/\x00/'],
            'is_internal' => ['sometimes', 'boolean:strict'],
        ];
    }

    public function messages(): array
    {
        return [
            'body.required' => 'Informe o conteúdo do comentário.',
            'body.string' => 'O comentário deve ser um texto.',
            'body.max' => 'O comentário deve ter no máximo 10.000 caracteres.',
            'body.not_regex' => 'O comentário contém um caractere inválido.',
            'is_internal.boolean' => 'Informe true ou false para indicar se o comentário é interno.',
        ];
    }
}
