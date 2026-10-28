<?php

namespace App\Http\Requests;

use App\Models\User;
use Illuminate\Validation\Validator;

class UpdateAdminUserRequest extends StoreAdminUserRequest
{
    public function authorize(): bool
    {
        parent::authorize();

        $id = filter_var($this->route('user'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($id === false || ! User::query()->whereKey($id)->exists()) {
            abort(response()->json(['message' => 'Usuário não encontrado.'], 404));
        }

        return true;
    }

    public function rules(): array
    {
        return [
            'name' => ['sometimes', 'bail', 'required', 'string', 'max:255', 'not_regex:/\x00/u'],
            'email' => ['sometimes', ...$this->emailRules((int) $this->route('user'))],
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            $keys = array_keys($this->all());
            if (array_diff($keys, ['name', 'email']) !== []) {
                $validator->errors()->add('payload', 'Envie somente name e email.');
            }
            if (array_intersect($keys, ['name', 'email']) === []) {
                $validator->errors()->add('payload', 'Informe ao menos name ou email.');
            }
        }];
    }
}
