# Anexos de chamados — backend V1

A migration `2026_10_29_210000_create_ticket_attachments_table.php` foi aplicada ao PostgreSQL de desenvolvimento em 29/10/2026, no lote 14, após backup completo validado por restauração isolada. A auditoria posterior confirmou o anexo enviado manualmente e a integridade entre banco e armazenamento privado. Novos ambientes exigem o procedimento autorizado de backup/implantação antes de utilizar o fluxo.

## Contrato

Todas as rotas exigem Sanctum, conta ativa e versão de sessão válida:

- `GET /api/tickets/{ticket}/attachments`: 200, `data` com os anexos `ready`, ordenados por criação/ID (até 10).
- `POST /api/tickets/{ticket}/attachments`: multipart com somente um campo `file`; 201 após confirmar armazenamento e histórico. Query e campos adicionais são rejeitados.
- `GET /api/tickets/{ticket}/attachments/{attachment}/download`: 200 com stream autenticado, `Content-Disposition: attachment`, MIME validado, tamanho, `nosniff`, CSP sandbox e `Cache-Control: private, no-store`. Não há URL pública ou temporária.

Metadados públicos: `id`, `original_name`, `mime_type`, `size_bytes`, `uploaded_by` (ID/nome), `created_at` e `confirmed_at`. Chave física, raiz, reservas, estados de limpeza e checksum não são expostos. O nome exibido do autor segue o relacionamento atual com usuários, assim como os comentários existentes.

401 indica falta de autenticação ou `session_revoked`; 403 indica operação proibida; 404 não distingue chamado/anexo inexistente, fora do escopo ou não confirmado; 419 mantém CSRF. Erros de arquivo/payload retornam 422. Corpo acima do limite HTTP/PHP pode retornar 413 ou erro de upload antes da aplicação.

409 inclui `code`: `ticket_not_writable`, `attachment_limit_reached` ou `attachment_reservation_expired`. 429 inclui `Retry-After`. Indisponibilidade de esquema, arquivo ou armazenamento retorna 503 com `attachment_unavailable`, sem SQL ou caminho físico na resposta. Uma resposta perdida ou 503 após commit incerto exige consultar a listagem, sem repetir upload automaticamente.

## Regras e validação

O acesso acompanha `Ticket::visibleTo`: solicitante somente seus chamados; técnico seus atribuídos e os sem responsável; administrador todos. Autoria do arquivo não concede acesso permanente. Anexos são compartilhados com quem tem acesso ao chamado; não há anexos internos ou associação com comentários na V1. A futura associação com comentários internos exigirá nova autorização e integridade do vínculo.

Upload só em `open`, `in_progress` e `waiting_requester`. Listagem/download continuam disponíveis em estados finais, conforme o escopo atual. Não há exclusão ou substituição por endpoint.

São aceitos JPG/JPEG, PNG, PDF e TXT UTF-8, não vazios, até 5.242.880 bytes. Extensão e MIME detectado devem corresponder. Imagens exigem cabeçalho/dimensões válidos, até 5.000 pixels por lado e 10 megapixels. TXT rejeita binários, UTF-8 inválido e controles exceto tabulação/quebras de linha. PDF exige MIME/cabeçalho compatíveis. Nomes são normalizados em NFC e limitados a 200 bytes, sem controles/NUL, caminhos, nomes ocultos e extensões executáveis disfarçadas. O nome físico é aleatório e independente do nome original.

Isso não certifica ausência de malware: não há antivírus, reprocessamento de imagens ou saneamento integral de PDF. O download é forçado como arquivo, sem visualizador embutido. O host continua sendo confiável; não permitir edição manual de chaves ou conteúdo dos arquivos confirmados.

## Reserva, locks e falhas

O chamado recebe `FOR UPDATE` antes do `FOR SHARE` do usuário. Dentro da transação são revalidados perfil, atividade, versão imutável da sessão, visibilidade e estado do chamado. A soma de anexos `pending` e `ready` deve caber em 10 registros e 26.214.400 bytes. Reservas expiradas ainda consomem quota até serem reconciliadas; uma simples passagem de tempo não autoriza reutilizar seu espaço.

O protocolo utiliza o isolamento padrão `READ COMMITTED` do PostgreSQL, para observar a reserva confirmada pelo concorrente após a espera pelo lock do chamado. Alterar esse isolamento exige reavaliar a admissão de quotas e seus testes.

A reserva `pending` é confirmada em transação curta com nome, MIME, tamanho, SHA-256, chave única, criação e expiração após 24 horas. Em seguida, sem locks/transações de banco, o processo adquire um `flock` exclusivo por chave no diretório privado `.locks`, grava o arquivo e verifica tamanho/hash. Antes da gravação, verifica novamente se a reserva ainda está pendente e válida.

