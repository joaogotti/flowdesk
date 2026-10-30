# Dependências PHP no desenvolvimento local

O backend usa PHP 8.4 com Composer 2 na imagem Docker. Não é necessário instalar
PHP ou Composer no Windows para instalar as dependências.

Execute os comandos a partir da raiz do repositório, após configurar os arquivos
`.env` locais usando os exemplos do projeto. O Compose exige `DB_PASSWORD` no
`.env` da raiz; o `.env` do backend deve usar a mesma senha para o PostgreSQL.

```powershell
docker compose build backend
docker compose run --rm --no-deps backend composer install --no-interaction --prefer-dist
docker compose up -d
```

`composer install` utiliza as versões de `backend/composer.lock`, incluindo as
dependências de desenvolvimento e testes. Ele executa os scripts de instalação
e descoberta de pacotes já definidos em `composer.json`.

O bind mount `./backend:/var/www/html` oculta o conteúdo que existisse nesse
diretório na imagem. Por isso, a instalação é feita explicitamente pelo container
temporário, depois da montagem, criando `backend/vendor/` no computador local.
O container temporário é removido ao terminar; os serviços e volumes existentes
não são removidos por esse comando.

O servidor não executa Composer na inicialização. Após um clone limpo ou uma
mudança no lockfile, execute novamente o comando de instalação. Em inicializações
normais, basta usar `docker compose up -d`.

Para conferir a instalação com os serviços em execução:

```powershell
docker compose exec backend composer --version
docker compose exec backend composer check-platform-reqs
docker compose exec backend php artisan --version
docker compose exec backend php artisan test
```

Os testes usam o SQLite em memória configurado em `backend/phpunit.xml`.
Este procedimento instala dependências PHP; não gera `APP_KEY`, não executa
migrations nem cria usuários. Essas etapas de configuração da aplicação são
separadas. Não é necessário executar `composer update` ou `composer run setup`
para instalar as dependências já fixadas no lockfile.

## Armazenamento privado de anexos

O backend possui um volume dedicado `attachments_data` e limites PHP de 5 MiB
por arquivo / 8 MiB por requisição multipart. As configurações requerem rebuild
e recriação somente do backend para entrar em vigor. A infraestrutura já está
ativa no desenvolvimento, com PostgreSQL e volumes preservados. Não remover
volumes para atualizar a imagem.

Consulte [a documentação de armazenamento](../backend/docs/attachment-storage.md)
para permissões, persistência, testes isolados e backup/restauração coordenados
com o PostgreSQL. Não expor esse volume em `public/storage`.
