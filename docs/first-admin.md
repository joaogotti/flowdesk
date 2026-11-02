# Primeiro administrador

Não há cadastro público nem uma conta padrão. O primeiro administrador pode ser criado pelo **Tinker**, já incluído nas dependências, usando o modelo `User` e a política de senha da aplicação.

Este procedimento é destinado ao banco novo `flowdesk`, após as migrations. O bloco interrompe a execução se a conexão efetiva apontar para outro banco ou se já existir qualquer usuário.

Na raiz, abra um terminal interativo:

```powershell
docker compose exec backend php artisan tinker
```

Cole o bloco abaixo no Tinker. Informe nome, e-mail e senha nos prompts; a senha e a confirmação são mascaradas, sem incluí-las no comando ou no histórico do Tinker.

```php
(function () {
    $db = Illuminate\Support\Facades\DB::connection();
    if ($db->getDriverName() !== 'pgsql' ||
        $db->getDatabaseName() !== 'flowdesk' ||
        $db->selectOne('select current_database() as name')->name !== 'flowdesk') {
        throw new RuntimeException('Banco inesperado. Confira a configuração antes de continuar.');
    }
    if (App\Models\User::query()->exists()) {
        throw new RuntimeException('Já existem usuários. Este procedimento é apenas para o primeiro acesso.');
    }

    $data = [
        'name' => trim(Laravel\Prompts\text('Nome do administrador', required: true)),
        'email' => strtolower(trim(Laravel\Prompts\text('E-mail', required: true))),
        'password' => Laravel\Prompts\password('Senha', required: true),
        'password_confirmation' => Laravel\Prompts\password('Confirme a senha', required: true),
    ];

    validator($data, [
        'name' => ['required', 'string', 'max:255', 'not_regex:/\x00/u'],
        'email' => ['required', 'string', 'email', 'max:255', 'not_regex:/\x00/u'],
        'password' => App\Support\UserPasswordPolicy::newPasswordRules(),
        'password_confirmation' => ['required', 'string'],
    ])->validate();

    App\Models\User::create([
        'name' => $data['name'],
        'email' => $data['email'],
        'password' => $data['password'],
        'role' => 'admin',
    ]);
    unset($data);
    echo "Administrador criado.\n";
})();
```

Use uma senha exclusiva com pelo menos 12 caracteres, letras maiúsculas e minúsculas, número e símbolo, respeitando o limite de 72 bytes. O modelo aplica o hash da senha automaticamente. Se a validação falhar, nenhum usuário será criado; corrija a entrada antes de repetir o bloco.

Saia com `exit` e entre na interface com a conta informada. Após o primeiro acesso, a área de usuários permite cadastrar solicitantes e técnicos e administrar seus perfis.

[Voltar à instalação no README](../README.md#executar-localmente).
