import cors from 'cors';
import express from 'express';
import { FieldValue, Firestore } from '@google-cloud/firestore';
import helmet from 'helmet';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

export const PERIODS = ['morning', 'afternoon', 'night'];
export const PERIOD_LABELS = {
  morning: '午前',
  afternoon: '午後',
  night: '夜'
};

export function positiveIntegerEnv(name, defaultValue, source = process.env) {
  const value = source[name];
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function createEnv(source = process.env) {
  const resolved = {
    port: Number(source.PORT || 8080),
    frontendOrigin: source.FRONTEND_ORIGIN || 'http://localhost:5173',
    projectId: source.FIREBASE_PROJECT_ID || source.GOOGLE_CLOUD_PROJECT || source.GCLOUD_PROJECT || '',
    firestoreProjectId: source.FIRESTORE_PROJECT_ID || source.FIREBASE_PROJECT_ID || source.GOOGLE_CLOUD_PROJECT || source.GCLOUD_PROJECT || '',
    databaseId: source.FIRESTORE_DATABASE_ID || '(default)',
    resourceName: source.RESOURCE_NAME || '会議室',
    reservationMonthsAhead: positiveIntegerEnv('RESERVATION_MONTHS_AHEAD', 6, source),
    maxSlotsPerRequest: positiveIntegerEnv('MAX_SLOTS_PER_REQUEST', 50, source),
    adminEmails: new Set(
      (source.ADMIN_EMAILS || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
    )
  };

  if (!resolved.projectId) {
    throw new Error('FIREBASE_PROJECT_ID or GOOGLE_CLOUD_PROJECT is required.');
  }

  return resolved;
}

export function createFirestore(env) {
  return new Firestore(
    env.databaseId === '(default)'
      ? { projectId: env.firestoreProjectId }
      : { projectId: env.firestoreProjectId, databaseId: env.databaseId }
  );
}

export function createFirebaseTokenVerifier(env) {
  const firebaseJwks = createRemoteJWKSet(
    new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
  );
  return async (token) => {
    const verified = await jwtVerify(token, firebaseJwks, {
      issuer: `https://securetoken.google.com/${env.projectId}`,
      audience: env.projectId
    });
    return verified.payload;
  };
}

let env;
let db;
let verifyFirebaseToken;

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});

const slotSchema = z.object({
  date: dateStringSchema,
  period: z.enum(PERIODS)
});

function reservationSchema() {
  return z.object({
    slots: z.array(slotSchema).min(1).max(env.maxSlotsPerRequest),
    groupName: z.string().trim().min(1).max(120),
    representative: z.object({
      name: z.string().trim().min(1).max(120),
      phone: z.string().trim().min(1).max(40),
      email: z.string().trim().email().max(160)
    }),
    secondaryRepresentative: z
      .object({
        name: z.string().trim().max(120).optional().default(''),
        phone: z.string().trim().max(40).optional().default(''),
        email: z.union([z.string().trim().email(), z.literal('')]).optional().default('')
      })
      .optional()
      .default({}),
    expectedAttendees: z.coerce.number().int().positive().max(100000),
    purpose: z.string().trim().min(1).max(1000),
    notes: z.string().trim().max(2000).optional().default('')
  });
}

const userSchema = z.object({
  email: z.string().trim().email().max(160),
  name: z.string().trim().min(1).max(120),
  role: z.enum(['user', 'admin']).default('user'),
  active: z.boolean().default(true)
});

const userPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(['user', 'admin']).optional(),
  active: z.boolean().optional()
});

