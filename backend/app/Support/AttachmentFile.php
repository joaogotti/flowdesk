<?php

namespace App\Support;

use Illuminate\Http\UploadedFile;
use Illuminate\Validation\ValidationException;
use Normalizer;

class AttachmentFile
{
    public static function inspect(UploadedFile $file): array
    {
        $name = $file->getClientOriginalPath();
        if (! $file->isValid() || ! preg_match('//u', $name) || strlen($name) > 200 ||
            $name !== trim($name) || preg_match('/[\p{C}\/\\\\:<>"|?*]/u', $name) || str_starts_with($name, '.') ||
            preg_match('/\.(php[0-9]*|phtml|phar|exe|dll|bat|cmd|sh|ps1|html?|svg|js)(\.|$)/i', $name)) {
            self::invalid();
        }
        $name = Normalizer::normalize($name, Normalizer::FORM_C);
        if (! is_string($name) || strlen($name) > 200) {
            self::invalid();
        }
        $extension = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        $mime = $file->getMimeType();
        $expected = ['jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png', 'pdf' => 'application/pdf', 'txt' => 'text/plain'];
        if (! isset($expected[$extension]) || $expected[$extension] !== $mime || $file->getSize() < 1 || $file->getSize() > 5242880) {
            self::invalid();
        }
        if (in_array($extension, ['jpg', 'jpeg', 'png'], true)) {
            $image = @getimagesize($file->getPathname());
            if (! $image || $image[2] !== ($extension === 'png' ? IMAGETYPE_PNG : IMAGETYPE_JPEG) ||
                $image[0] > 5000 || $image[1] > 5000 || $image[0] * $image[1] > 10000000) {
                self::invalid();
            }
        } elseif ($extension === 'txt') {
            $text = file_get_contents($file->getPathname());
            if ($text === false || ! preg_match('//u', $text) || preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $text)) {
                self::invalid();
            }
        } elseif (! preg_match('/^%PDF-[12]\.[0-9]/', file_get_contents($file->getPathname(), length: 8))) {
            self::invalid();
        }

        return ['original_name' => $name, 'mime_type' => $mime, 'size_bytes' => $file->getSize(),
            'sha256' => hash_file('sha256', $file->getPathname()), 'extension' => $extension === 'jpeg' ? 'jpg' : $extension];
    }

    private static function invalid(): never
    {
        throw ValidationException::withMessages(['file' => ['Arquivo inválido. Envie JPG, PNG, PDF ou TXT UTF-8 de até 5 MiB, com nome e conteúdo compatíveis.']]);
    }
}
