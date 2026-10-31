# Configurações da conta

`#/configuracoes` fica disponível na sidebar para requester, technician e admin, usando o layout, os controles e as cores existentes. O menu mobile mantém seu comportamento de expansão e recolhimento. A página consulta `GET /api/user` ao ser aberta, sem usar uma cópia persistida da identidade.

## Meu perfil

- Nome editável; e-mail e perfil somente leitura.
- `PATCH /api/user/profile` envia somente `{name, expected_name}`. O nome novo segue a normalização e validação já usadas na edição administrativa. O nome original é preservado exatamente, sem normalizar a precondição.
- A resposta válida `{data: {id, name, email, role}}` atualiza o formulário e a identidade exibida no topo. Edição sem mudança efetiva não envia PATCH.
- `409 profile_changed` preserva o rascunho e bloqueia nova gravação até a consulta explícita por **Atualizar dados**. A consulta mantém o rascunho, apresenta o nome atual e atualiza a precondição; o usuário precisa revisar e salvar novamente.
- Falhas de atualização não avançam a precondição. Respostas sem confirmação ou falhas de servidor exigem consultar os dados antes de repetir uma gravação.

## Segurança

O formulário separado recebe `current_password`, `password` e `password_confirmation`. Usa os valores exatos, sem trim, e informa a política existente: pelo menos 12 caracteres, maiúscula, minúscula, número, símbolo e até 72 bytes. Valida NUL, confirmação e reutilização literal da senha atual; a validação definitiva e a verificação do hash continuam no backend.

As senhas ficam em inputs não controlados, sem armazenamento no estado React, localStorage, sessionStorage ou logs. Os inputs são limpos após sucesso e na desmontagem. Erros e campos inválidos recebem feedback acessível e foco. Uma trava síncrona impede envio duplicado, além de desabilitar os controles enquanto a operação está pendente.

`PUT /api/user/password` envia somente os três campos permitidos. O sucesso 200 precisa conter `code: password_changed` e `reauthentication_required: true`. O tratamento centralizado desmonta a interface autenticada e mostra no login **“Senha alterada. Entre novamente com a nova senha.”** Não há nova chamada de logout nem tentativa de manter a sessão.

401 protegido encerra o estado local; 403 e 419 preservam o tratamento específico; 422 associa as mensagens aos campos permitidos; 429 orienta aguardar antes de tentar novamente. Não há repetição automática de gravações. Requisições usam o transporte e a proteção por geração de autenticação existentes, inclusive entre CSRF e a gravação. Respostas de outra geração ou de formulários desmontados não atualizam a identidade.

## Administração e testes

A seção Administração aparece somente para admin, com atalhos às rotas existentes de Usuários e Categorias. Não existem novas políticas globais, permissões, dependências ou migrations.

- `tests/settings.test.mjs`: contratos, allowlists, validações, erros e respostas tardias.
- `tests/settings.browser.test.mjs`: três perfis, edição, conflito/reconsulta, senha, revogação, novo login, limpeza de campos, responsividade de 320 a 1440 px, labels e teclado.
- Testes de navegador de Usuários, Relatórios e chamados recentes atualizados para o item Configurações ativo.
- O carregador de módulos dos testes compartilha a criação e vinculação dos módulos para reproduzir uma única instância do transporte, inclusive quando múltiplas importações chegam ao mesmo módulo.

Os testes do frontend usam transporte simulado, sem acessar Laravel ou PostgreSQL. A verificação de acessibilidade cobre semântica, foco, teclado e responsividade; não substitui uma avaliação completa com leitor de tela. Os limites de detecção entre abas permanecem documentados em [authentication-lifecycle.md](authentication-lifecycle.md).

## Validação integrada

Foram aprovadas 19 verificações integradas com frontend, backend real e PostgreSQL descartável. O roteiro cobriu os três perfis, identidade, cookies/CORS/CSRF, edição e conflito de nome, atributos protegidos, validações, troca de senha e revogação em outro navegador, login com a senha nova, limites individuais e por IP, requisições concorrentes, respostas atrasadas, responsividade e acessibilidade básica. As respostas vieram do backend; nos cenários de atraso, apenas a entrega de respostas reais ao frontend foi retida temporariamente.

O ambiente utilizou credenciais sintéticas, rede, portas, banco e armazenamento próprios, com destino comprovado antes das migrations. Containers, bancos, volumes, rede, processos e arquivos temporários foram removidos ao terminar. A comparação antes/depois confirmou a preservação das tabelas e sequências do desenvolvimento e dos arquivos da aplicação, incluindo os ambientes locais. Este registro não contém contas, credenciais, registros ou artefatos usados nos testes.
