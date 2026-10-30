<?php

namespace App\Http\Requests;

use App\Models\Ticket;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;

class StoreTicketAttachmentRequest extends FormRequest
{
    public function authorize(): bool
    {
        $id = $this->route('ticket');
        if (filter_var($id, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) === false ||
            ! Ticket::query()->visibleTo($this->user())->whereKey($id)->exists()) {
            abort(response()->json(['message' => 'Chamado não encontrado.'], 404));
        }

        return true;
    }

    public function rules(): array
    {
        return ['file' => ['bail', 'required', 'file', 'max:5120']];
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            if ($this->query->count() || array_diff(array_keys($this->all()), ['file']) !== [] ||
                array_keys($this->allFiles()) !== ['file']) {
                $validator->errors()->add('file', 'Envie somente um arquivo no campo file.');
            }
        }];
    }

    public function messages(): array
    {
        return ['file.required' => 'Selecione um arquivo.', 'file.file' => 'Envie um arquivo válido.',
            'file.uploaded' => 'Não foi possível receber o arquivo. O limite é 5 MiB.', 'file.max' => 'O arquivo deve ter no máximo 5 MiB.'];
    }
}
