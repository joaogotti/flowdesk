# Perda de autenticação no frontend

O transporte em `src/services/api.ts` trata JSON e downloads privados pelo mesmo ciclo de autenticação. A identidade permanece apenas no estado React; não é persistida em localStorage.

## Respostas e mensagens

| Resposta | Comportamento |
| --- | --- |
| 401 de endpoint protegido, inclusive vazio ou sem JSON | Descarta a autenticação atual e os dados protegidos. Se havia identidade confirmada, mostra “Sua sessão expirou. Entre novamente.” |
| 401 protegido com `code: session_revoked` | Descarta a autenticação e mostra “Sua sessão foi revogada. Entre novamente.” |
| 401 de POST `/login` | Mantém o formulário e informa credenciais inválidas. |
| Falha na inicialização pública de CSRF | Informa o erro sem concluir que a identidade foi revogada. |
| 403 ou 419 | Preserva a autenticação e o tratamento específico do fluxo. |
| Logout confirmado com 204 | Limpa a identidade sem mensagem de expiração. |
| PUT `/user/password`, 200 com `code: password_changed` e `reauthentication_required: true` | Limpa a identidade e mostra “Senha alterada. Entre novamente com a nova senha.” |

O carregamento inicial anônimo com 401 abre o login sem uma mensagem falsa de expiração. O endpoint público de saúde também não provoca perda de autenticação.

O Sanctum pode responder 401 genérico quando uma sessão foi excluída, expirou ou deixou de autenticar após alteração da senha, antes da verificação de `session_version`. Sem um código explícito não é possível distinguir essas causas; todas exigem novo login. Não há repetição automática de gravações nem tentativa de renovar a sessão antiga.

## Concorrência e limpeza

Cada tentativa de login e encerramento de autenticação avança uma geração local. Requisições capturam a geração, combinam cancelamento externo com um AbortController interno e verificam a geração antes e depois da leitura da resposta. Respostas antigas são descartadas com `ObsoleteRequestError`, inclusive se o transporte ignorar o cancelamento.

As gravações mantêm a mesma geração entre a inicialização CSRF e a chamada protegida. Uma inicialização antiga não pode iniciar uma gravação na autenticação seguinte. A consulta de identidade compartilha somente a promessa da geração vigente; a conclusão de uma consulta antiga não remove a promessa de uma consulta nova.

`onAuthenticationLost` centraliza a notificação. O App limpa identidade, mensagens e estados de operação e desmonta a árvore autenticada. Essa árvore recebe uma chave por geração para não reutilizar dados entre sessões, inclusive de uma mesma conta. Relatórios também cancelam as exportações pendentes. Respostas tardias de identidade, login, logout, listagens e downloads não podem restaurar dados nem encerrar um login posterior.

O formulário de senha em `#/configuracoes` usa o transporte existente com o contrato acima. O sucesso confirmado já encerra o estado local e apresenta a mensagem, sem chamar logout novamente. Ver [settings.md](settings.md) para os formulários e seus testes.

## Verificação e limites

`tests/authentication-lifecycle.test.mjs` cobre os estados do transporte, cancelamentos e corridas de promessas. `tests/authentication-lifecycle.browser.test.mjs` verifica limpeza visual, mensagens, login/logout e respostas atrasadas no navegador. Os testes de navegador usam transporte simulado, sem backend ou banco de dados.

A geração é local ao documento. Outra aba ou dispositivo percebe a perda de autenticação na próxima requisição protegida; não há notificação remota imediata. Cancelar uma requisição no navegador não desfaz uma operação já recebida pelo servidor nem impede que o navegador processe cookies de uma resposta já enviada. A autorização e a revogação efetiva continuam sendo responsabilidade do backend.
