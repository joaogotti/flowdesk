FROM php:8.4-cli

# Instala o driver necessário para conectar ao PostgreSQL e a extensão intl
RUN apt-get update && apt-get install -y \
    libpq-dev \
    libicu-dev \
    unzip \
    && docker-php-ext-install pdo_pgsql intl \
    && rm -rf /var/lib/apt/lists/*

# Disponibiliza o Composer sem copiar codigo, arquivos .env ou credenciais.
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer

# Define o diretório de trabalho do Laravel
WORKDIR /var/www/html

COPY docker/php/uploads.ini /usr/local/etc/php/conf.d/flowdesk-uploads.ini
COPY docker/backend-entrypoint.sh /usr/local/bin/flowdesk-entrypoint
RUN chmod 0755 /usr/local/bin/flowdesk-entrypoint

ENTRYPOINT ["flowdesk-entrypoint"]

# Expõe a porta utilizada pelo Laravel
EXPOSE 8000

# Inicia o servidor de desenvolvimento
CMD ["php", "artisan", "serve", "--host=0.0.0.0", "--port=8000"]
