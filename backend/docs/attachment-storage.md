# Infraestrutura privada de anexos

Esta infraestrutura fornece armazenamento privado e limites de transporte. A V1 utiliza JPG, PNG, PDF e TXT, até 5 MiB por arquivo, 10 anexos e 25 MiB por chamado. A configuração PHP não substitui a validação de conteúdo, quota e autorização na aplicação.

## Disco e privacidade

O disco Laravel `attachments` usa `storage/app/attachments`, com visibilidade de arquivos e diretórios `private`, `serve: false` e `throw: true`. Não é o disco padrão. Erros de escrita geram exceções, em vez de serem confundidos com sucesso.

A raiz é irmã de `app/private` e `app/public`, não fica dentro delas. O disco `local` existente continua tendo sua rota assinada, mas sua raiz não contém os anexos. Não há rota automática de leitura/upload nem geração de URL temporária para `attachments`. Uma chamada a `url()` não é uma autorização ou um endpoint de download.

Não adicionar essa raiz a `filesystems.links`, não criar links em `public/` para ela e não configurar aliases do servidor HTTP para servi-la. `storage:link` continua expondo apenas o disco público existente. Não guardar anexos em `public`, `app/public` ou na árvore servida pelo disco `local`. Downloads devem usar controllers autenticados e revalidar a visibilidade do chamado e a versão da sessão.

O administrador do host ou um processo privilegiado continua podendo ler arquivos ou criar links manualmente. Configuração privada não é isolamento contra o próprio host; o volume deve ser exclusivo de processos confiáveis.

## Docker, permissões e ativação

O Compose adiciona o volume lógico `attachments_data`, montado em `/var/www/html/storage/app/attachments`. O bind mount do backend, o serviço PostgreSQL e `postgres_data` permanecem como estavam. O nome efetivo do volume inclui o projeto Compose; por exemplo, `flowdesk_attachments_data`. Mudanças de nome do projeto podem selecionar outro volume.

Os arquivos residem no volume gerenciado pelo Docker, fora da cópia de código no OneDrive. O volume sobrepõe somente esse subdiretório do bind mount. Recriar o contêiner ou reconstruir a imagem preserva o volume; não protege contra exclusão explícita do volume, falha do host ou perda do Docker Desktop. Ele não é um backup.

O entrypoint usa `umask 077` durante a preparação, recusa raiz simbólica, cria/confere somente a raiz dos anexos e aplica modo `0700`. Depois restaura a umask anterior, preservando o comportamento dos demais arquivos da aplicação. O driver privado cria arquivos `0600` e subdiretórios `0700` no Linux. O processo PHP precisa ser dono da raiz; não há `chmod`/`chown` recursivo nem uso de `777`. O entrypoint delega ao `docker-php-entrypoint` original e mantém o CMD existente. A imagem atual executa como root; mudar o usuário de runtime exige planejar a propriedade do volume separadamente.

`docker/php/uploads.ini` define `file_uploads=On`, `upload_max_filesize=5M`, `post_max_size=8M` e `max_file_uploads=1`. `5M` corresponde a 5.242.880 bytes. O limite do corpo deixa margem para multipart. PHP pode descartar arquivos além do limite; o endpoint também deve validar o contrato de um único arquivo e tratar erros de upload. Limites de proxy/servidor adicionais devem ser compatíveis.

**A infraestrutura já está ativa no desenvolvimento.** A imagem foi reconstruída e somente o backend foi recriado pelo procedimento autorizado, preservando PostgreSQL e volumes. Em novos ambientes, as configurações entram em vigor após reconstruir a imagem e recriar somente o backend. Antes de trocar a montagem, conferir se há arquivos anteriores nesse caminho: uma montagem de volume pode ocultar conteúdo do bind mount. Não executar `docker compose down -v`, `docker volume prune` ou remover volumes de dados.

## Backup coordenado com PostgreSQL

Executar por procedimento autorizado, sem publicar conteúdo, nomes de anexos ou credenciais. `backups/` é ignorado pelo Git. Tratar o arquivo de backup como dado confidencial; manter cópia fora do host e com acesso restrito.

