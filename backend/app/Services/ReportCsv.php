<?php

namespace App\Services;

use RuntimeException;

class ReportCsv
{
    public const HEADERS = ['ID', 'Título', 'Solicitante', 'Responsável atual', 'Categoria', 'Prioridade', 'Status',
        'Criação (UTC)', 'Primeira resposta (UTC)', 'Resolução (UTC)', 'Fechamento (UTC)', 'SLA primeira resposta', 'SLA resolução'];

    public function text(?string $value): string
    {
        if ($value === null || $value === '') {
            return '';
        }
        if (preg_match('//u', $value) !== 1) {
            throw new RuntimeException('Invalid UTF-8 in report.');
        }

        // Always prefix text, rather than trying to enumerate formula/Unicode variants.
        // Control/format characters and Unicode line separators become spaces.
        return "'".preg_replace('/[\p{C}\p{Zl}\p{Zp}]/u', ' ', $value);
    }

    public function write(mixed $stream, array $cells): void
    {
        if (fputcsv($stream, $cells, ';', '"', '', "\r\n") === false) {
            throw new RuntimeException('Cannot write report CSV.');
        }
    }

    public function writeTicket(mixed $stream, array $ticket): void
    {
        $values = [$ticket['title'], $ticket['requester']['name'], $ticket['assignee']['name'] ?? null,
            $ticket['category']['name'], $ticket['priority'], $ticket['status']['name'], $ticket['created_at'],
            $ticket['first_responded_at'], $ticket['resolved_at'], $ticket['closed_at'],
            $ticket['sla']['first_response'], $ticket['sla']['resolution']];
        $this->write($stream, [$ticket['id'], ...array_map($this->text(...), $values)]);
    }
}
