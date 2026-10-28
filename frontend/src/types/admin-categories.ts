import type { Category } from './categories'

export interface CreateCategoryInput {
  name: string
}

export type UpdateCategoryInput = CreateCategoryInput

export interface UpdateCategoryStatusInput {
  is_active: boolean
}

export interface AdminCategory extends Category {
  is_active: boolean
  tickets_count: number
}