A confirmação abre nova transação na mesma ordem chamado → usuário → anexo. Revalida todas as permissões e expiração; altera a reserva para `ready`, registra `attachment_added` e atualiza somente `tickets.updated_at`. Status, responsável, primeira resposta e SLA permanecem intactos. O histórico guarda apenas ID do anexo, ator e data. A filtragem atual do histórico para solicitantes permanece intacta; o frontend apresenta o evento como “Anexo adicionado”.

O lock de arquivo é mantido até terminar confirmação/compensação. Não se aguarda esse lock mantendo locks de banco. A reconciliação tenta obtê-lo sem espera, evitando apagar dados enquanto um escritor está ativo. Todos os processos precisam usar o mesmo filesystem local compartilhado e o mesmo protocolo. Os arquivos de lock, com modo 0600 em diretório 0700, são conservados para não criar locks concorrentes em inodes diferentes; seu espaço não integra a quota de conteúdo.

Falhas deixam a reserva `failed` e removem seu arquivo somente depois de confirmar esse estado no banco. `cleaned_at` marca limpeza concluída e permite repetir exclusões que falharam. Se houver incerteza sobre o commit ou indisponibilidade do banco, preservar o arquivo e deixar a reconciliação decidir. Uma reserva já `ready` nunca é apagada pela compensação. Não existe atomicidade distribuída entre PostgreSQL e disco; estados duráveis, verificação e compensação tratam as janelas de falha.

Downloads fazem autorização curta, abrem/verificam o arquivo sem locks de banco e reautorizam antes de enviar bytes. O arquivo pronto é imutável e não é removido pelo reconciliador. Uma transferência já autorizada pode concluir depois de uma mudança de acesso; não se revogam bytes já entregues.

## Frequência e reconciliação

O limite é de 10 tentativas por minuto por usuário, incluindo arquivos/payloads inválidos após autenticação. No PostgreSQL, `pg_advisory_xact_lock(706405, hashtext(chave-do-usuário))` serializa a admissão do limitador antes de qualquer lock de chamado/usuário. Colisões de hash apenas serializam usuários adicionais. Esse namespace é independente do mutex de administração de usuários. É necessário cache compartilhado entre workers; o desenvolvimento usa o cache de banco existente. Cache em memória `array` destina-se a testes em um único processo.

`php artisan attachments:reconcile --limit=100` processa reservas expiradas e limpezas incompletas; limite permitido 1–1000. Um agendamento horário está registrado com proteção contra sobreposição e verificação prévia da existência da tabela. É necessário ativar o scheduler pelo procedimento de operação após a migration; o contêiner atual executa somente o servidor HTTP. Não foi iniciado scheduler nem executada reconciliação no desenvolvimento nesta etapa. Monitorar backlog/erros e ajustar o tamanho do lote quando necessário.

Não há quota global de disco nesta etapa. Os limites por chamado e a frequência reduzem abuso, mas não substituem monitoramento de espaço/inodes, capacidade e backups. SQL externo e futuros escritores devem respeitar os locks; constraints não implementam sozinhas a quota agregada.

## Implantação e testes

Aplicar a migration depende de autorização separada. Ela cria somente `ticket_attachments`, com referências restritivas a chamados/usuários, índice único da chave, índices de quota/limpeza e CHECKs PostgreSQL de estado, tamanho, MIME, chave, nome e datas. O `down()` remove metadados, não arquivos: não é reversão segura após começar a receber anexos. Backup/restauração devem abranger banco e volume conforme `attachment-storage.md`.

`TicketAttachmentsTest` usa SQLite em memória e arquivos em `/tmp/flowdesk-attachment-fixture-*`. `TicketAttachmentsPostgresqlTest` exige `FLOWDESK_ATTACHMENTS_PG_HOST=flowdesk-attachments-test-<hex>`, banco vazio `flowdesk_attachments_test` e filesystem temporário. Kernels independentes usam Sanctum/cookies/sessões em banco, barreiras observáveis em `pg_stat_activity` e arquivo compartilhado somente no runner descartável. Cobrem cotas concorrentes, limitação de frequência, revogação/reativação, perfil, atribuição, estado, download, reconciliação e rollback de auditoria, além das constraints reais.

Nenhum teste automatizado deve apontar para `flowdesk` ou para o volume real de anexos. A página de detalhes integra listagem, upload, download autenticado e visualização de imagens/TXT; PDF fica disponível somente para download. Os testes frontend usam transporte simulado, sem dados reais.
