import { describe, expect, it } from 'vitest';
import {
  createEnv,
  importedTimestamp,
  normalizeSlots,
  positiveIntegerEnv,
  reservationDataForImport,
  serializeAllowedUser,
  serializeReservation,
  slotId,
  userId,
  validateReservationWindow
} from './app.js';

function doc(id, data) {
  return {
    id,
    data: () => data
  };
}

function timestamp(value) {
  return {
    toDate: () => new Date(value)
  };
}

describe('app utilities', () => {
  it('reads positive integer env values with validation', () => {
    expect(positiveIntegerEnv('LIMIT', 3, {})).toBe(3);
    expect(positiveIntegerEnv('LIMIT', 3, { LIMIT: '10' })).toBe(10);
    expect(() => positiveIntegerEnv('LIMIT', 3, { LIMIT: '0' })).toThrow('LIMIT must be a positive integer.');
  });

  it('builds runtime env from provided values', () => {
    const env = createEnv({
      FIREBASE_PROJECT_ID: 'firebase-project',
      FIRESTORE_PROJECT_ID: 'firestore-project',
      ADMIN_EMAILS: ' Admin@Example.com, user@example.com ',
      RESOURCE_NAME: '体育館',
      RESERVATION_MONTHS_AHEAD: '12',
      MAX_SLOTS_PER_REQUEST: '8'
    });

    expect(env.projectId).toBe('firebase-project');
    expect(env.firestoreProjectId).toBe('firestore-project');
    expect(env.resourceName).toBe('体育館');
    expect(env.reservationMonthsAhead).toBe(12);
    expect(env.maxSlotsPerRequest).toBe(8);
    expect(env.adminEmails.has('admin@example.com')).toBe(true);
  });

  it('normalizes users and slot identifiers', () => {
    expect(userId(' User@Example.com ')).toBe('user@example.com');
    expect(slotId({ date: '2026-05-09', period: 'night' })).toBe('2026-05-09_night');
  });

  it('deduplicates and sorts slots', () => {
    const slots = normalizeSlots([
      { date: '2026-05-10', period: 'night' },
      { date: '2026-05-09', period: 'morning' },
      { date: '2026-05-10', period: 'night' }
    ]);

    expect(slots).toEqual([
      { date: '2026-05-09', period: 'morning' },
      { date: '2026-05-10', period: 'night' }
    ]);
  });

  it('validates reservation slots against a configurable window', () => {
    const start = new Date('2026-05-09T00:00:00.000Z');

    expect(() =>
      validateReservationWindow([{ date: '2026-11-09', period: 'morning' }], {
        start,
        reservationMonthsAhead: 6
      })
    ).not.toThrow();
    expect(() =>
      validateReservationWindow([{ date: '2026-11-10', period: 'morning' }], {
        start,
        reservationMonthsAhead: 6
      })
    ).toThrow('予約可能期間外のコマが含まれています。');
  });

  it('serializes Firestore timestamp-like fields', () => {
    const reservation = serializeReservation(
      doc('reservation-1', {
        groupName: 'テスト団体',
        createdAt: timestamp('2026-05-09T10:30:00.000Z'),
        updatedAt: null,
        approvedAt: undefined,
        cancelledAt: timestamp('2026-05-10T10:30:00.000Z')
      })
    );

    expect(reservation).toMatchObject({
      id: 'reservation-1',
      groupName: 'テスト団体',
      createdAt: '2026-05-09T10:30:00.000Z',
      updatedAt: null,
      approvedAt: null,
      cancelledAt: '2026-05-10T10:30:00.000Z'
    });

    expect(
      serializeAllowedUser(
        doc('admin@example.com', {
          email: 'admin@example.com',
          createdAt: timestamp('2026-05-09T10:30:00.000Z')
        })
      )
    ).toMatchObject({
      id: 'admin@example.com',
      email: 'admin@example.com',
      createdAt: '2026-05-09T10:30:00.000Z',
      updatedAt: null
    });
  });

  it('normalizes imported reservation timestamps and slots', () => {
    const now = new Date('2026-05-09T00:00:00.000Z');
    const imported = reservationDataForImport(
      {
        slots: [
          { date: '2026-05-10', period: 'night' },
          { date: '2026-05-09', period: 'morning' }
        ],
        createdAt: 'invalid',
        updatedAt: '2026-05-10T00:00:00.000Z',
        approvedAt: null,
        cancelledAt: '2026-05-11T00:00:00.000Z'
      },
      now
    );

    expect(imported.slots).toEqual([
      { date: '2026-05-09', period: 'morning' },
      { date: '2026-05-10', period: 'night' }
    ]);
    expect(imported.createdAt).toBe(now);
    expect(imported.updatedAt).toEqual(new Date('2026-05-10T00:00:00.000Z'));
    expect(imported.approvedAt).toBe(null);
    expect(imported.cancelledAt).toEqual(new Date('2026-05-11T00:00:00.000Z'));
    expect(importedTimestamp('not a date', now)).toBe(now);
  });
});
