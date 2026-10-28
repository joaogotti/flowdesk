import { ticketPriorityLabels } from '../types/tickets'
import type { Category } from '../types/categories'
import type { CreateTicketInput } from '../types/tickets'

export interface TicketFormValues {
  title: string
  description: string
  category_id: string
  priority: string
}

export type TicketFormErrors = Partial<Record<keyof CreateTicketInput, string[]>>

export const ticketTitleMaxLength = 255
export const ticketDescriptionMaxLength = 10000

export function validateTicketForm(values: TicketFormValues, categories: Category[]): TicketFormErrors {
  const errors: TicketFormErrors = {}
  if (!values.title.trim()) errors.title = ['Informe o título do chamado.']
  else if (Array.from(values.title.trim()).length > ticketTitleMaxLength) errors.title = ['O título deve ter no máximo 255 caracteres.']
  if (!values.description.trim()) errors.description = ['Informe a descrição do chamado.']
  else if (Array.from(values.description.trim()).length > ticketDescriptionMaxLength) errors.description = ['A descrição deve ter no máximo 10.000 caracteres.']
  if (!values.category_id || !categories.some((category) => String(category.id) === values.category_id)) {
    errors.category_id = ['Selecione uma categoria disponível.']
  }
  if (!Object.hasOwn(ticketPriorityLabels, values.priority)) errors.priority = ['Selecione uma prioridade.']
  return errors
}
