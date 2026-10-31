# Autoedição do nome

`PATCH /api/user/profile` permite que requester, technician e admin autenticados, ativos e com versão de sessão válida alterem exclusivamente o próprio nome. O alvo é sempre a identidade autenticada, nunca um ID fornecido pelo cliente. A página `#/configuracoes` oferece essa edição, mantendo e-mail e perfil somente leitura. A alteração de senha usa um formulário e endpoint separados, descritos em [user-password.md](user-password.md).

## Contrato

Corpo obrigatório, sem query string ou arquivos:

```json
{
  "name": "Novo Nome",
  "expected_name": "Nome Original"
}
```

`name` segue as regras do cadastro administrativo: string obrigatória, até 255 caracteres, sem NUL; espaços externos são removidos e espaços internos preservados. `expected_name` é uma string obrigatória de até 255 caracteres, sem NUL, com o valor exato originalmente carregado, sem trim ou normalização. As precondições se baseiam em valores, não em versões de registro: A → B → A não é detectado.

HTTP 200 retorna somente `data: {id, name, email, role}`, com `Cache-Control: private, no-store`. `GET /api/user` continua com seu formato original, sem envelope `data`.

- 401: visitante ou sessão revogada; incompatibilidade de versão mantém `code: session_revoked`.
- 403: conta desativada, inclusive quando a atividade muda após a validação.
- 409 com `code: profile_changed`: nome original diferente do registro atual. Recarregar e revisar, sem retry automático.
- 419: CSRF inválido ou ausente numa requisição stateful.
- 422: nome/precondição inválidos, campos extras, arquivos ou query string.
- 503: falha de banco, com mensagem genérica sem SQL ou detalhes privados.

## Transação, autorização e preservação

A rota usa `auth:sanctum`, `auth.session.version` e `user.active`. O controller abre uma transação, recarrega a própria conta com `FOR UPDATE`, revalida a versão capturada na requisição e a atividade, compara a precondição e só então atribui `name`.

Somente mudança efetiva chama `save()` e altera `updated_at`. Um no-op com precondição válida retorna 200 sem UPDATE nem eventos de salvamento; uma precondição antiga retorna 409 mesmo quando o novo nome coincide com o atual. Falhas desfazem a transação.

E-mail, perfil, senha, atividade, versão de sessão, remember token, verificação de e-mail, criação e vínculos existentes permanecem intactos. Não há exclusão de sessões nem rotação de sessão ou CSRF pela alteração de nome. O contador de versão continua com o valor anterior; outras sessões continuam válidas. Não são criados eventos em históricos de chamados ou tabelas de auditoria administrativa de perfil/situação.

`UserProfilePreconditions` é compartilhado com a edição administrativa de nome/e-mail. A comparação ocorre depois dos locks existentes e antes de atribuir qualquer campo. Alterações sobre o mesmo nome original não se sobrescrevem silenciosamente; campos distintos podem ser editados independentemente. Ver [admin-users-editing.md](admin-users-editing.md).

## Testes

`UpdateUserProfileTest` usa exclusivamente SQLite em memória, com guardas antes de preparar fixtures. Cobre os três perfis, sessão/CSRF, campos proibidos, validação, no-op, conflitos nos dois sentidos, revalidação após validação, rollback e preservação de atributos, vínculos e sessões. `UserSessionVersionTest` inclui a nova rota e sua revalidação transacional.

`UpdateAdminUserPostgresqlTest` comprova concorrência real com kernels independentes e barreiras de locks, somente em PostgreSQL descartável. Não executar esses testes contra o banco ou volumes de desenvolvimento. Nenhuma migration nova é necessária.

O frontend preserva o rascunho em `409 profile_changed`, exige atualização explícita dos dados e revisão antes de salvar novamente. O sucesso atualiza a identidade exibida sem renovar ou encerrar sessões. Consultar [Configurações no frontend](../../frontend/docs/settings.md).
