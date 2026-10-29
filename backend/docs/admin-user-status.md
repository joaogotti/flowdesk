# Ativação e desativação administrativa

`PATCH /api/admin/users/{user}/status` exige Sanctum, sessão com versão válida e administrador ativo. Corpo JSON exclusivo, com booleanos reais:

```json
{"is_active":false,"expected_is_active":true}
```

Os dois campos são obrigatórios. Strings, números, campos adicionais e parâmetros de query retornam 422. O PATCH de nome/e-mail e o de perfil continuam independentes. O sucesso retorna 200 com `data` contendo somente `id`, `name`, `email`, `role`, `disabled_at` e `created_at`.

## Regras e respostas

- 401: visitante ou sessão revogada; esta última mantém `code: session_revoked` e não gera log ERROR de exceção esperada. As demais falhas continuam usando o tratamento normal de logs.
- 403: ator sem permissão, desativado ou tentando desativar a própria conta. Consultar a própria conta ativa sem mudança é permitido.
- 404: alvo inexistente; 419: CSRF inválido; 422: payload inválido.
- 409 `status_changed`: `expected_is_active` difere da situação recarregada, inclusive em uma tentativa sem mudança efetiva.
- 409 `active_assignments`: tentativa de desativar técnico com atribuições em `open`, `in_progress`, `waiting_requester` ou `resolved`.
- 409 `last_active_admin`: preservação explícita de pelo menos um administrador ativo. Como o ator ativo não pode se desativar, ele já preserva essa condição; a tentativa do último administrador contra si mesmo retorna 403.
- 409 `session_version_exhausted`: contador chegou ao limite do bigint com sinal; a operação é rejeitada antes de gravar.
- 503: indisponibilidade de armazenamento ou falha de persistência, sem alteração parcial.

Ativar ou desativar não muda perfil, credenciais, autoria, responsáveis, comentários, atividades ou SLA. Não há redistribuição automática. A reativação também incrementa a versão: sessões anteriores continuam inválidas. Atribuições históricas em `closed` e `cancelled` não impedem desativação; atribuições pendentes não impedem reativação.

Sem mudança efetiva, retorna 200 sem UPDATE de usuário, incremento, exclusão de sessões ou auditoria. A autenticação, autorização e comparação do estado esperado permanecem obrigatórias. A manutenção normal da sessão HTTP pelo Laravel pode atualizar sua própria tabela, independentemente de alterações de negócio.

## Locks e atomicidade

`AdminUserSecurity` compartilha com a alteração de perfil o `pg_advisory_xact_lock(706402, 1)`, na mesma conexão e transação. O mutex serializa essas operações administrativas dentro do banco e é liberado no commit/rollback. Depois são adquiridos locks por ID crescente: `FOR SHARE` no ator e `FOR UPDATE` no alvo; se forem a mesma conta, somente o lock exclusivo do alvo. O ator é revalidado quanto a versão da sessão, atividade e perfil; o alvo é recarregado antes da comparação e das regras.

Não são adquiridos locks de chamados. A consulta de atribuições ocorre após o lock do técnico, preservando a direção chamado → usuário dos escritores existentes. Se a atribuição vencer, a desativação aguarda e retorna 409. Se a desativação vencer, a atribuição aguarda e rejeita o técnico inativo. Comentários seguem o mesmo protocolo: uma gravação já autorizada sob lock pode concluir; uma sessão antiga perde autorização quando a mudança de versão vence. Até três tentativas internas de transação tratam erros de concorrência reconhecidos pelo Laravel, sem reenviar HTTP.

Em cada mudança efetiva, `disabled_at`, incremento de `session_version`, exclusão das sessões do alvo e INSERT de auditoria são confirmados na mesma transação. Falha de auditoria desfaz inclusive a exclusão de sessões. O armazenamento de sessões em banco deve usar a mesma conexão da transação; configurações incompatíveis são rejeitadas com 503. O driver `array` é aceito para testes isolados.

