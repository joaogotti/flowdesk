# Resumo administrativo de relatórios

`GET /api/reports/summary` exige Sanctum, versão de sessão válida e administrador ativo. O resumo continua aceitando somente datas; os filtros adicionais da tabela/CSV não alteram automaticamente seus cartões. A tabela e o catálogo estão descritos em `reports-tickets.md`, e a exportação em `reports-export.md`. Nenhuma migration nova é necessária.

A interface administrativa em `#/relatorios` apresenta movimentos, distribuições por status/categoria/prioridade e indicadores de SLA. A aplicação do período atualiza o resumo, a tabela e o contexto da exportação; os filtros adicionais afetam somente tabela e CSV. Quando não há obrigações concluídas avaliáveis, a taxa de SLA aparece como **Não disponível**, com as contagens de pendências exibidas separadamente.

## Período e resposta

Query opcional: `start_date=2026-10-01&end_date=2026-10-30`. Informar ambas as datas, no formato `AAAA-MM-DD`, ou omitir ambas. Campos extras e filtros no corpo são rejeitados com 422. Sem datas, são considerados hoje e os 29 dias anteriores em `America/Sao_Paulo`. A data final é inclusiva para o usuário; SQL utiliza início inclusivo e início do dia seguinte exclusivo, convertidos para UTC. O intervalo exclusivo não pode ultrapassar o início acrescido de um ano de calendário, com ajuste de aniversário em ano bissexto. Anos bissextos e mudanças históricas de horário de verão respeitam o calendário local. Datas futuras não são proibidas; não se inventam ocorrências ou prazos cumpridos por esse motivo.

Resposta: `data` contém `movements`, `cohort` e `sla`; `meta` contém datas locais, limites UTC, fuso, fonte das resoluções e `as_of`. Este último é o instante de referência do cálculo de SLA, com precisão de segundos. O relatório consulta a situação atual em um snapshot; não reconstrói a situação que existia no último dia do período.

## Universos

- `movements.created`: chamados criados no intervalo, por `tickets.created_at`.
- `movements.resolved_distinct`: chamados distintos com evento `status_changed` e `changes.status.to = resolved` no intervalo. Reabertura não apaga o evento; duas resoluções contam um chamado. Não depende da data de criação ou do status atual. Eventos legados ausentes não são inferidos de `resolved_at`.
- `movements.closed`: chamados com `closed_at` no intervalo, independentemente da abertura.
- `cohort`: situação atual somente dos chamados criados no intervalo. `total` coincide com `movements.created`.
- `cohort.unassigned`: toda a coorte sem responsável, incluindo estados finais e cancelados; não é apenas a fila ativa.
- `by_status`: todos os status cadastrados, inclusive com contagem zero. Códigos futuros não recebem semântica de pendência automaticamente.
- `by_category`: categorias presentes na coorte, inclusive desativadas, com ID/nome/situação atuais. Não são snapshots dos nomes antigos.
- `by_priority`: prioridades low/medium/high/urgent, inclusive com zero. Não é ranking de técnicos.

## SLA por obrigação

`first_response` e `resolution` classificam separadamente toda a coorte em cinco categorias mutuamente exclusivas:

| Campo | Significado |
| --- | --- |
| `met` | Ocorrência válida até o prazo, inclusive |
| `late` | Ocorrência válida depois do prazo |
| `pending_on_time` | Sem ocorrência, status open/in_progress/waiting_requester e sem resolução/fechamento; referência até o prazo, inclusive |
| `pending_overdue` | Mesma elegibilidade de pendência, mas referência posterior ao prazo |
| `not_evaluable` | Cancelado, datas incoerentes, ou ausência de evidência que não permita classificar como pendência |

As cinco contagens somam o total da coorte em cada obrigação. `cancelled_excluded` é um subconjunto de `not_evaluable`, não uma sexta categoria. Todos os cancelados ficam fora do percentual, mesmo com resposta anterior. `compliance_denominator = met + late`; `compliance_rate` é `100 * met / denominator`, arredondado a duas casas, ou `null` sem denominador. Pendências e não avaliáveis não integram a taxa.

Datas anteriores à criação, posteriores à referência, ocorrência posterior ao fechamento/resolução ou resolução posterior ao fechamento são não avaliáveis. O prazo deve existir e não anteceder a criação. Cada obrigação utiliza seu próprio prazo e evidência; uma primeira resposta inválida não transforma uma resolução válida em inválida. Encerramento não comprova primeira resposta nem substitui resolução ausente.

Os prazos são os atualmente gravados em `tickets`, inclusive os recalculados após mudanças de prioridade. Tempos são corridos; `waiting_requester` não pausa prazos. A reabertura remove a resolução vigente e devolve essa obrigação à pendência, sem reiniciar o prazo. O relatório não modifica regras ou contratos do dashboard; o dashboard continua mostrando sua classificação operacional conjunta de pendências, não essas taxas históricas.

## Consistência, autorização e falhas

As seis consultas agregadas usam uma única transação PostgreSQL `REPEATABLE READ READ ONLY`, sem locks de escrita ou joins de comentários/anexos. A configuração vale somente para essa transação. O serviço deve iniciar a transação externa; o isolamento padrão das demais operações não é alterado. SQLite em memória fornece o snapshot dos testes funcionais, com normalização de datas na classificação.

O administrador é consultado novamente antes da validação e após encerrar o snapshot. A revalidação final é uma leitura fresca, para não reutilizar o perfil ou a versão de sessão antigos do snapshot. Uma autorização já concluída não revoga bytes já entregues. A resposta usa `Cache-Control: private, no-store`.

401 indica falta de autenticação ou `session_revoked`; 403 indica perfil/situação sem permissão; 422 indica query inválida; 503 com `report_unavailable` indica falha de consulta, sem expor SQL ou caminhos físicos. A autorização ocorre antes da validação de filtros.

`ReportSummaryTest` cobre contratos, calendários, distribuições, taxas, reabertura, prioridade e preservação dos dados/dashboard. `ReportSummaryPostgresqlTest` exige host `flowdesk-reports-test-<hex>` e banco vazio `flowdesk_reports_test`; usa conexões independentes para comprovar snapshot e revalidação após alterações concorrentes. Nunca executar fixtures contra o banco ou volume de desenvolvimento.