const reservationImportSchema = z
  .object({
    id: z.string().trim().min(1).max(200).optional(),
    slots: z.array(slotSchema).min(1),
    status: z.enum(['pending', 'approved', 'cancelled']).default('pending'),
    groupName: z.string().trim().min(1).max(120),
    representative: z.object({
      name: z.string().trim().min(1).max(120),
      phone: z.string().trim().min(1).max(40),
      email: z.string().trim().email().max(160)
    }),
    secondaryRepresentative: z
      .object({
        name: z.string().trim().max(120).optional().default(''),
        phone: z.string().trim().max(40).optional().default(''),
        email: z.union([z.string().trim().email(), z.literal('')]).optional().default('')
      })
      .optional()
      .default({}),
    expectedAttendees: z.coerce.number().int().positive().max(100000),
    purpose: z.string().trim().min(1).max(1000),
    notes: z.string().trim().max(2000).optional().default(''),
    createdBy: z.unknown().optional(),
    approvedBy: z.unknown().optional(),
    cancelledBy: z.unknown().optional(),
    createdAt: z.string().datetime().nullable().optional(),
    updatedAt: z.string().datetime().nullable().optional(),
    approvedAt: z.string().datetime().nullable().optional(),
    cancelledAt: z.string().datetime().nullable().optional()
  })
  .passthrough();

const reservationImportBodySchema = z.object({
  mode: z.enum(['merge', 'replace']).default('merge'),
  reservations: z.array(reservationImportSchema)
});

const reservationDeleteSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('all'),
    confirm: z.literal('DELETE_ALL_RESERVATIONS')
  }),
  z.object({
    mode: z.literal('before'),
    cutoffDate: dateStringSchema,
    confirm: z.literal('DELETE_RESERVATIONS_BEFORE_DATE')
  })
]);

export function addMonths(date, months) {
  const result = new Date(date.getTime());
  result.setMonth(result.getMonth() + months);
  return result;
}

export function dateOnly(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

export function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function slotId(slot) {
  return `${slot.date}_${slot.period}`;
}

export function userId(email) {
  return email.trim().toLowerCase();
}

export function normalizeSlots(slots) {
  const unique = new Map();
  for (const slot of slots) {
    unique.set(slotId(slot), slot);
  }
  return [...unique.values()].sort((a, b) => slotId(a).localeCompare(slotId(b)));
}

export function validateReservationWindow(slots, options = {}) {
  const start = options.start || todayUtc();
  const end = addMonths(start, options.reservationMonthsAhead ?? env.reservationMonthsAhead);
  for (const slot of slots) {
    const target = dateOnly(slot.date);
    if (Number.isNaN(target.getTime()) || target < start || target > end) {
      throw Object.assign(new Error('予約可能期間外のコマが含まれています。'), { status: 400 });
    }
  }
}

async function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    res.status(401).json({ error: 'ログインが必要です。' });
    return;
  }

  let payload;
  try {
    payload = await verifyFirebaseToken(match[1]);
  } catch (error) {
    console.warn('Firebase ID token verification failed:', {
      expectedIssuer: `https://securetoken.google.com/${env.projectId}`,
      expectedAudience: env.projectId,
      error: error instanceof Error ? error.message : error
    });
    res.status(401).json({ error: '認証トークンが無効です。' });
    return;
  }

  try {
    const email = String(payload.email || '').toLowerCase();
    const adminByEnv = env.adminEmails.has(email);
    const userDoc = email ? await db.collection('allowedUsers').doc(userId(email)).get() : null;
    const allowedUser = userDoc?.exists ? userDoc.data() : null;

    if (!email || (!adminByEnv && allowedUser?.active !== true)) {
      res.status(403).json({ error: '登録済みの利用者のみログインできます。' });
      return;
    }

    req.user = {
      uid: String(payload.user_id || payload.sub || ''),
      email,
      name: String(payload.name || ''),
      role: allowedUser?.role || (adminByEnv ? 'admin' : 'user'),
      isAdmin: adminByEnv || allowedUser?.role === 'admin',
      allowedUserId: email
    };
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: '管理者権限が必要です。' });
    return;
  }
  next();
}

export function serializeReservation(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    ...data,
    createdAt: data.createdAt?.toDate?.().toISOString() || null,
    updatedAt: data.updatedAt?.toDate?.().toISOString() || null,
    approvedAt: data.approvedAt?.toDate?.().toISOString() || null,
    cancelledAt: data.cancelledAt?.toDate?.().toISOString() || null
  };
}

export function serializeAllowedUser(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    ...data,
    createdAt: data.createdAt?.toDate?.().toISOString() || null,
    updatedAt: data.updatedAt?.toDate?.().toISOString() || null
  };
}

