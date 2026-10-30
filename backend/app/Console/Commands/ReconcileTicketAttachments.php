<?php

namespace App\Console\Commands;

use App\Services\TicketAttachments;
use Illuminate\Console\Command;

class ReconcileTicketAttachments extends Command
{
    protected $signature = 'attachments:reconcile {--limit=100 : Maximum reservations per execution (1-1000)}';

    protected $description = 'Reconcile expired or failed attachment reservations without deleting ready attachments';

    public function handle(TicketAttachments $attachments): int
    {
        $limit = filter_var($this->option('limit'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 1000]]);
        if ($limit === false) {
            $this->error('O limite deve estar entre 1 e 1000.');

            return self::FAILURE;
        }
        $result = $attachments->reconcile($limit);
        $this->info(json_encode($result, JSON_THROW_ON_ERROR));

        return $result['errors'] ? self::FAILURE : self::SUCCESS;
    }
}
