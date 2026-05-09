import { describe, expect, it } from 'vitest';
import {
  actorLabel,
  addMonths,
  dateTimeLabel,
  isoDate,
  monthDays,
  printRangeDays,
  slotKey,
  slotLabel,
  statusLabel
} from './reservationUtils';

describe('reservationUtils', () => {
  it('formats a local calendar date as YYYY-MM-DD', () => {
    expect(isoDate(new Date(2026, 4, 9, 23, 59))).toBe('2026-05-09');
  });

  it('adds months from the first day of the target month', () => {
    const result = addMonths(new Date(2026, 0, 31), 1);

    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(1);
    expect(result.getDate()).toBe(1);
  });

  it('creates stable slot keys and labels', () => {
    const slot = { date: '2026-05-09', period: 'afternoon' as const };

    expect(slotKey(slot)).toBe('2026-05-09_afternoon');
    expect(slotLabel(slot)).toBe('2026-05-09 午後');
  });

  it('pads month days with nulls before the first day', () => {
    const days = monthDays(new Date(2026, 4, 1));

    expect(days).toHaveLength(36);
    expect(days.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(days[5]?.getDate()).toBe(1);
    expect(days[35]?.getDate()).toBe(31);
  });

  it('builds a 6-week print range that starts on Sunday before the first Tuesday', () => {
    const days = printRangeDays(new Date(2026, 4, 1));

    expect(days).toHaveLength(42);
    expect(isoDate(days[0])).toBe('2026-05-03');
    expect(isoDate(days[41])).toBe('2026-06-13');
  });

  it('maps status and actor labels for display', () => {
    expect(statusLabel('pending')).toBe('仮予約');
    expect(statusLabel('approved')).toBe('予約確定');
    expect(statusLabel('cancelled')).toBe('取消済み');
    expect(actorLabel({ name: '管理者', email: 'admin@example.com' })).toBe('管理者');
    expect(actorLabel({ email: 'admin@example.com' })).toBe('admin@example.com');
    expect(actorLabel(null)).toBe('-');
  });

  it('formats empty and populated timestamps for Japanese display', () => {
    expect(dateTimeLabel(null)).toBe('-');
    expect(dateTimeLabel('2026-05-09T10:30:00.000Z')).toContain('2026');
  });
});
