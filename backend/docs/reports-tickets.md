# Tabela e filtros administrativos de relatórios

Somente administradores ativos, autenticados com Sanctum e sessão válida podem acessar os dois endpoints. O administrador é consultado novamente após as consultas, fora do snapshot de leitura. 401 mantém `session_revoked`; 403 indica acesso proibido, 422 indica query inválida e 503 com `report_unavailable` indica falha de consulta sem exposição de SQL.

A interface em `#/relatorios` integra o catálogo, os filtros e a tabela paginada. Os filtros em edição só entram em vigor ao selecionar **Aplicar filtros**, que retorna à primeira página. As datas da tabela são exibidas em `America/Sao_Paulo`; a exportação CSV usa UTC e inclui todas as páginas da seleção aplicada. O acesso direto à rota por outros perfis apresenta acesso não permitido sem consultar os endpoints de relatórios.

## GET /api/reports/tickets

O universo é exclusivamente o dos chamados **criados no período**, independentemente do status atual. Não é uma busca por datas de resolução ou fechamento. As regras de datas são as mesmas do resumo: `start_date` e `end_date` juntos, `AAAA-MM-DD`, padrão dos últimos 30 dias locais incluindo hoje, limite de um ano de calendário, fuso `America/Sao_Paulo` e intervalo SQL UTC semiaberto.

Filtros opcionais, combinados por AND:

| Parâmetro | Contrato |
| --- | --- |
| `assigned_to` | ID positivo de usuário existente ou literal `unassigned` para `assigned_to IS NULL` |
| `category_id` | ID positivo de categoria existente, incluindo inativa |
| `priority` | low, medium, high ou urgent |
| `status` | Código de status existente |
| `page` | Inteiro de 1 a 1.000.000; padrão 1 |
| `per_page` | Inteiro de 1 a 100; padrão 15 |

Campos adicionais, corpo e arquivos são rejeitados. Vazio/zero/null não significam “todos” nem “sem responsável”: omitir o filtro seleciona todos; utilizar `unassigned` seleciona os sem responsável. O filtro de responsável não exige perfil técnico atual ou conta ativa, preservando consulta a vínculos antigos. Um usuário existente sem chamados atribuídos pode ser consultado e produzir resultado vazio.

Ordenação fixa: `created_at DESC, id DESC`. Página além do resultado retorna 200 com `data: []`, sem perder o total. Não há ordenação arbitrária por entrada do usuário.

A resposta usa a paginação Laravel (`data`, `total`, `current_page`, `last_page`, `per_page`, `from`, `to`, links e URLs) mais `meta` com escopo, fuso, limites UTC, referência `as_of`, filtros aplicados e `sla_basis: currently_recorded_deadlines`. Os links preservam filtros validados, período efetivo e tamanho de página, inclusive quando as datas foram omitidas, evitando mudança de período à meia-noite.

Cada linha contém somente:

- `id`, `title`, `priority`;
- `requester: {id,name}`, `assignee: {id,name}|null`, `category: {id,name}`;
- `status: {id,code,name}`;
- `created_at`, `first_responded_at`, `resolved_at`, `closed_at`, `first_response_due_at`, `resolution_due_at`, em UTC ISO 8601, preservando datas opcionais como `null`;
- `sla: {first_response,resolution}`, com as mesmas cinco classificações do resumo: met, late, pending_on_time, pending_overdue e not_evaluable.

Não inclui e-mails, credenciais, descrição, comentários internos, conteúdo ou caminhos de anexos. Não há ranking ou inferência de produtividade.

**Os filtros adicionais da tabela não alteram os cartões do resumo.** `/api/reports/summary` continua aceitando somente datas e mantém seu contrato e significado. `meta.summary_filters_applied` é `false` na tabela. As classificações e bases de período foram extraídas para uma consulta compartilhada; não há cópia independente da regra de SLA. Cancelados permanecem não avaliáveis e os prazos são os atualmente registrados, inclusive após recálculo por prioridade.

## GET /api/reports/filters

Aceita somente as mesmas datas opcionais, para informar o período efetivo em `meta`. Não aceita os filtros da tabela ou paginação.

As opções formam um **catálogo administrativo global**, sem restrição ao período: `meta.options_scope = administrative_catalog_across_all_periods`. Assim, as seleções continuam disponíveis quando não há resultados no intervalo.

- `data.categories`: todas as categorias, incluindo inativas, com `{id,name,is_active}`.
- `data.assignees`: técnicos ativos, mesmo sem chamados, e qualquer usuário ainda referenciado por `tickets.assigned_to` em qualquer período/status, incluindo desativados e antigos técnicos com outro perfil atual. Retorna `{id,name,role,is_active}`. Não lista antigos responsáveis que só aparecem em eventos e não possuem mais vínculos atuais; o filtro representa responsável atual do chamado, inclusive de chamados antigos.
- `data.unassigned_value`: `unassigned`.
- `data.priorities`: low, medium, high e urgent.
- `data.statuses`: todos os status com `{id,code,name}`.

Categorias e responsáveis são ordenados por nome/ID; status, por posição/ID. Nenhum catálogo é acessível por technician/requester, e nenhum e-mail ou campo interno de autenticação é retornado.

## Consistência e reutilização

`ReportReadSnapshot` compartilha uma transação PostgreSQL `REPEATABLE READ READ ONLY` para cada resposta. Contagem e linhas da página usam o mesmo snapshot; as três consultas de opções também. Revalidações de autorização posteriores usam leituras frescas. O isolamento padrão da conexão não é modificado permanentemente.

`ReportTicketsQuery` centraliza período, filtros atuais e classificação SQL de SLA. `ReportTickets::query()` fornece a consulta ordenada sem paginação e `publicData()` faz a projeção pública, também reutilizados pela exportação descrita em `reports-export.md`.

A tabela executa até duas consultas de dados (COUNT e página), com joins somente para relações de cardinalidade um; não carrega comentários/anexos nem executa consultas por linha. O catálogo executa três consultas. Snapshot vale por resposta, não entre páginas: alterações concorrentes podem deslocar registros entre requisições. Não há promessa de congelamento de toda a navegação nem benchmark de grande volume nesta etapa.

Os testes usam SQLite em memória e PostgreSQL descartável com host `flowdesk-reports-test-<hex>` e banco `flowdesk_reports_test`. Incluem filtros combinados, inativos, antigos técnicos, nulls, limites, ordem por desempate, correspondência do SLA ao resumo, quantidade de queries, snapshots e revogação concorrente. Não executar fixtures contra o desenvolvimento.