export function importedTimestamp(value, fallback = null) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export function reservationDataForImport(reservation, now) {
  const slots = normalizeSlots(reservation.slots);
  return {
    ...reservation,
    slots,
    updatedAt: importedTimestamp(reservation.updatedAt, now),
    createdAt: importedTimestamp(reservation.createdAt, now),
    approvedAt: importedTimestamp(reservation.approvedAt, null),
    cancelledAt: importedTimestamp(reservation.cancelledAt, null)
  };
}

async function deleteCollection(collectionName) {
  const snapshot = await db.collection(collectionName).get();
  let batch = db.batch();
  let count = 0;
  for (const doc of snapshot.docs) {
    batch.delete(doc.ref);
    count += 1;
    if (count >= 450) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }
  if (count > 0) {
    await batch.commit();
  }
}

async function writeImportedReservations(reservations) {
  let batch = db.batch();
  let count = 0;
  const commitIfNeeded = async () => {
    if (count >= 450) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  };

  for (const reservation of reservations) {
    const reservationRef = reservation.id
      ? db.collection('reservations').doc(reservation.id)
      : db.collection('reservations').doc();
    const { id: _id, ...data } = reservation;
    batch.set(reservationRef, data, { merge: false });
    count += 1;
    await commitIfNeeded();

    if (reservation.status !== 'cancelled') {
      for (const slot of reservation.slots) {
        batch.set(
          db.collection('reservationSlots').doc(slotId(slot)),
          {
            date: slot.date,
            period: slot.period,
            periodLabel: PERIOD_LABELS[slot.period],
            groupName: reservation.groupName,
            reservationId: reservationRef.id,
            status: reservation.status,
            createdBy: reservation.createdBy || null,
            createdAt: reservation.createdAt || null,
            updatedAt: reservation.updatedAt || null
          },
          { merge: false }
        );
        count += 1;
        await commitIfNeeded();
      }
    }
  }

  if (count > 0) {
    await batch.commit();
  }
}

async function deleteReservationDocs(docs) {
  let batch = db.batch();
  let count = 0;
  let deleted = 0;
  const commitIfNeeded = async () => {
    if (count >= 450) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  };

  for (const doc of docs) {
    const reservation = doc.data();
    for (const slot of reservation.slots || []) {
      batch.delete(db.collection('reservationSlots').doc(slotId(slot)));
      count += 1;
      await commitIfNeeded();
    }
    batch.delete(doc.ref);
    count += 1;
    deleted += 1;
    await commitIfNeeded();
  }

  if (count > 0) {
    await batch.commit();
  }
  return deleted;
}

export function createApp(options = {}) {
  env = options.env || createEnv();
  db = options.db || createFirestore(env);
  verifyFirebaseToken = options.verifyFirebaseToken || createFirebaseTokenVerifier(env);

  const app = express();
  app.use(helmet());
  app.use(cors({ origin: env.frontendOrigin, credentials: true }));
  app.use(express.json({ limit: '5mb' }));

  app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', (_req, res) => {
  res.json({
    resourceName: env.resourceName,
    reservationMonthsAhead: env.reservationMonthsAhead,
    maxSlotsPerRequest: env.maxSlotsPerRequest
  });
});