1. Identificar o contêiner backend e seu volume real: `docker compose ps -q backend` e `docker inspect <id> --format '{{json .Mounts}}'`. Confirmar que o mount de anexos é do tipo volume e validar o nome com `docker volume inspect <nome>`. Não adivinhar um nome: Docker pode criar um volume vazio se o nome estiver errado.
2. Abrir janela de manutenção, impedir novos uploads e aguardar operações em andamento. Pelo procedimento autorizado, reconciliar reservas expiradas e aguardar as reservas ainda válidas antes da cópia. Pausar também outros escritores que afetem metadados/arquivos; o modo de manutenção HTTP sozinho não pausa workers.
3. Gerar `pg_dump` completo em formato custom para arquivo, seguindo o procedimento seguro do projeto. Evitar redirecionar bytes binários pelo pipeline do Windows PowerShell; gerar o arquivo no contêiner e copiá-lo com `docker cp`.
4. Arquivar o volume completo, incluindo subdiretórios ocultos, com um contêiner auxiliar sem rede, montando o volume **somente para leitura** e sobrescrevendo o entrypoint. Pode-se usar a própria imagem PHP já construída, sem instalar ferramentas. A pasta de destino deve ser `backups/<identificador-da-copia>/`.

Exemplo da operação de arquivos, após substituir e conferir os caminhos/nomes reais (não executar literalmente os marcadores):

```text
docker run --rm --network none --mount type=volume,src=<volume-conferido>,dst=/data,readonly --mount type=bind,src=<backup-absoluto>,dst=/backup --entrypoint tar <imagem-backend> -C /data -czpf /backup/attachments.tar.gz .
```

5. Registrar no mesmo conjunto: dump, arquivo de anexos, SHA-256 de ambos, data UTC, versão do esquema, volume e contagens. Quando houver metadados, comparar chaves, tamanhos e hashes dos anexos confirmados. Um dump isolado não contém os bytes dos arquivos.
6. Validar ambos por restauração isolada antes de encerrar a manutenção. Verificar integridade referencial e ausência de metadados confirmados sem arquivo. Retomar escritores somente após concluir a cópia coordenada.

## Restauração

Primeiro restaurar o dump em PostgreSQL isolado e extrair o arquivo em **um novo volume descartável**, com o backend parado. Conferir o conteúdo do tar antes de extrair e utilizar somente backups confiáveis, sem caminhos absolutos, traversal ou links inesperados. A extração deve preservar permissões (`tar -xzpf ... -C <montagem-isolada>`). Verificar hashes, contagens, proprietário e correspondência dos arquivos com os metadados.

Recuperação no ambiente real exige autorização específica: bloquear escritores, preservar banco/volume anteriores, restaurar o par correspondente e conferir a configuração do volume antes de iniciar o backend. Não sobrepor um backup a um volume ativo nem restaurar apenas o PostgreSQL. Não reiniciar sequências ou editar metadados para ocultar divergências. Se o UID de runtime mudar, ajustar a propriedade por procedimento específico; não abrir permissões para todos os usuários.

## Git, imagem e verificações

`backend/storage/app/.gitignore` já ignora `attachments/`; `.dockerignore` exclui os dados de runtime do contexto de build. Não usar `git add -f` nessa árvore. Fixtures devem usar diretórios temporários, sem dados reais.

`AttachmentStorageTest` usa um filesystem local real com raiz temporária: verifica privacidade, isolamento dos discos servidos, bloqueio de URL temporária/traversal, permissões e exceções de escrita. Não resolve o disco real de desenvolvimento.

```text
node --test docker/tests/attachments-storage.test.mjs
```

Os testes de configuração verificam o Compose renderizado com senha de teste e os caminhos ignorados, sem criar anexos. A integração Docker é opt-in e usa imagem, contêineres e volume com nomes aleatórios, `--network none`, sem bind mount de desenvolvimento ou PostgreSQL. Ela grava um marcador sintético, remove/recria apenas seu contêiner, comprova persistência, confere PHP/permissões e testa HTTP real, inclusive com o link público padrão e uma URL assinada de traversal.

```powershell
$env:FLOWDESK_RUN_DOCKER_TESTS='1'
node --test docker/tests/attachments-storage.test.mjs
```

A integração requer Docker, Node, tar e as dependências Composer locais já instaladas. Não instala dependências Composer/npm ou pacotes no host; o build pode acessar os repositórios para os pacotes já previstos no Dockerfile. Os contêineres de teste executam sem rede. A integração remove somente seus próprios recursos descartáveis. Não executar testes de escrita contra `attachments_data` de desenvolvimento.

Em hosts com leitura lenta, pode-se fornecer `FLOWDESK_TEST_VENDOR_ARCHIVE` com o caminho de um tar confiável das mesmas dependências instaladas, contendo `autoload.php` na raiz. Ele é extraído somente no contêiner descartável. Não reutilizar um arquivo de dependências incompatível com `composer.lock`. Sem essa opção, o teste prepara o tar a partir de `backend/vendor`.
