<?php

namespace App\Http\Requests;

// Cadastro e edição aceitam exatamente o mesmo contrato de nome e autorização.
class UpdateCategoryRequest extends StoreCategoryRequest {}
