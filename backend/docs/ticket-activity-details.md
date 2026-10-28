# Detalhes opcionais do histórico

`GET /api/tickets/{id}` preserva `id`, `action`, `actor` e `created_at` de cada
atividade. Para técnicos e administradores com acesso ao chamado, acrescenta
`details` somente quando há valores válidos em campos explicitamente permitidos.
O JSONB `changes` nunca é devolvido diretamente.

| Ação | Campo persistido | Campo em `details` | Valores de `from` / `to` |
| --- | --- | --- | --- |
| `assignment_changed` | `assigned_to` | `assignee` | `{id, name}` ou `null` explícito |
| `status_changed` | `status` | `status` | Código de status conhecido ou `null` explícito |
| `details_changed` | `category_id` | `category` | `{id, name}` ou `null` explícito |
| `details_changed` | `priority` | `priority` | Código de prioridade conhecido ou `null` explícito |

Exemplo ilustrativo de atribuição:

```json
{
  "id": 12,
  "action": "assignment_changed",
  "actor": { "id": 1, "name": "Administrador" },
  "created_at": "2026-10-27T12:00:00.000000Z",
  "details": {
    "assignee": {
      "from": null,
      "to": { "id": 8, "name": "Técnico" }
    }
  }
}
```

Exemplo ilustrativo de edição conjunta:

```json
{
  "category": {
    "from": { "id": 2, "name": "Software" },
    "to": { "id": 1, "name": "Hardware" }
  },
  "priority": { "from": "medium", "to": "high" }
}
```

Esse segundo objeto corresponde apenas ao conteúdo de `details`.

## Ausência, referências e compatibilidade

- Lados ausentes ou inválidos são omitidos, sem inferir valores pelo chamado atual.
  Por exemplo, `{"assignee":{"to":null}}` não afirma nada sobre o responsável anterior.
- Um `null` explicitamente persistido é preservado em qualquer campo permitido.
  Em `assignee`, significa não atribuído; nos demais campos, não se infere um
  significado adicional nem se substitui pelo estado atual do chamado.
- Referência válida sem registro correspondente preserva o ID com `name: null`.
  Isso difere de um responsável explicitamente não atribuído.
- IDs devem ser inteiros positivos; objetos, booleanos e strings numéricas são
  tratados como valores inválidos. Status permitidos: `open`, `in_progress`,
  `waiting_requester`, `resolved`, `closed`, `cancelled`. Prioridades permitidas:
  `low`, `medium`, `high`, `urgent`. Outros códigos são omitidos.
- Nomes são resolvidos em lote e correspondem aos nomes atuais, não a snapshots
  históricos. Categorias inativas e usuários desativados continuam resolvíveis.
  Somente `id` e `name` são selecionados e expostos.
- Eventos sem transições válidas preservam exatamente o formato anterior, sem
  `details`. Não há preenchimento retroativo, migration ou alteração da gravação.

## Privacidade e consultas

O filtro atual de solicitantes permanece intacto: somente `created` com
`changes = null` é visível. Solicitantes não recebem `details` nem provocam
consultas de resolução de referências históricas.

Eventos de comentários, criação e ações desconhecidas não produzem detalhes,
mesmo que contenham campos com nomes permitidos em outras ações. Conteúdo de
comentários e metadados arbitrários não são copiados para `details`.

São feitas no máximo duas consultas adicionais por resposta: uma para usuários
e outra para categorias, usando IDs deduplicados apenas das atividades visíveis.
Se não houver referências de um tipo, sua consulta é dispensada. A autorização
do chamado ocorre antes dessas consultas.
