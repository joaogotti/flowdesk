# Cadastro administrativo de usuários

`POST /api/admin/users` exige Sanctum, conta ativa e perfil `admin`. Reutiliza sessão e CSRF existentes: visitante recebe 401, perfis não administrativos e contas desativadas recebem 403, e requisições stateful sem CSRF válido recebem 419. A autorização é revalidada no banco sob lock compartilhado durante a transação de criação.

## Requisição

```json
{
  "name": "Nome Completo",
  "email": "usuario@example.com",
  "password": "Senha!Inicial123",
  "password_confirmation": "Senha!Inicial123",
  "role": "requester"
}
```

Todos os campos são obrigatórios. Nome tem espaços externos removidos, preserva espaços internos e aceita até 255 caracteres. Não há exigência artificial de número de sobrenomes. E-mail é aparado, convertido para minúsculas, validado e limitado a 255 caracteres. Nome e senha não aceitam NUL. Somente `requester` e `technician` são permitidos; não há criação de administradores. Campos adicionais, mesmo nulos ou em query string, causam 422 (`errors.payload`), incluindo atributos internos.

A senha exige no mínimo 12 caracteres, maiúsculas e minúsculas, número e símbolo, com confirmação correspondente. Máximo de 72 **bytes**, inclusive para Unicode, para evitar truncamento pelo bcrypt atual. Não há consulta externa de senhas vazadas. A senha não é aparada. `Hash::make` usa a configuração existente; o cast `hashed` reconhece o hash resultante e não o duplica. Uma entrada que já pareça um hash é tratada como senha em texto e recebe seu próprio hash.

## Resposta

HTTP 201, exclusivamente:

```json
{
  "data": {
    "id": 9,
    "name": "Nome Completo",
    "email": "usuario@example.com",
    "role": "requester",
    "disabled_at": null,
    "created_at": "2026-10-27T12:00:00.000000Z"
  }
}
```

Conta sempre ativa; sem senha, confirmação, token, verificação de e-mail ou sessão na resposta. Validação retorna 422 com `message` e `errors`. Colisão de e-mail no INSERT também retorna 422 em `errors.email`; erros de banco distintos recebem mensagem genérica 503, sem SQL ou dados internos no corpo.

## Unicidade e concorrência

O PostgreSQL atual possui `users_email_unique`, índice único sobre `email`, com comparação sensível à capitalização. A validação consulta `LOWER(email)` para detectar também registros legados com outra capitalização, incluindo contas desativadas. Todos os e-mails deste endpoint são gravados em minúsculas; assim, duas requisições concorrentes, mesmo com capitalizações diferentes, disputam a mesma chave do índice existente. Uma vence com 201 e a outra é traduzida de `users_email_unique` para 422 após rollback. A verificação prévia sozinha não seria suficiente.

**Limitação do esquema atual:** o banco não impõe unicidade global de `LOWER(email)` a gravações externas ou a outros caminhos que não normalizem o e-mail. Uma gravação externa simultânea com capitalização diferente pode escapar do índice exato. A consulta prévia também não possui índice funcional. Garantir a regra em todos os escritores exige analisar duplicidades existentes e aprovar separadamente um índice único funcional sobre `LOWER(email)`, ou solução equivalente. Nenhuma migration ou alteração de índice integra esta etapa. Não se afirma uma garantia global que o esquema não oferece.

## Testes isolados

`StoreAdminUserTest` usa exclusivamente SQLite em memória, com guardas antes de criar tabelas. Cobre contrato, validação, hashing, autorização, sessão/CSRF, rollback e tradução de conflitos sem divulgar restrições internas. `AdminIndexUserTest` preserva as verificações de listagem e passa a reconhecer a nova rota POST protegida.

`StoreAdminUserPostgresqlTest` é opcional e exige `FLOWDESK_USER_CREATION_PG_HOST` com hostname `flowdesk-user-create-test-<hex>` e banco fixo `flowdesk_user_creation_test`, inicialmente vazio. Executa somente as migrations existentes de usuários nesse banco descartável, nunca no `flowdesk`. Dois kernels independentes chegam ao INSERT antes da liberação do lock, comprovando 201/422 com e-mails idênticos e com capitalizações diferentes. Sessões e cache usam arrays; nenhuma sessão persistente é criada. O container descartável deve ser removido após a execução.
