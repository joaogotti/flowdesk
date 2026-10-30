# Exportação CSV administrativa

`GET /api/reports/tickets/export` exige administrador ativo, Sanctum e versão válida de sessão. A interface administrativa em `#/relatorios` disponibiliza a ação **Exportar CSV**, usando o período e os filtros aplicados à tabela.

## Interface administrativa

A exportação inclui todas as páginas da seleção aplicada, até o limite de 5.000 chamados. Enquanto houver filtros em edição, é necessário aplicá-los antes de exportar. Durante a geração, a interface bloqueia novas exportações e alterações de filtros e paginação.

O frontend recebe o arquivo como Blob e inicia o download como `flowdesk-chamados.csv`; o nome com referência UTC descrito abaixo é o enviado pelo endpoint no cabeçalho HTTP. A interface informa que as datas do CSV estão em UTC, enquanto a tabela apresenta o horário de Brasília, e orienta a preservar os prefixos de proteção das células.

Erros de validação, limite de exportação, autorização e indisponibilidade são apresentados sem expor detalhes internos. A exportação utiliza o tratamento compartilhado de sessões revogadas, cancela requisições pendentes e impede o download de respostas anteriores à revogação. Os testes de serviço estão em `frontend/tests/reports.test.mjs`, e os fluxos de interface em `frontend/tests/reports.browser.test.mjs`, com transporte simulado.

## Contrato

Aceita exatamente a validação da tabela: `start_date`, `end_date`, `assigned_to`, `category_id`, `priority`, `status`, `page` e `per_page`. Datas usam o mesmo padrão de 30 dias, limite de um ano de calendário, `America/Sao_Paulo` e intervalo UTC semiaberto. Todos os filtros são combinados e representam atributos atuais. `assigned_to=unassigned` seleciona chamados sem responsável. Usuários/categorias inativos continuam consultáveis.

`page` e `per_page` são validados pelas mesmas regras da tabela, mas **não limitam a exportação**. O CSV contém todos os resultados da seleção, em `created_at DESC, id DESC`.

- 200: download, inclusive quando não há resultados (somente cabeçalho).
- 401: sem autenticação ou `code: session_revoked`.
- 403: perfil/situação sem permissão, incluindo perda de autorização durante a geração.
- 422: query inválida ou seleção acima de 5.000 registros. Neste último caso: `{"message":"A exportação permite no máximo 5.000 chamados. Restrinja os filtros e tente novamente.","code":"export_limit_exceeded","limit":5000}`.
- 503 com `report_unavailable`: falha de consulta, temporário ou serialização, sem SQL, caminho privado ou arquivo parcial na resposta.

Não há truncamento silencioso. O limite é inclusivo: 5.000 registros são aceitos; 5.001 são rejeitados. Não é necessário calcular a contagem completa de uma seleção maior: a consulta de admissão considera no máximo 5.001 resultados.

## Formato e segurança das células

Codificação UTF-8 com BOM (`EF BB BF`), separador **ponto e vírgula**, aspas duplas e final de linha CRLF. A serialização utiliza `fputcsv` com escape proprietário desativado; aspas e separadores dentro das células seguem o formato CSV. Compatível com importação de texto no Excel; configurações regionais diferentes podem exigir selecionar explicitamente `;` e UTF-8. Não é XLSX.

As 13 colunas são: ID, título, solicitante, responsável atual, categoria, prioridade, status, criação UTC, primeira resposta UTC, resolução UTC, fechamento UTC, SLA primeira resposta e SLA resolução. Datas usam ISO 8601 UTC. Datas opcionais e responsável ausente são células vazias. SLA mantém os códigos da tabela/resumo, sem redefinir as regras. Não são exportados descrição, comentários, anexos, caminhos de armazenamento, e-mails, credenciais ou sessão.

Toda célula textual não vazia de dados recebe **apóstrofo ASCII no início**, incluindo nomes, título, status, datas e classificações. Não se tenta identificar apenas fórmulas conhecidas: a mesma proteção cobre `=`, `+`, `-`, `@`, espaços iniciais, variantes Unicode de largura completa e textos já iniciados por apóstrofo. Controles Unicode, caracteres de formatação e separadores de linha/parágrafo tornam-se espaços; isso inclui tabulação, CR/LF, NUL, BOM embutido e controles bidirecionais. UTF-8 inválido interrompe a geração. O ID é um inteiro controlado pelo banco e os cabeçalhos são constantes do servidor.

O CSV é uma representação para consulta em planilha, não uma cópia literal: o apóstrofo pode ficar visível conforme o importador e controles/quebras de linha são substituídos. A neutralização nunca modifica o valor no banco.

**Limitação:** não existe proteção universal para todos os programas de planilha ou consumidores. Salvar/reabrir, converter formatos, remover prefixos ou reimportar pode alterar a interpretação e reativar fórmulas. Não prometer segurança após essas transformações nem remover os prefixos automaticamente. Os testes comprovam os bytes e a serialização, não a execução de todas as versões/configurações do Excel. Referência: [OWASP CSV Injection](https://community.owasp.org/attacks/CSV_Injection).

## Consistência, recursos e autorização

`ReportTickets::query()` e `publicData()` são reutilizados, assim como `ReportTicketsQuery`, validação de datas/filtros e classificação de SLA. Os três endpoints existentes mantêm seus contratos; filtros da tabela/CSV não alteram os cartões do resumo.

Contagem limitada e leitura em lotes de 200 registros usam o mesmo snapshot PostgreSQL `REPEATABLE READ READ ONLY`. A paginação interna é por chave composta (criação/ID), sem OFFSET, evitando omissões entre empates. Alterações concorrentes não afetam os resultados já selecionados nesse snapshot.

Somente um lote de objetos é mantido de cada vez. Os bytes CSV são preparados em `php://temp/maxmemory:1048576`: até 1 MiB em memória, com excedente em arquivo temporário privado do sistema operacional. Não utiliza o disco `attachments`, volume de anexos ou diretório público. O recurso é fechado em falhas de geração/autorização e após transmissão; não há arquivo persistente para reutilização ou URL pública. É necessário espaço temporário disponível.

Não há streaming de bytes para o cliente enquanto a transação está aberta. Após gerar e encerrar o snapshot, uma leitura fresca revalida o administrador, situação ativa e versão da sessão. Falhas retornam JSON antes da entrega do arquivo, e não um erro misturado ao CSV. Uma transferência já autorizada não permite revogar bytes entregues posteriormente; a checagem final define o ponto de autorização.

O nome é gerado no servidor: `flowdesk-chamados-AAAAMMDD_HHMMSSZ.csv`, com referência UTC, sem nomes/filtros fornecidos pelo usuário. Cabeçalhos: `Content-Disposition: attachment`, `text/csv; charset=UTF-8`, tamanho em bytes, `Cache-Control: private, no-store, max-age=0, must-revalidate`, `Pragma: no-cache`, `Expires: 0`, `X-Content-Type-Options: nosniff` e CSP sandbox.

## Testes

`ReportExportTest` usa SQLite em memória e temporários do runner. Cobre filtros/equivalência com tabela, paginação ignorada, 5.000/5.001 registros, empates em vários lotes, codificação, caracteres especiais, fórmulas/controles/Unicode, ausência de dados internos, falhas e fechamento de recursos.

`ReportExportPostgresqlTest` exige host `flowdesk-reports-test-<hex>` e banco vazio `flowdesk_reports_test`. Usa conexão escritora independente para comprovar snapshot entre contagem/lotes e rejeição após mudança concorrente de perfil, atividade ou versão da sessão. Não executar fixtures contra o banco ou volumes de desenvolvimento.
