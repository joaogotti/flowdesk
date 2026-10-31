<?php

namespace App\Http\Requests;

use App\Models\User;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

class UpdateAdminUserRequest extends StoreAdminUserRequest
{
    protected function prepareForValidation(): void
    {
        $name = $this->input('name');
        parent::prepareForValidation();
        if (is_string($name) && str_contains($name, "\0")) {
            $this->merge(['name' => $name]);
        }
    }

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
            'expected_name' => ['bail', Rule::requiredIf($this->exists('name')), Rule::prohibitedIf(! $this->exists('name')), 'string', 'max:255', 'not_regex:/\x00/u'],
            'expected_email' => ['bail', Rule::requiredIf($this->exists('email')), Rule::prohibitedIf(! $this->exists('email')), 'string', 'max:255', 'not_regex:/\x00/u'],
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            $keys = array_keys($this->all());
            if (array_diff($keys, ['name', 'email', 'expected_name', 'expected_email']) !== [] || $this->query->count() || $this->allFiles()) {
                $validator->errors()->add('payload', 'Envie somente name, email e suas precondições no corpo da requisição.');
            }
            if (array_intersect($keys, ['name', 'email']) === []) {
                $validator->errors()->add('payload', 'Informe ao menos name ou email.');
            }
            foreach (['name', 'email'] as $field) {
                if ($this->exists('expected_'.$field) && ! $this->exists($field)) {
                    $validator->errors()->add('expected_'.$field, 'Envie a precondição somente com o campo correspondente.');
                }
            }
        }];
    }

    public function messages(): array
    {
        return [...parent::messages(),
            'expected_name.required' => 'Informe o nome originalmente carregado.',
            'expected_email.required' => 'Informe o e-mail originalmente carregado.',
            'expected_*.string' => 'A precondição deve ser um texto.',
            'expected_*.max' => 'A precondição deve ter no máximo 255 caracteres.',
            'expected_*.not_regex' => 'A precondição contém caracteres inválidos.',
        ];
    }
}
