import type { AdminUserEditErrors, AdminUserEditValues, AdminUserFormErrors, AdminUserFormValues, UpdateAdminUserInput } from '../types/admin-users'

export const userPasswordHelp = 'Use pelo menos 12 caracteres, com letra maiúscula, letra minúscula, número e símbolo. Máximo de 72 bytes; caracteres acentuados podem ocupar mais de um byte.'

export function passwordByteLength(value: string): number {
  return Array.from(value).reduce((total, character) => {
    const point = character.codePointAt(0)!
    return total + (point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4)
  }, 0)
}

export function validateAdminUserForm(values: AdminUserFormValues): AdminUserFormErrors {
  const errors: AdminUserFormErrors = {}
  const name = values.name.trim(), email = values.email.trim()
  if (!name) errors.name = 'Informe o nome completo.'
  else if (Array.from(name).length > 255 || name.includes('\0')) errors.name = 'Informe um nome válido com até 255 caracteres.'
  if (!email) errors.email = 'Informe o e-mail.'
  else if (Array.from(email).length > 255 || /\p{Cc}/u.test(email) || !/^[^\s@]+@[^\s@]+$/u.test(email)) errors.email = 'Informe um e-mail válido com até 255 caracteres.'
  if (!['requester', 'technician'].includes(values.role)) errors.role = 'Selecione Solicitante ou Técnico.'
  const password = values.password
  if (!password) errors.password = 'Informe a senha inicial.'
  else if (password.includes('\0')) errors.password = 'A senha contém caracteres inválidos.'
  else if (passwordByteLength(password) > 72) errors.password = 'A senha deve ter no máximo 72 bytes.'
  else if (Array.from(password).length < 12 || !/\p{Ll}/u.test(password) || !/\p{Lu}/u.test(password) || !/\p{N}/u.test(password) || !/[\p{Z}\p{S}\p{P}]/u.test(password)) errors.password = 'Use pelo menos 12 caracteres, com maiúscula, minúscula, número e símbolo.'
  if (!values.password_confirmation) errors.password_confirmation = 'Confirme a senha inicial.'
  else if (values.password_confirmation !== password) errors.password_confirmation = 'A confirmação da senha não corresponde.'
  return errors
}

// Whitespace and invisible edge characters removed by Laravel Str::trim.
// NUL is deliberately preserved so it can be rejected before normalization.
const edgeCharacters = '[\\s\\u0085\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180e\\u200b-\\u200f\\u2060-\\u2065\\u206a-\\u206f\\u2800\\u3164\\uffa0\\u{1d159}\\u{1d173}-\\u{1d17a}\\u{e0020}]'
// eslint-disable-next-line no-misleading-character-class -- Laravel's list intentionally includes individual combining marks.
const edgePattern = new RegExp(`^${edgeCharacters}+|${edgeCharacters}+$`, 'gu')

function normalizeEditField(field: keyof AdminUserEditValues, value: string): string {
  const trimmed = value.replace(edgePattern, '')
  return field === 'email' ? trimmed.toLowerCase() : trimmed
}

export function normalizeAdminUserEditValues(values: AdminUserEditValues): AdminUserEditValues {
  return { name: normalizeEditField('name', values.name), email: normalizeEditField('email', values.email) }
}

export function validateAdminUserEditForm(values: Partial<AdminUserEditValues>): AdminUserEditErrors {
  const errors: AdminUserEditErrors = {}
  for (const field of ['name', 'email'] as const) {
    if (!Object.hasOwn(values, field)) continue
    const raw = values[field]
    if (typeof raw !== 'string') {
      errors[field] = field === 'name' ? 'Informe o nome completo.' : 'Informe o e-mail.'
      continue
    }
    const normalized = normalizeEditField(field, raw)
    if (!normalized) errors[field] = field === 'name' ? 'Informe o nome completo.' : 'Informe o e-mail.'
    else if (raw.includes('\0') || Array.from(normalized).length > 255) errors[field] = field === 'name' ? 'Informe um nome válido com até 255 caracteres.' : 'Informe um e-mail válido com até 255 caracteres.'
    else if (field === 'email' && (/\p{Cc}/u.test(normalized) || !/^[^\s@]+@[^\s@]+$/u.test(normalized))) errors.email = 'Informe um e-mail válido com até 255 caracteres.'
  }
  return errors
}

export function getAdminUserChanges(original: AdminUserEditValues, values: AdminUserEditValues): UpdateAdminUserInput {
  const before = normalizeAdminUserEditValues(original), after = normalizeAdminUserEditValues(values)
  return {
    ...(before.name !== after.name ? { name: after.name, expected_name: original.name } : {}),
    ...(before.email !== after.email ? { email: after.email, expected_email: original.email } : {}),
  }
}
