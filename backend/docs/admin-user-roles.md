# Alteração administrativa de perfil

`PATCH /api/admin/users/{user}/role` exige Sanctum, conta ativa e administrador. Corpo JSON exclusivo:

```json
{"role":"technician","expected_role":"requester"}
```

Os dois campos são obrigatórios e aceitam `requester`, `technician` ou `admin`. Campos adicionais e parâmetros de query são rejeitados com 422. O PATCH de nome/e-mail permanece independente e continua rejeitando `role`.

HTTP 200 retorna `data` com somente `id`, `name`, `email`, `role`, `disabled_at` e `created_at`, no mesmo formato dos endpoints administrativos existentes. Nenhuma senha, token ou conteúdo de auditoria integra a resposta.

## Regras e respostas

- 401: visitante; 403: ator sem permissão, desativado ou tentando alterar o próprio perfil; 404: alvo inexistente/ID inválido; 419: CSRF stateful inválido; 422: payload inválido.
- 409 inclui `message` e um `code` estável: `target_disabled`, `role_changed`, `last_active_admin` ou `active_assignments`.
- Conta-alvo desativada é rejeitada antes da comparação de perfil. Depois é comparado `expected_role`, inclusive se o destino já for o perfil atual.
- Se origem e destino forem iguais, retorna 200 sem UPDATE, mudança de timestamp ou INSERT de auditoria. As verificações de autorização, alvo ativo e perfil esperado continuam obrigatórias; autoalteração continua 403.
- As seis transições são permitidas. Promoção a administrador concede o acesso administrativo existente, sem criar uma nova hierarquia de perfis.
- Sair de `technician`, inclusive para `admin`, é bloqueado por atribuições em `open`, `in_progress`, `waiting_requester` ou `resolved`. Resolvidos ainda podem reabrir. Não há transferência/desatribuição automática.
- Atribuições em `closed` e `cancelled`, autoria, comentários, atividades, relacionamentos, credenciais e SLA permanecem intactos. A operação só modifica `role`, `updated_at` e cria o registro de auditoria.
- Sem a tabela de auditoria ou se sua gravação falhar, uma alteração efetiva retorna 503 genérico e é revertida integralmente.

O administrador ativo que realiza a operação é diferente do alvo. Portanto, mesmo sem a proteção adicional de contagem, uma operação válida já preserva esse administrador. `last_active_admin` é uma defesa explícita adicional; o cenário de último administrador tentando autoalteração retorna 403. Duas tentativas cruzadas por administradores são serializadas: após uma despromoção, a outra requisição revalida o ator e retorna 403.

## Locks e concorrência

Na conexão PostgreSQL da transação, a operação adquire `pg_advisory_xact_lock(706402, 1)` antes dos locks dos usuários. O par é reservado exclusivamente para mudanças de perfil do FlowDesk. Ele serializa todas essas operações no mesmo banco e é liberado automaticamente no commit/rollback; não é lock de sessão e não é mantido enquanto o usuário decide na interface.

Ator e alvo são carregados por ID crescente: `FOR SHARE` no ator e `FOR UPDATE` no alvo. O ator é revalidado sob lock e permanece ativo/administrador até o commit. O alvo também é revalidado sob lock. Usar lock compartilhado no ator é importante: atribuição pode já manter locks compartilhados no administrador e aguardar o técnico. Um lock exclusivo desnecessário no ator poderia formar um ciclo nessa situação. A ordem crescente também coordena a operação com os locks exclusivos do PATCH de nome/e-mail.

A operação de perfil **não adquire locks de chamados**. Sua consulta de atribuições é uma leitura normal, feita depois do lock exclusivo do alvo. Os fluxos de chamados continuam usando chamado → usuário. Assim, não se introduz uma espera usuário → chamado:

- Se a atribuição vencer, seu lock compartilhado do técnico dura até o commit. A mudança de perfil aguarda, lê a atribuição confirmada e retorna 409.
- Se a mudança de perfil vencer, a atribuição aguarda o usuário e depois revalida o perfil atualizado; um destino que deixou de ser técnico recebe 422, sem atribuir o chamado.
- Comentários também revalidam o usuário com `FOR SHARE`. Se a despromoção vencer, um comentário interno de solicitante é negado. Se o comentário vencer, a mudança de perfil aguarda seu commit.

São permitidas até três tentativas internas da transação para erros de concorrência reconhecidos pelo Laravel. Cada tentativa reexecuta locks e verificações; efeitos de banco são transacionais. Isso não representa reenvio HTTP automático. As transações devem permanecer curtas.

Advisory locks são cooperativos: SQL externo e futuros endpoints que mudem perfil ou removam administradores ativos devem respeitar o mesmo protocolo. A contagem de administradores ativos não protege contra gravações externas que ignorem essa disciplina. Uma futura desativação/exclusão precisa participar desse mutex e da regra de preservação do administrador. SQLite em memória verifica regras, mas não comprova esse protocolo de concorrência.

## Auditoria persistente e atomicidade

A tabela `user_role_changes` possui `id`, `actor_id`, `target_user_id`, `previous_role`, `new_role` e `created_at` com fuso. As duas referências a usuários são obrigatórias e restringem exclusão. CHECKs limitam os perfis e impedem registros de perfil igual ou ator igual ao alvo. Há índices por ator e por usuário-alvo/data.

O evento é inserido na mesma conexão e transação do UPDATE, com a mesma data da alteração. Uma falha de auditoria desfaz o perfil e seu timestamp. Não há gravação em `ticket_activities`, evento para no-op ou fallback para arquivo de log. O modelo oferece relações `actor` e `targetUser`. Não foi criado endpoint para editar ou remover auditorias; privilégios diretos no banco continuam podendo alterar registros, portanto esta solução não promete proteção contra administradores do próprio banco.

## Sessões e disponibilização

As sessões e credenciais não são alteradas. Nas próximas requisições, o guard web do Sanctum recupera o usuário com seu perfil atual. Uma sessão existente passa a ganhar/perder acesso conforme o novo perfil. Interfaces já carregadas podem continuar mostrando dados antigos até atualização; sincronização de frontend não faz parte desta entrega.

O filtro existente de chamados por `assigned_to` ainda exige que o usuário seja técnico. Depois de uma mudança de perfil, referências históricas continuam preservadas e visíveis conforme o escopo de acesso, mas esse filtro específico pode retornar 422 para o antigo responsável. Alterar o contrato desse filtro e sua interface é uma decisão separada; esta entrega não modifica a validação de listagem nem a visibilidade de chamados.

A migration `2026_10_28_210000_create_user_role_changes_table.php` já foi aplicada no PostgreSQL de desenvolvimento, após autorização explícita. Em novos ambientes, ela deve ser aplicada pelo procedimento normal de implantação antes de disponibilizar alterações efetivas de perfil. A criação da tabela não altera o perfil de usuários existentes nem executa seeders.

## Testes isolados

`UpdateAdminUserRoleTest` usa SQLite em memória por padrão, com uma fixture de auditoria criada por Schema, sem executar a nova migration. Com `FLOWDESK_ROLE_PG_HOST=flowdesk-role-test-<hex>`, usa exclusivamente `flowdesk_role_test` e executa a migration real. Cada teste funcional envolve o esquema em transação com rollback; CHECKs/FKs são verificados no PostgreSQL.

`UpdateAdminUserRoleConcurrencyTest` exige o mesmo host descartável e banco inicialmente vazio. Usa processos de kernel HTTP independentes e espera locks reais via `pg_stat_activity`, sem sleeps usados para decidir o vencedor. Cobre disputas pelo mesmo alvo, administradores alterando-se, atribuição/perfil e comentário/perfil nas duas ordens, e edição simultânea de nome/e-mail com perfil. O worker tem guardas explícitas de hostname e nome do banco. Nenhum teste deve apontar para o PostgreSQL de desenvolvimento.
