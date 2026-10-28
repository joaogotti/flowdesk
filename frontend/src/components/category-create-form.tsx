import CategoryNameForm from './category-name-form'

export default function CategoryCreateForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  return <CategoryNameForm onCancel={onCancel} onSaved={onCreated} />
}
