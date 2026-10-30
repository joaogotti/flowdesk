<?php

namespace App\Services;

use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Throwable;

class ReportTicketExport
{
    public const LIMIT = 5000;

    public function __construct(private ReportTickets $tickets, private ReportCsv $csv) {}

    public function generate(CarbonImmutable $start, CarbonImmutable $end, CarbonImmutable $now, array $filters): mixed
    {
        // Only serialized bytes are buffered; above 1 MiB PHP spills to an anonymous
        // private OS temporary file, never the attachments disk or a public directory.
        $stream = fopen('php://temp/maxmemory:1048576', 'w+b');
        if ($stream === false) {
            throw new RuntimeException('Cannot prepare report.');
        }
        try {
            ReportReadSnapshot::run(DB::connection(), function () use ($start, $end, $now, $filters, $stream): void {
                $query = $this->tickets->query($start, $end, $now, $filters);
                $count = DB::query()->fromSub((clone $query)->reorder()->limit(self::LIMIT + 1), 'export_limit')->count();
                if ($count > self::LIMIT) {
                    abort(response()->json(['message' => 'A exportação permite no máximo 5.000 chamados. Restrinja os filtros e tente novamente.',
                        'code' => 'export_limit_exceeded', 'limit' => self::LIMIT], 422));
                }
                if (fwrite($stream, "\xEF\xBB\xBF") !== 3) {
                    throw new RuntimeException('Cannot write report encoding.');
                }
                $this->csv->write($stream, ReportCsv::HEADERS);
                if ($count === 0) {
                    return;
                }
                $lastDate = $lastId = null;
                $written = 0;
                do {
                    $batch = clone $query;
                    if ($lastId !== null) {
                        $batch->where(function ($q) use ($lastDate, $lastId): void {
                            $q->where('records.created_at', '<', $lastDate)
                                ->orWhere(fn ($q) => $q->where('records.created_at', '=', $lastDate)->where('records.id', '<', $lastId));
                        });
                    }
                    $rows = $batch->limit(200)->get();
                    foreach ($rows as $row) {
                        $this->csv->writeTicket($stream, $this->tickets->publicData($row));
                        $lastDate = $row->created_at;
                        $lastId = $row->id;
                        $written++;
                    }
                } while ($rows->count() === 200 && $written < $count);
                if ($written !== $count) {
                    throw new RuntimeException('Report snapshot count mismatch.');
                }
            });
            if (! rewind($stream)) {
                throw new RuntimeException('Cannot rewind report.');
            }

            return $stream;
        } catch (Throwable $exception) {
            fclose($stream);
            throw $exception;
        }
    }
}