A exclusão física não é a garantia de revogação: um login autorizado antes da mudança pode salvar sua sessão depois da exclusão. Essa sessão retém a versão antiga e recebe 401 no próximo acesso, inclusive após reativação. Não se atualizam automaticamente versões de sessões existentes. Consulte `session-versions.md`.

Advisory locks são cooperativos. SQL externo e futuros endpoints que alterem perfis, atividade ou removam administradores devem seguir o mesmo protocolo. Leituras e respostas já autorizadas em andamento não são canceladas. `expected_is_active` verifica o estado atual, não identifica um ciclo completo de desativação/reativação que terminou no mesmo estado.

## Auditoria e implantação

A migration `2026_10_29_020000_create_user_status_changes_table.php` **já foi aplicada e validada no PostgreSQL de desenvolvimento**, após backup validado e autorização explícita. Ela cria apenas `user_status_changes`, com `id`, `actor_id`, `target_user_id`, `previous_disabled_at`, `new_disabled_at` e `created_at` com fuso. As referências obrigatórias a usuários restringem exclusão; CHECKs exigem ator diferente do alvo e exatamente um estado desativado entre anterior e posterior. Índices cobrem ator e alvo/data. Os estados ativo/inativo são representados pela ausência/presença de `disabled_at`, preservando também a data anterior de desativação.

A data do evento coincide com o `updated_at` da mudança. Não é reutilizado o histórico de chamados e não há evento para operação sem mudança. O modelo oferece relações `actor` e `targetUser`. A auditoria não possui endpoint de edição/exclusão; privilégios diretos no banco continuam podendo alterar registros.

O `down()` remove somente a tabela de auditoria; não reverte estados ou versões e apaga esses eventos, portanto exige avaliação antes de uso. Em novos ambientes, aplicar as migrations de `session_version` e de auditoria antes de disponibilizar mudanças efetivas. Ambas já foram aplicadas e validadas no desenvolvimento.

## Interface administrativa

A página `#/usuarios` oferece ações separadas Ativar/Desativar, sem ação sobre a própria conta. A confirmação identifica o usuário, perfil e situação capturada ao abrir; exige confirmação explícita e envia somente `is_active` e `expected_is_active`. Durante o processamento, envios duplicados e cancelamento ficam bloqueados. Sucesso atualiza a lista preservando pesquisa, filtros e paginação quando possível; uma página final esvaziada retorna à última válida. São preservados os indicadores de situação, foco, teclado e responsividade existentes.

Conflitos apresentam mensagens específicas e exigem atualizar os dados e abrir nova confirmação. Falhas de rede ou respostas ambíguas nunca repetem o PATCH automaticamente. Erros 401/403/404/419/422 são tratados sem expor mensagens internas. Um 401 com `session_revoked` remove a identidade e os dados protegidos, enquanto 403 comum mantém a sessão. Cadastro, edição de nome/e-mail e alteração de perfil permanecem separados.

## Testes isolados

`UpdateAdminUserStatusTest` usa SQLite em memória; com `FLOWDESK_USER_STATUS_PG_HOST=flowdesk-user-status-test-<hex>`, usa exclusivamente o banco descartável `flowdesk_user_status_test`, com migrations reais de auditoria e rollback por teste.

`UpdateAdminUserStatusConcurrencyTest` exige esse PostgreSQL inicialmente vazio. Kernels HTTP independentes usam Sanctum, cookies criptografados e sessões em banco; barreiras observam locks reais em `pg_stat_activity`. São cobertos administradores concorrentes, perfil versus situação, atribuição e comentários nas duas ordens, revogação durante espera, múltiplos dispositivos, login com persistência tardia, edição simultânea de nome, rollback de falha de auditoria e constraints/índices/down da migration. Hostname e nome do banco possuem guardas explícitas. Nunca apontar esses testes para o desenvolvimento.
