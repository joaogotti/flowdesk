# Indicadores de pendências de SLA

`GET /api/dashboard/sla` exige `auth:sanctum` e `user.active`. Reutiliza
`Ticket::visibleTo`: administrador vê todos os chamados; solicitante, os próprios;
técnico, os atribuídos a ele e os sem responsável.

## Regras existentes

- A criação associa a política da prioridade e soma seus minutos corridos a
  `created_at`, produzindo `first_response_due_at` e `resolution_due_at`.
- Alterar a prioridade recalcula esses prazos a partir da criação original.
  Alterar apenas a categoria preserva o SLA. O indicador consulta os prazos
  gravados; não recalcula nem modifica o chamado ou sua política.
- O primeiro comentário público de administrador ou técnico registra
  `first_responded_at`. Comentários internos e do solicitante não cumprem esse prazo.
- Resolver preenche `resolved_at`; reabrir limpa esse campo, preservando os prazos.
  Fechar preenche `closed_at`. Cancelar encerra as pendências.
- `waiting_requester` não pausa os relógios: não existe regra implementada de pausa,
  expediente ou dias úteis. As datas são armazenadas em UTC, com precisão de segundos.
- A apresentação atual distingue prazo pendente de cumprimento no prazo ou tardio,
  e deixa neutros os prazos inaplicáveis ou as datas incoerentes.

Fontes: `StoreTicketController`, `StoreTicketCommentController`,
`UpdateTicketDetailsController`, `UpdateTicketStatusController`, `SlaPolicySeeder`
e a avaliação existente em `frontend/src/utils/ticket-dates.ts` (somente consultada).

## Contrato

HTTP 200, sem parâmetros de filtro ou alteração do escopo pelo cliente:

```json
{
  "data": {
    "on_track": 0,
    "at_risk": 0,
    "overdue": 0
  }
}
```

Os zeros acima ilustram uma base sem pendências; os valores são calculados no banco.
Os três indicadores são inteiros não negativos e contam chamados, não prazos.

Somente `open`, `in_progress` e `waiting_requester`, sem `resolved_at` ou `closed_at`,
participam. A primeira resposta está pendente somente enquanto `first_responded_at`
é nulo; a resolução permanece pendente até o encerramento. Qualquer prazo ainda
pendente estritamente anterior ao instante de referência torna o chamado `overdue`.
Se não houver atraso e alguma pendência estiver na janela dos 20% finais, ele é
`at_risk`. Caso contrário, ele é `on_track`. O início da janela é inclusivo.
No vencimento exato, a pendência é `at_risk`; somente depois passa a `overdue`.
As comparações mantêm a precisão de segundos utilizada no projeto.

Uma primeira resposta já registrada não gera atraso pendente, mesmo se realizada
tardiamente. O endpoint não é um relatório de cumprimento histórico de SLA.
Resolvidos, fechados e cancelados não são pendências, inclusive quando falta uma
data efetiva. Reabrir volta a considerar o prazo original de resolução.

Datas incoerentes não justificam afirmar prazo regular ou vencido: criação futura,
prazo anterior à criação ou primeira resposta anterior à criação/futura excluem o
chamado destas contagens. Códigos de status desconhecidos também não são inferidos.
Por isso, a soma destes indicadores não corresponde ao total geral de chamados.

O cálculo usa uma consulta agregada e um único instante UTC por requisição.
Não carrega chamados ou relacionamentos em memória. Visitantes recebem 401;
usuários desativados ou com papel não suportado recebem 403.

## Regra aprovada de risco: 20% finais

Para cada prazo ainda pendente, a janela em segundos é calculada como
`minutos_da_política × 60 × 0,20`. O tempo restante é a diferença entre o
vencimento gravado e o instante UTC da consulta. Há risco quando esse restante
está entre zero e a janela, inclusive. Não há arredondamento para minutos inteiros.

A consulta lê as durações da política associada por `sla_policy_id`. Essa política
corresponde à prioridade e é atribuída na criação ou na alteração da prioridade.
As janelas não são valores fixos no controller e os vencimentos não são recalculados.

Com as políticas atuais, os exemplos em minutos são:

| Prioridade | Primeira resposta | Janela de resposta | Resolução | Janela de resolução |
| --- | ---: | ---: | ---: | ---: |
| Baixa | 480 | 96 | 4320 | 864 |
| Média | 240 | 48 | 1440 | 288 |
| Alta | 60 | 12 | 480 | 96 |
| Crítica | 15 | 3 | 240 | 48 |

Na prioridade Média, a janela de resolução é **288 minutos**, não 2880.
Para resposta crítica com vencimento às 12:00 UTC, às 11:56:59 ainda não há risco;
às 11:57:00 começa a janela; às 12:00:00 há risco; às 12:00:01 há atraso.

Uma classificação SQL única por chamado aplica a precedência:
`overdue` > `at_risk` > `on_track`. Dois prazos em risco ou atrasados não duplicam
a contagem. Uma resolução vencida prevalece sobre uma primeira resposta em risco
e vice-versa. Primeira resposta cumprida, mesmo tardia, não participa dessas
comparações. `waiting_requester` não pausa a contagem, e reabrir considera novamente
o vencimento original de resolução, inclusive sua janela de risco.

O cálculo usa intervalos em PostgreSQL e segundos Unix em SQLite, mantendo uma
única consulta agregada, sem carregar todos os chamados em memória.
