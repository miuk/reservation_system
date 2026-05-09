export type Period = 'morning' | 'afternoon' | 'night';
export type Slot = { date: string; period: Period };
export type ReservationStatus = 'pending' | 'approved' | 'cancelled';
export type ReservationActor = { uid?: string; email?: string; name?: string; role?: string; isAdmin?: boolean };

export const PERIODS: Array<{ id: Period; label: string }> = [
  { id: 'morning', label: '午前' },
  { id: 'afternoon', label: '午後' },
  { id: 'night', label: '夜' }
];

export function isoDate(date: Date) {
  const copy = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  return copy.toISOString().slice(0, 10);
}

export function addMonths(date: Date, months: number) {
  const copy = new Date(date.getFullYear(), date.getMonth(), 1);
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

export function slotKey(slot: Slot) {
  return `${slot.date}_${slot.period}`;
}

export function monthDays(month: Date) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const first = new Date(year, monthIndex, 1);
  const last = new Date(year, monthIndex + 1, 0);
  const days: Array<Date | null> = Array.from({ length: first.getDay() }, () => null);
  for (let day = 1; day <= last.getDate(); day += 1) {
    days.push(new Date(year, monthIndex, day));
  }
  return days;
}

export function printRangeDays(month: Date) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  let firstTuesday = new Date(year, monthIndex, 1);
  while (firstTuesday.getDay() !== 2) {
    firstTuesday = new Date(year, monthIndex, firstTuesday.getDate() + 1);
  }
  const start = new Date(firstTuesday);
  start.setDate(firstTuesday.getDate() - firstTuesday.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

export function statusLabel(status: ReservationStatus) {
  return { pending: '仮予約', approved: '予約確定', cancelled: '取消済み' }[status];
}

export function slotLabel(slot: Slot) {
  return `${slot.date} ${PERIODS.find((period) => period.id === slot.period)?.label || slot.period}`;
}

export function dateTimeLabel(value: string | null | undefined) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

export function actorLabel(actor: ReservationActor | null | undefined) {
  if (!actor) return '-';
  return actor.name || actor.email || '-';
}
