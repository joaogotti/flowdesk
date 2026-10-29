# Versão de autenticação das sessões

Esta infraestrutura garante a revogação permanente das sessões. A ativação/desativação administrativa utiliza esse protocolo; mudanças de perfil não incrementam versões.

## Esquema e implantação

A migration `2026_10_28_230000_add_session_version_to_users_table.php` adiciona `users.session_version`: bigint obrigatório, default zero, com CHECK não negativo. O down remove a coluna. A versão é interna, não preenchível por payload administrativo e oculta na serialização do modelo.

**A migration já foi aplicada e validada no PostgreSQL de desenvolvimento, após autorização explícita.** Em novos ambientes, aplicar o esquema antes de disponibilizar o código. Sem a coluna, login de contas existentes e endpoints autenticados falham de forma fechada com 503; o health público permanece disponível. Remover a coluna após começar a revogar versões não é um rollback seguro do ponto de vista de autenticação: sessões antigas não devem voltar a ser aceitas.

## Login e sessões legadas

O login lê a identidade candidata, adquire FOR UPDATE na mesma conta e verifica novamente atividade, e-mail e versão antes de autenticar. Uma mudança de versão entre a consulta inicial e o lock rejeita o login, com a resposta genérica 401 já existente. O lock é por usuário, sem advisory lock global nem locks de chamados. O lock exclusivo evita upgrade de lock compartilhado caso o guard precise recalcular o hash da senha.

Após autenticar, o login grava um inteiro em `auth_session_version`, preservando a regeneração de sessão e CSRF. O JSON de sucesso não muda. Sessões sem essa chave representam estritamente a versão zero e só funcionam enquanto a conta também estiver em zero. Chaves presentes com tipo inválido são rejeitadas. Requisições posteriores nunca atualizam a versão da sessão para a versão do banco.

## Requisições e gravações concorrentes

As rotas autenticadas, incluindo logout, passam pelo middleware `auth.session.version`, depois do Sanctum e antes de `user.active`. O middleware consulta a conta atual e captura uma cópia da versão da sessão nos atributos internos da requisição. As revalidações transacionais de gravação comparam essa cópia com a conta recarregada sob o lock já existente. Não se alteram os locks nem a autorização por perfil desses endpoints.

Uma incompatibilidade gera HTTP 401 com `code: session_revoked`; permissões comuns continuam retornando 403. O tratamento encerra apenas a sessão atual e regenera o CSRF, depois do rollback do controller, sem mudar senha ou remember_token. Logout de conta desativada com versão ainda válida continua disponível. As verificações usuais de CSRF continuam podendo retornar 419 antes da autorização.

Uma gravação que já obteve o lock compartilhado do ator pode concluir; a mudança de versão aguarda esse commit. Se a mudança de versão vencer, a gravação antiga é negada sem efeitos de negócio. O middleware não cancela leituras ou respostas já autorizadas em andamento nem remove informações já exibidas pelo navegador.

## Protocolo da ativação/desativação

O endpoint administrativo incrementa monotonicamente a versão, tanto ao desativar quanto ao reativar. Nunca zerar, diminuir ou reutilizar versões. Atualização de situação, incremento, exclusão de sessões e auditoria são atômicos sob FOR UPDATE do alvo e participam do mutex administrativo usado na alteração de perfil. Consulte `admin-user-status.md` para o contrato e a migration de auditoria, já aplicada no desenvolvimento.

Excluir sessões é uma limpeza adicional, não a garantia de segurança. O Laravel salva sessões após executar o controller: um login autorizado antes do corte pode persistir sua sessão depois da exclusão. Essa sessão conserva a versão anterior e será rejeitada, inclusive após reativação. O login pode retornar 200 quando venceu o corte de autorização e ainda assim exigir novo login na requisição seguinte.

Revogação em todos os dispositivos depende da versão persistida, não de sessões lembradas em memória. SQL externo que altere apenas disabled_at não executa esse protocolo. No frontend, uma resposta 401 com `session_revoked` remove a identidade e desmonta as páginas protegidas. Respostas tardias anteriores à revogação não restauram dados ou autenticação; um 403 comum não provoca logout.

## Validação isolada

`UserSessionVersionTest` verifica versões legadas, malformadas, revogadas, contratos de autorização e revalidação em todos os endpoints de gravação.

`UserSessionVersionPostgresqlTest` exige `FLOWDESK_SESSION_PG_HOST=flowdesk-session-test-<hex>` e banco vazio `flowdesk_session_test`. Verifica a migration real, defaults/CHECK/NOT NULL/down, sessões JSON em banco, cookies criptografados e kernels HTTP independentes. As disputas usam barreiras e observam locks reais em pg_stat_activity, incluindo login versus revogação, persistência tardia, comentários, atribuição e múltiplos dispositivos. Esse teste nunca pode apontar para o banco de desenvolvimento.
