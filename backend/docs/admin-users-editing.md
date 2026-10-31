# Edição administrativa de nome e e-mail

`PATCH /api/admin/users/{user}` permite atualizar parcialmente `name`, `email`, ou ambos. A rota reutiliza Sanctum, conta ativa e autorização administrativa do cadastro. Cada campo enviado exige sua precondição original: `expected_name` para `name` e `expected_email` para `email`. O frontend administrativo envia essas precondições somente para os campos alterados. Login, logout e regras de administração permanecem os mesmos.

## Contrato HTTP

Exemplo de requisição (também é válido enviar apenas um campo e sua precondição):

```json
{
  "name": "Nome Atualizado",
  "expected_name": "Nome Original",
  "email": "usuario@example.com",
  "expected_email": "original@example.com"
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

Uma precondição divergente retorna **409** com `code: profile_changed`, sem aplicar qualquer campo ou atualizar timestamps. Isso vale também quando o novo valor já coincide com o atual: uma precondição antiga nunca é aceita como no-op. O cliente deve recarregar os dados e permitir revisão explícita, sem repetir a gravação automaticamente.

## Validação e integridade

É obrigatório enviar ao menos um campo permitido, válido e não nulo/vazio. Nome e e-mail seguem as mesmas regras e mensagens do cadastro: limite de 255 caracteres, espaços externos removidos, espaços internos do nome preservados, nome sem NUL, e-mail válido e normalizado para minúsculas. Não se exige alteração efetiva para aceitar uma requisição válida.

Precondições são strings obrigatórias, de até 255 caracteres e sem NUL, enviadas exatamente como carregadas do servidor: não remover espaços nem alterar capitalização. `expected_email` não é um novo endereço para normalizar. Uma precondição sem seu campo correspondente também é rejeitada. As precondições são comparadas, nunca persistidas.

Campos adicionais, arquivos e qualquer query string são rejeitados com 422 em `errors.payload`, inclusive atributos nulos. Isso inclui ID, perfil, senha, confirmação, `disabled_at`, `session_version`, `created_at`, `updated_at`, `email_verified_at`, `remember_token` e atributos desconhecidos. As únicas atribuições possíveis no controller são `name` e `email` validados. O trim global é dispensado somente nesses PATCHs; os requests normalizam os novos valores e preservam as precondições exatas e NUL para validação.

O próprio administrador pode ser editado: ID, perfil, situação, senha/hash, remember token, sessão, CSRF e data de criação permanecem intactos. O valor preexistente de `email_verified_at` também é preservado; o modelo atual não exige verificação de e-mail. Nenhum chamado, comentário, histórico, SLA ou relacionamento é reescrito. Somente uma mudança efetiva de nome/e-mail provoca `save()` e atualização normal de `updated_at`; valores iguais não geram UPDATE nem eventos de salvamento.

## Concorrência e e-mails duplicados

A validação consulta `LOWER(email)` excluindo somente o ID da rota, incluindo outros usuários desativados e capitalizações legadas. Ela não deduz dados a partir da identidade do administrador. O alvo é carregado novamente dentro da transação; administrador e alvo são bloqueados em ordem crescente de ID com `FOR UPDATE`. Isso permite revalidar acesso sob lock, serializar alterações do mesmo usuário e evitar inversão de locks quando dois administradores editam um ao outro. Atualizações parciais aplicam somente os campos enviados sobre a versão carregada sob lock.

Após revalidar autorização e versão de sessão sob lock, `UserProfilePreconditions` compara os valores originais dos campos enviados. Duas edições do mesmo nome original têm um único vencedor; a outra recebe 409. Uma edição somente de e-mail pode coexistir com uma autoedição de nome, preservando ambas. A autoedição em `PATCH /api/user/profile` segue o mesmo protocolo, descrito em [user-profile.md](user-profile.md).

O índice existente `users_email_unique` arbitra colisões concorrentes dos valores normalizados. O helper `UserEmailConflict` já usado no cadastro converte a violação específica para 422 em `errors.email`, depois do rollback. Uma edição que perde a disputa não aplica parcialmente o nome nem modifica timestamps. O mesmo tratamento funciona em disputas PATCH/PATCH e POST/PATCH.

Permanece a limitação documentada em [admin-users-creation.md](admin-users-creation.md): o índice é sensível à capitalização. Escritores externos que não normalizem e-mail ainda podem introduzir duplicidades com outra capitalização. A consulta `LOWER(email)` também não possui índice funcional. Uma garantia global exige análise de duplicidades e aprovação separada de um índice único funcional ou equivalente. Nenhuma migration ou alteração do banco de desenvolvimento faz parte desta etapa.

## Testes isolados

`UpdateAdminUserTest` usa exclusivamente SQLite em memória, com guardas antes de preparar tabelas. Cobre atualização parcial/completa, normalização, autoedição, autorização, CSRF, contrato, no-op, preservação de vínculos, campos proibidos, conflitos e rollback.

`UpdateAdminUserPostgresqlTest` exige `FLOWDESK_USER_EDIT_PG_HOST` no formato `flowdesk-user-edit-test-<hex>` e o banco fixo e inicialmente vazio `flowdesk_user_edit_test`. Cria diretamente o esquema de fixture, sem aplicar migrations. Kernels independentes exercitam colisões de e-mail exato/com capitalização diferente, atualização parcial simultânea do mesmo alvo, edição mútua de administradores, disputa entre cadastro e edição e disputas autoedição/administração, autoedição/autoedição e administração/administração pelo mesmo nome original. Sessão/cache são arrays. O PostgreSQL de desenvolvimento nunca é alvo desse teste.

## Frontend administrativo

`UpdateAdminUserInput`, `getAdminUserChanges` e `updateAdminUser` encaminham as precondições originais somente dos campos alterados. `UserEditForm` conserva os valores originalmente carregados e trata 409 `profile_changed` preservando a edição local. **Atualizar dados** consulta novamente a lista e atualiza as precondições, mantendo o rascunho dos campos alterados para revisão explícita. Se o usuário não estiver na página atual, o formulário orienta cancelar e localizá-lo novamente. Nenhuma gravação é repetida automaticamente. O formato de sucesso permanece com os mesmos seis campos, e os endpoints de criação, perfil administrativo e situação não mudam.

Precondições por valor não detectam a sequência A → B → A: se o valor original voltou a ser exatamente igual, a edição é aceita. Detectar todo evento intermediário exigiria outro mecanismo de revisão, fora deste contrato.
