#!/bin/sh
set -eu

attachments_umask=$(umask)
umask 077
attachments_dir=/var/www/html/storage/app/attachments

if [ -L "$attachments_dir" ]; then
    echo 'The attachments root must be a directory, not a symbolic link.' >&2
    exit 1
fi

mkdir -p "$attachments_dir"
# Change only the root of this dedicated volume, never existing files recursively.
chmod 0700 "$attachments_dir"
if [ ! -r "$attachments_dir" ] || [ ! -w "$attachments_dir" ] || [ ! -x "$attachments_dir" ]; then
    echo 'The PHP runtime must be able to read, write and traverse attachments storage.' >&2
    exit 1
fi

umask "$attachments_umask"
exec docker-php-entrypoint "$@"
