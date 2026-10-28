# Edição administrativa de nome e e-mail

`PATCH /api/admin/users/{user}` permite atualizar parcialmente `name`, `email`, ou ambos. A rota reutiliza Sanctum, conta ativa e autorização administrativa do cadastro. Não há alteração de login, logout, middleware ou frontend.

## Contrato HTTP

Exemplo de requisição (também é válido enviar apenas um dos campos):

```json
{
  "name": "Nome Atualizado",
  "email": "usuario@example.com"
}
```

HTTP 200, inclusive quando os valores normalizados já são iguais:

```json
{
  "data": {
    "id": 8,
    "name": "Nome Atualizado",
    "email": "usuario@example.com",
    "role": "technician",
    "disabled_at": null,
    "created_at": "2026-10-27T12:00:00.000000Z"
  }
}
```

Somente esses seis campos públicos são retornados. Datas seguem ISO 8601 em UTC e preservam valores nulos existentes. `role`, situação e data de criação representam o registro existente; não são editáveis. Usuários desativados também podem ter nome/e-mail editados por um administrador ativo, sem serem reativados.

Visitantes recebem 401; solicitantes, técnicos e contas desativadas recebem 403 antes de consultar a existência do alvo. Para administradores autorizados, usuário inexistente ou ID fora do intervalo suportado recebe 404. Os padrões atuais de CSRF para requisições stateful continuam válidos (419 sem token válido). Validação retorna 422 com `message` e `errors`; falhas de banco distintas de colisão de e-mail retornam 503 com mensagem genérica, sem SQL na resposta.

## Validação e integridade

É obrigatório enviar ao menos um campo permitido, válido e não nulo/vazio. Nome e e-mail seguem as mesmas regras e mensagens do cadastro: limite de 255 caracteres, espaços externos removidos, espaços internos do nome preservados, nome sem NUL, e-mail válido e normalizado para minúsculas. Não se exige alteração efetiva para aceitar uma requisição válida.

Campos adicionais são rejeitados com 422 em `errors.payload`, inclusive nulos ou em query string. Isso inclui ID, perfil, senha, confirmação, `disabled_at`, `created_at`, `updated_at`, `email_verified_at`, `remember_token` e atributos desconhecidos. As únicas atribuições possíveis no controller são `name` e `email` validados.

O próprio administrador pode ser editado: ID, perfil, situação, senha/hash, remember token, sessão, CSRF e data de criação permanecem intactos. O valor preexistente de `email_verified_at` também é preservado; o modelo atual não exige verificação de e-mail. Nenhum chamado, comentário, histórico, SLA ou relacionamento é reescrito. Somente uma mudança efetiva de nome/e-mail provoca `save()` e atualização normal de `updated_at`; valores iguais não geram UPDATE nem eventos de salvamento.

## Concorrência e e-mails duplicados

A validação consulta `LOWER(email)` excluindo somente o ID da rota, incluindo outros usuários desativados e capitalizações legadas. Ela não deduz dados a partir da identidade do administrador. O alvo é carregado novamente dentro da transação; administrador e alvo são bloqueados em ordem crescente de ID com `FOR UPDATE`. Isso permite revalidar acesso sob lock, serializar alterações do mesmo usuário e evitar inversão de locks quando dois administradores editam um ao outro. Atualizações parciais aplicam somente os campos enviados sobre a versão carregada sob lock.

O índice existente `users_email_unique` arbitra colisões concorrentes dos valores normalizados. O helper `UserEmailConflict` já usado no cadastro converte a violação específica para 422 em `errors.email`, depois do rollback. Uma edição que perde a disputa não aplica parcialmente o nome nem modifica timestamps. O mesmo tratamento funciona em disputas PATCH/PATCH e POST/PATCH.

Permanece a limitação documentada em [admin-users-creation.md](admin-users-creation.md): o índice é sensível à capitalização. Escritores externos que não normalizem e-mail ainda podem introduzir duplicidades com outra capitalização. A consulta `LOWER(email)` também não possui índice funcional. Uma garantia global exige análise de duplicidades e aprovação separada de um índice único funcional ou equivalente. Nenhuma migration ou alteração do banco de desenvolvimento faz parte desta etapa.

## Testes isolados

`UpdateAdminUserTest` usa exclusivamente SQLite em memória, com guardas antes de preparar tabelas. Cobre atualização parcial/completa, normalização, autoedição, autorização, CSRF, contrato, no-op, preservação de vínculos, campos proibidos, conflitos e rollback.

`UpdateAdminUserPostgresqlTest` exige `FLOWDESK_USER_EDIT_PG_HOST` no formato `flowdesk-user-edit-test-<hex>` e o banco fixo e inicialmente vazio `flowdesk_user_edit_test`. Executa apenas as duas migrations existentes de usuários nesse banco descartável. Kernels independentes exercitam colisões de e-mail exato/com capitalização diferente, atualização parcial simultânea do mesmo alvo, edição mútua de administradores e disputa entre cadastro e edição. Sessão/cache são arrays. O PostgreSQL de desenvolvimento nunca é alvo desse teste.
