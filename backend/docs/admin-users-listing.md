# Listagem administrativa de usuários

`GET /api/admin/users` exige sessão Sanctum e administrador ativo. Visitantes
recebem 401; solicitantes, técnicos e contas desativadas recebem 403. Autorização
precede validação dos filtros. Login, logout e middleware não são alterados.

## Consulta

| Parâmetro | Regra | Padrão |
| --- | --- | --- |
| `search` | Texto não vazio, até 255 caracteres, sem byte nulo; pesquisa em nome ou e-mail | Sem pesquisa |
| `role` | `requester`, `technician`, `admin` | Todos |
| `status` | `active` (`disabled_at IS NULL`), `disabled` (`IS NOT NULL`) | Todos |
| `page` | Inteiro de 1 a 1000000 | 1 |
| `per_page` | Inteiro de 1 a 100 | 15 |

Espaços externos são removidos pelo middleware existente. Filtros se combinam
com AND; nome e e-mail se combinam com OR dentro da pesquisa. A pesquisa usa
`LOWER` e parâmetros vinculados, sem remoção de acentos. `%`, `_` e `!` digitados
são tratados literalmente. A ordenação é sempre `name ASC, id ASC`, segundo a
collation do banco. Não há seleção livre de colunas ou ordenação pelo cliente.

Valores inválidos e parâmetros desconhecidos retornam 422 no formato de validação
JSON do Laravel. Filtros vazios devem ser omitidos. Somente parâmetros validados
são incluídos nos links de paginação.

## Resposta

Usa o envelope de paginação Laravel já adotado na listagem de chamados:
`data`, `current_page`, `per_page`, `total`, `last_page`, `from`, `to`, `path`,
`first_page_url`, `last_page_url`, `next_page_url`, `prev_page_url` e `links`.
Os links mantêm o formato nativo do paginator.

Cada item de `data` contém exclusivamente:

```json
{
  "id": 1,
  "name": "Administrador de exemplo",
  "email": "admin@example.invalid",
  "role": "admin",
  "disabled_at": null,
  "created_at": "2026-10-27T12:00:00.000000Z"
}
```

Datas são ISO 8601 em UTC ou `null` quando ausentes no banco. Nenhum valor é
inferido para registros legados. Nenhum hash de senha, token, dado de sessão,
`email_verified_at` ou `updated_at` integra os itens.

Resultado sem correspondências: HTTP 200, `data: []`, `total: 0`. Página além
dos resultados: HTTP 200 e `data: []`, preservando o total filtrado. O endpoint
executa contagem e consulta paginada no banco, sem carregar toda a tabela em
memória e sem buscar relacionamentos. Não oferece operações de gravação.