app.get('/api/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/availability', authenticate, async (req, res, next) => {
  try {
    const start = typeof req.query.start === 'string' ? req.query.start : null;
    const end = typeof req.query.end === 'string' ? req.query.end : null;
    if (!start || !end) {
      res.status(400).json({ error: 'start と end が必要です。' });
      return;
    }

    const snapshot = await db
      .collection('reservationSlots')
      .where('date', '>=', start)
      .where('date', '<=', end)
      .get();
    const slots = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const missingGroupNameIds = [
      ...new Set(slots.filter((slot) => !slot.groupName && slot.reservationId).map((slot) => slot.reservationId))
    ];
    const reservationNames = new Map();
    await Promise.all(
      missingGroupNameIds.map(async (reservationId) => {
        const reservation = await db.collection('reservations').doc(reservationId).get();
        if (reservation.exists) {
          reservationNames.set(reservationId, reservation.data().groupName || '');
        }
      })
    );

    res.json({
      slots: slots.map((slot) => ({
        ...slot,
        groupName: slot.groupName || reservationNames.get(slot.reservationId) || ''
      })),
      periods: PERIODS.map((id) => ({ id, label: PERIOD_LABELS[id] }))
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/reservations', authenticate, async (req, res, next) => {
  try {
    const scope = typeof req.query.scope === 'string' ? req.query.scope : 'mine';
    const query =
      scope === 'all' && req.user.isAdmin
        ? db.collection('reservations').orderBy('createdAt', 'desc').limit(200)
        : db.collection('reservations').where('createdBy.uid', '==', req.user.uid).limit(200);
    const snapshot = await query.get();
    res.json({ reservations: snapshot.docs.map(serializeReservation) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/users', authenticate, requireAdmin, async (_req, res, next) => {
  try {
    const snapshot = await db.collection('allowedUsers').orderBy('email').get();
    res.json({ users: snapshot.docs.map(serializeAllowedUser) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/users', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const parsed = userSchema.parse(req.body);
    const email = userId(parsed.email);
    const ref = db.collection('allowedUsers').doc(email);
    const now = FieldValue.serverTimestamp();
    await ref.set(
      {
        ...parsed,
        email,
        createdBy: req.user,
        updatedBy: req.user,
        createdAt: now,
        updatedAt: now
      },
      { merge: true }
    );
    res.status(201).json({ user: serializeAllowedUser(await ref.get()) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/admin/users/:email', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const parsed = userPatchSchema.parse(req.body);
    const email = userId(req.params.email);
    const ref = db.collection('allowedUsers').doc(email);
    const doc = await ref.get();
    if (!doc.exists) {
      res.status(404).json({ error: '利用者が見つかりません。' });
      return;
    }
    await ref.update({
      ...parsed,
      updatedBy: req.user,
      updatedAt: FieldValue.serverTimestamp()
    });
    res.json({ user: serializeAllowedUser(await ref.get()) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/users/:email', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const email = userId(req.params.email);
    const ref = db.collection('allowedUsers').doc(email);
    const doc = await ref.get();
    if (!doc.exists) {
      res.status(404).json({ error: '利用者が見つかりません。' });
      return;
    }
    await ref.update({
      active: false,
      updatedBy: req.user,
      updatedAt: FieldValue.serverTimestamp()
    });
    res.json({ user: serializeAllowedUser(await ref.get()) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/reservations/export', authenticate, requireAdmin, async (_req, res, next) => {
  try {
    const snapshot = await db.collection('reservations').orderBy('createdAt', 'desc').get();
    res.json({
      version: 1,
      exportedAt: new Date().toISOString(),
      reservations: snapshot.docs.map(serializeReservation)
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/reservations/import', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const parsed = reservationImportBodySchema.parse(Array.isArray(req.body) ? { reservations: req.body } : req.body);
    const now = new Date();

    for (const reservation of parsed.reservations) {
      if (reservation.slots.length !== normalizeSlots(reservation.slots).length) {
        res.status(400).json({ error: 'インポートデータに同一予約内の重複コマがあります。' });
        return;
      }
    }

    const reservations = parsed.reservations.map((reservation) => reservationDataForImport(reservation, now));

    const seenSlots = new Map();
    for (const reservation of reservations) {
      if (reservation.status === 'cancelled') continue;
      for (const slot of reservation.slots) {
        const key = slotId(slot);
        const previous = seenSlots.get(key);
        if (previous && previous !== reservation.id) {
          res.status(400).json({ error: `インポートデータ内でコマが重複しています: ${key}` });
          return;
        }
        seenSlots.set(key, reservation.id || key);
      }
    }

    if (parsed.mode === 'merge') {
      for (const [key, reservationId] of seenSlots.entries()) {
        const existing = await db.collection('reservationSlots').doc(key).get();
        if (existing.exists && existing.data().reservationId !== reservationId) {
          res.status(409).json({ error: `既存予約と競合するコマがあります: ${key}` });
          return;
        }
      }
    } else {
      await deleteCollection('reservationSlots');
      await deleteCollection('reservations');
    }

    await writeImportedReservations(reservations);
    res.json({ imported: reservations.length, mode: parsed.mode });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/reservations/delete', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const parsed = reservationDeleteSchema.parse(req.body);
    if (parsed.mode === 'all') {
      await deleteCollection('reservationSlots');
      await deleteCollection('reservations');
      res.json({ deleted: 'all', mode: parsed.mode });
      return;
    }

    const snapshot = await db.collection('reservations').get();
    const targets = snapshot.docs.filter((doc) => {
      const slots = doc.data().slots || [];
      return slots.length > 0 && slots.every((slot) => slot.date <= parsed.cutoffDate);
    });
    const deleted = await deleteReservationDocs(targets);
    res.json({ deleted, mode: parsed.mode, cutoffDate: parsed.cutoffDate });
  } catch (error) {
    next(error);
  }
});

app.post('/api/reservations', authenticate, async (req, res, next) => {
  try {
    const parsed = reservationSchema().parse(req.body);
    const slots = normalizeSlots(parsed.slots);
    if (slots.length !== parsed.slots.length) {
      res.status(400).json({ error: '重複したコマが含まれています。' });
      return;
    }
    validateReservationWindow(slots);

    const reservationRef = db.collection('reservations').doc();
    const slotRefs = slots.map((slot) => db.collection('reservationSlots').doc(slotId(slot)));
    const now = FieldValue.serverTimestamp();

    await db.runTransaction(async (transaction) => {
      const slotDocs = await Promise.all(slotRefs.map((ref) => transaction.get(ref)));
      const reserved = slotDocs.find((doc) => doc.exists && doc.data().status !== 'cancelled');
      if (reserved) {
        throw Object.assign(new Error('予約済みのコマが含まれています。'), { status: 409 });
      }

      transaction.set(reservationRef, {
        ...parsed,
        slots,
        status: 'pending',
        createdBy: req.user,
        createdAt: now,
        updatedAt: now
      });

      for (const slot of slots) {
        transaction.set(db.collection('reservationSlots').doc(slotId(slot)), {
          date: slot.date,
          period: slot.period,
          periodLabel: PERIOD_LABELS[slot.period],
          groupName: parsed.groupName,
          reservationId: reservationRef.id,
          status: 'pending',
          createdBy: req.user,
          createdAt: now,
          updatedAt: now
        });
      }
    });

    const created = await reservationRef.get();
    res.status(201).json({ reservation: serializeReservation(created) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/reservations/:id/approve', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const ref = db.collection('reservations').doc(req.params.id);
    const now = FieldValue.serverTimestamp();
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(ref);
      if (!doc.exists) {
        throw Object.assign(new Error('予約が見つかりません。'), { status: 404 });
      }
      if (doc.data().status === 'cancelled') {
        throw Object.assign(new Error('取消済みの予約は承認できません。'), { status: 400 });
      }
      transaction.update(ref, {
        status: 'approved',
        approvedBy: req.user,
        approvedAt: now,
        updatedAt: now
      });
      for (const slot of doc.data().slots || []) {
        transaction.update(db.collection('reservationSlots').doc(slotId(slot)), {
          status: 'approved',
          updatedAt: now
        });
      }
    });
    res.json({ reservation: serializeReservation(await ref.get()) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/reservations/:id/cancel', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const ref = db.collection('reservations').doc(req.params.id);
    const now = FieldValue.serverTimestamp();
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(ref);
      if (!doc.exists) {
        throw Object.assign(new Error('予約が見つかりません。'), { status: 404 });
      }
      transaction.update(ref, {
        status: 'cancelled',
        cancelledBy: req.user,
        cancelledAt: now,
        updatedAt: now
      });
      for (const slot of doc.data().slots || []) {
        transaction.delete(db.collection('reservationSlots').doc(slotId(slot)));
      }
    });
    res.json({ reservation: serializeReservation(await ref.get()) });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: '入力内容を確認してください。', details: error.flatten() });
    return;
  }
  const status = error.status || 500;
  res.status(status).json({ error: error.message || 'サーバーエラーが発生しました。' });
});

  return app;
}
