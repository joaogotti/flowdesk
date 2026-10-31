import type { PasswordChangeInput } from '../services/settings'
import { passwordByteLength } from './admin-user-form'

export type PasswordChangeErrors = Partial<Record<keyof PasswordChangeInput, string>>

export function validatePasswordChange(values: PasswordChangeInput): PasswordChangeErrors {
  const errors: PasswordChangeErrors = {}
  for (const field of ['current_password', 'password', 'password_confirmation'] as const) {
    const value = values[field]
    if (!value) errors[field] = 'Preencha este campo.'
    else if (value.includes('\0')) errors[field] = 'A senha contém caracteres inválidos.'
    else if (passwordByteLength(value) > 72) errors[field] = 'A senha deve ter no máximo 72 bytes.'
  }
  const password = values.password
  if (!errors.password && (Array.from(password).length < 12 || !/\p{Ll}/u.test(password) || !/\p{Lu}/u.test(password) || !/\p{N}/u.test(password) || !/[\p{Z}\p{S}\p{P}]/u.test(password))) {
    errors.password = 'Use pelo menos 12 caracteres, com maiúscula, minúscula, número e símbolo.'
  }
  if (!errors.password && password === values.current_password) errors.password = 'A nova senha deve ser diferente da senha atual.'
  if (!errors.password_confirmation && values.password_confirmation !== password) errors.password_confirmation = 'A confirmação da senha não corresponde.'
  return errors
}
