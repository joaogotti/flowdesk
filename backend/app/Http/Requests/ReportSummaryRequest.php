<?php

namespace App\Http\Requests;

use App\Models\User;
use App\Support\SessionVersion;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;

class ReportSummaryRequest extends FormRequest
{
    public const TIMEZONE = 'America/Sao_Paulo';

    public function authorize(): bool
    {
        $this->assertCurrentAdministrator();

        return true;
    }

    public function assertCurrentAdministrator(): void
    {
        $user = User::query()->find($this->user()?->id);
        SessionVersion::assertCurrent($this, $user);
        if ($user->role !== 'admin' || $user->disabled_at !== null) {
            abort(response()->json(['message' => 'Acesso permitido somente a administradores ativos.'], 403));
        }
    }

    public function rules(): array
    {
        return [
            'start_date' => ['bail', 'sometimes', 'required', 'date_format:Y-m-d', 'regex:/^(?!0000)\d{4}-\d{2}-\d{2}$/D'],
            'end_date' => ['bail', 'sometimes', 'required', 'date_format:Y-m-d', 'regex:/^(?!0000)\d{4}-\d{2}-\d{2}$/D'],
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            if (array_diff(array_keys($this->all()), $this->allowedQueryFields()) || $this->request->count() || $this->allFiles()) {
                $validator->errors()->add('payload', $this->queryFieldsMessage());
            }
            if ($this->query->has('start_date') !== $this->query->has('end_date')) {
                $validator->errors()->add('period', 'Informe as duas datas ou omita ambas para usar os últimos 30 dias.');
            }
            if ($validator->errors()->isNotEmpty() || ! $this->query->has('start_date')) {
                return;
            }
            [$start, $end] = $this->bounds($this->string('start_date')->toString(), $this->string('end_date')->toString());
            if ($end->lte($start)) {
                $validator->errors()->add('end_date', 'A data final deve ser igual ou posterior à data inicial.');
            } elseif ($end->gt($start->addYearNoOverflow()->startOfDay())) {
                $validator->errors()->add('end_date', 'O período deve abranger no máximo um ano de calendário.');
            }
        }];
    }

    protected function allowedQueryFields(): array
    {
        return ['start_date', 'end_date'];
    }

    protected function queryFieldsMessage(): string
    {
        return 'Informe somente start_date e end_date na query string.';
    }

    private function bounds(string $start, string $end): array
    {
        return [CarbonImmutable::parse($start, self::TIMEZONE)->startOfDay(),
            CarbonImmutable::parse($end, self::TIMEZONE)->addDay()->startOfDay()];
    }

    public function period(CarbonImmutable $now): array
    {
        $today = $now->setTimezone(self::TIMEZONE)->startOfDay();
        $startDate = $this->validated('start_date', $today->subDays(29)->format('Y-m-d'));
        $endDate = $this->validated('end_date', $today->format('Y-m-d'));
        [$start, $end] = $this->bounds($startDate, $endDate);

        return ['start_date' => $startDate, 'end_date' => $endDate,
            'start_utc' => $start->utc(), 'end_exclusive_utc' => $end->utc()];
    }

    public function messages(): array
    {
        return ['*.required' => 'Informe uma data válida.', '*.date_format' => 'Use uma data existente no formato AAAA-MM-DD.',
            '*.regex' => 'Use uma data existente no formato AAAA-MM-DD.'];
    }
}
