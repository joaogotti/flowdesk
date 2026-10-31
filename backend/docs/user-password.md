# Alteração da própria senha

`PUT /api/user/password` exige autenticação Sanctum por sessão, usuário ativo, perfil atual requester/technician/admin e versão de sessão válida. O alvo é sempre a própria identidade autenticada. O formulário separado em `#/configuracoes` consome esse endpoint; nenhuma migration nova é necessária.

## Contrato

Enviar somente estes três campos no corpo, sem arquivos ou query string:

```json
{
  "current_password": "<senha atual>",
  "password": "<nova senha conforme a política>",
  "password_confirmation": "<mesma nova senha>"
}
```

Substitua os marcadores pelos valores informados no formulário; eles não são credenciais utilizáveis. Não registrar corpos de requisição ou credenciais.

A política da nova senha é compartilhada com o cadastro administrativo em `UserPasswordPolicy`: mínimo de 12 caracteres, maiúsculas/minúsculas, número, símbolo e máximo de 72 bytes para bcrypt. Todos os campos devem ser strings obrigatórias, sem NUL e com no máximo 72 bytes. A senha atual não precisa atender à complexidade nova, permitindo substituir senhas legadas mais fracas. A confirmação deve coincidir exatamente com a nova senha, e reutilização da senha vigente é rejeitada.

Os campos padrão `current_password`, `password` e `password_confirmation` já são excluídos do trim e do flash de inputs do Laravel. Não há normalização: espaços nas extremidades fazem parte da senha. O hash é calculado explicitamente com o `Hash` configurado, antes de atribuir ao modelo, inclusive quando a entrada literal tem o formato de um hash.

HTTP **200**, com `Cache-Control: private, no-store`:

```json
{
  "message": "Senha alterada. Todas as sessões foram encerradas. Entre novamente.",
  "code": "password_changed",
  "reauthentication_required": true
}
```

Não retorna usuário, senha, hash, versão ou identificadores de sessão. O frontend limpa a identidade local e exige novo login após esse sucesso, sem tentar renovar a sessão antiga ou chamar logout novamente. A mensagem no login é **“Senha alterada. Entre novamente com a nova senha.”** Os campos de senha são limpos após o sucesso e ao desmontar o formulário. Ver [ciclo de autenticação do frontend](../../frontend/docs/authentication-lifecycle.md).

## Autorização e erros

- 401: visitante ou sessão revogada; incompatibilidade detectada pelo mecanismo de versão mantém `code: session_revoked`.
- 403: conta desativada ou perfil atual sem permissão, inclusive após aguardar o lock.
- 409 com `session_version_exhausted`: contador no limite do inteiro suportado, sem gravação.
- 419: CSRF inválido/ausente numa requisição stateful, ou ausência de sessão no endpoint.
- 422: campos inválidos, senha atual incorreta, nova senha reutilizada, confirmação divergente, campos extras, query ou arquivos.
- 429: limite de tentativas excedido, com `Retry-After` em segundos.
- 503: armazenamento de sessões incompatível ou falha operacional. Falhas inesperadas usam `code: password_change_unavailable`, sem SQL ou detalhes sensíveis. Não repetir automaticamente uma gravação cujo resultado não pôde ser confirmado.

Senha atual incorreta é erro de validação em `errors.current_password`, não um 401 que encerraria a sessão. Não foram alterados os comportamentos gerais de 401, 403 ou 419. O middleware nativo do Sanctum também pode negar uma sessão antiga por diferença de hash, com 401 genérico antes do middleware de versão; ambos os caminhos impedem acesso.

## Limite de tentativas

`ThrottlePasswordChanges` é aplicado somente a esta rota, depois de autenticação, versão e atividade. Usa o `RateLimiter` e o cache configurados no projeto, com chaves SHA-256 separadas: 5 tentativas por usuário e 20 por IP a cada janela de 60 segundos. Trocar IP não reinicia o limite do usuário; trocar usuário não reinicia o limite do IP. Payloads inválidos contam, antes da validação e do hashing. Falhas de CSRF são tratadas anteriormente pelo pipeline stateful.

Os limites não são zerados ao concluir a operação. O cache de produção precisa ser compartilhado entre os processos/instâncias. A admissão segue o padrão existente de consulta e incremento do RateLimiter; não é uma reserva transacional de slots, portanto rajadas simultâneas podem ultrapassar pontualmente o limite.

## Transação e sessões

`ChangeUserPassword` exige uma transação externa própria, sem transação previamente aberta. Recarrega a linha com `FOR UPDATE`, revalida a versão capturada na requisição, atividade e perfil, e verifica a senha atual contra o hash fresco. Uma validação feita apenas contra o usuário do guard não seria suficiente após aguardar uma alteração concorrente.

Na mesma transação, grava o hash novo pelo mecanismo existente, incrementa `session_version` monotonicamente e exclui os registros de sessões do usuário. Nome, e-mail, perfil, atividade, remember token, vínculos, chamados e demais atributos permanecem intactos; somente senha, versão e `updated_at` mudam. Falha de gravação ou exclusão desfaz todos os efeitos transacionais. Não há auditoria com senhas ou hashes.

Sessões persistidas devem usar o driver `database` e a mesma conexão da transação. Configurações incompatíveis falham antes de gravar. `array` é permitido somente em testes isolados. Não há suporte a limpeza distribuída por Redis/arquivos nesta etapa.

Após o commit, o controller encerra o guard web, limpa também a identidade em cache do Sanctum, invalida a sessão corrente e regenera CSRF. A nova sessão é anônima, sem versão de autenticação. As outras sessões ficam revogadas e exigem novo login na próxima requisição; não existe remoção remota de dados já exibidos nem cancelamento de bytes já autorizados.

Uma requisição/login anterior pode salvar uma sessão depois da exclusão física. Ela mantém a versão antiga e não recupera acesso. Nunca adotar a nova versão na sessão antiga. Um login que autenticou antes do corte pode terminar com 200 e ainda assim receber 401 no acesso seguinte. Somente um novo login com a senha nova obtém a versão vigente. Consultar também [session-versions.md](session-versions.md).

Falhas inesperadas são registradas apenas com mensagem fixa e código operacional. O controller não encaminha a exceção original ao logger, pois parâmetros de exceções SQL podem conter o hash. Logs de infraestrutura, proxies ou ferramentas externas também devem evitar capturar corpos desta rota.

## Testes isolados

`UpdateUserPasswordTest` usa SQLite em memória e fixtures próprias sem migrations. Cobre perfis, política compartilhada, senhas legadas/espaços/NUL/Unicode, 72 bytes, confirmação, reutilização, entrada em formato de hash, sessão/CSRF, limites independentes, estado fresco sob lock, esgotamento, rollback e logs sem dados sensíveis.

`UpdateUserPasswordPostgresqlTest` exige host `flowdesk-password-test-<hex>`, banco inicialmente vazio `flowdesk_password_test` e cria somente fixtures. Kernels independentes com cookies criptografados e sessões em banco exercitam: duas trocas simultâneas, escrita de perfil e login antigos aguardando a troca, persistência tardia de login, múltiplos dispositivos, preservação de sessões de outras contas e revalidação de hash/versão após espera real pelo lock. O banco e os volumes de desenvolvimento nunca são alvos desses testes.
