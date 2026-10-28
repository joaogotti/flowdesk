import { formatTicketDate } from '../utils/ticket-dates'

export default function TicketDate({ value }: { value: string }) {
  return <time dateTime={value} title="Horário de Brasília · America/Sao_Paulo">{formatTicketDate(value)}</time>
}
