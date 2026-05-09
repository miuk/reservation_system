import { EventEmitter } from 'node:events';
import httpMocks from 'node-mocks-http';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

class MemoryDoc {
  constructor(collection, id) {
    this.collection = collection;
    this.id = id;
    this.ref = collection.doc(id);
  }

  get exists() {
    return this.collection.items.has(this.id);
  }

  data() {
    return this.collection.items.get(this.id);
  }
}

class MemoryDocRef {
  constructor(collection, id) {
    this.collection = collection;
    this.id = id;
  }

  async get() {
    return new MemoryDoc(this.collection, this.id);
  }

  async set(data) {
    this.collection.items.set(this.id, data);
  }

  async update(data) {
    this.collection.items.set(this.id, {
      ...(this.collection.items.get(this.id) || {}),
      ...data
    });
  }

  async delete() {
    this.collection.items.delete(this.id);
  }
}

class MemoryQuery {
  constructor(collection, filters = [], limitCount = null) {
    this.collection = collection;
    this.filters = filters;
    this.limitCount = limitCount;
  }

  where(field, operator, value) {
    return new MemoryQuery(this.collection, [...this.filters, { field, operator, value }], this.limitCount);
  }

  orderBy() {
    return this;
  }

  limit(limitCount) {
    return new MemoryQuery(this.collection, this.filters, limitCount);
  }

  async get() {
    let docs = [...this.collection.items.entries()].map(([id]) => new MemoryDoc(this.collection, id));
    for (const filter of this.filters) {
      docs = docs.filter((doc) => {
        const value = filter.field.split('.').reduce((current, key) => current?.[key], doc.data());
        if (filter.operator === '==') return value === filter.value;
        if (filter.operator === '>=') return value >= filter.value;
        if (filter.operator === '<=') return value <= filter.value;
        return false;
      });
    }
    if (this.limitCount !== null) docs = docs.slice(0, this.limitCount);
    return { docs };
  }
}

class MemoryCollection extends MemoryQuery {
  constructor(name) {
    super(null);
    this.name = name;
    this.items = new Map();
    this.nextId = 1;
    this.collection = this;
  }

  doc(id = `${this.name}-${this.nextId++}`) {
    return new MemoryDocRef(this, id);
  }
}

class MemoryDb {
  constructor() {
    this.collections = new Map();
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new MemoryCollection(name));
    }
    return this.collections.get(name);
  }

  batch() {
    const operations = [];
    return {
      set: (ref, data) => operations.push(() => ref.set(data)),
      update: (ref, data) => operations.push(() => ref.update(data)),
      delete: (ref) => operations.push(() => ref.delete()),
      commit: async () => {
        for (const operation of operations.splice(0)) {
          await operation();
        }
      }
    };
  }

  async runTransaction(callback) {
    const transaction = {
      get: (ref) => ref.get(),
      set: (ref, data) => ref.set(data),
      update: (ref, data) => ref.update(data),
      delete: (ref) => ref.delete()
    };
    await callback(transaction);
  }
}

const env = {
  port: 8080,
  frontendOrigin: 'http://localhost:5173',
  projectId: 'test-project',
  firestoreProjectId: 'test-project',
  databaseId: '(default)',
  resourceName: '会議室',
  reservationMonthsAhead: 6,
  maxSlotsPerRequest: 3,
  adminEmails: new Set(['admin@example.com'])
};

function appWith({ db = new MemoryDb(), payload = userPayload() } = {}) {
  const app = createApp({
    env,
    db,
    verifyFirebaseToken: async () => payload
  });
  return { app, db };
}

function userPayload(overrides = {}) {
  return {
    user_id: 'user-1',
    email: 'user@example.com',
    name: '利用者',
    ...overrides
  };
}

async function allowUser(db, email = 'user@example.com', role = 'user') {
  await db.collection('allowedUsers').doc(email).set({
    email,
    name: email,
    role,
    active: true
  });
}

function request(app, method, url, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpMocks.createRequest({
      method,
      url,
      headers: {
        'content-type': 'application/json',
        ...(headers || {})
      },
      body
    });
    const res = httpMocks.createResponse({
      eventEmitter: EventEmitter
    });
    res.on('end', () => {
      let responseBody = {};
      try {
        responseBody = JSON.parse(res._getData() || '{}');
      } catch {
        responseBody = res._getData();
      }
      resolve({
        status: res.statusCode,
        body: responseBody,
        headers: res._getHeaders()
      });
    });
    app.handle(req, res, reject);
  });
}

describe('app API', () => {
  let db;

  beforeEach(() => {
    db = new MemoryDb();
  });

  it('serves health and public config without auth', async () => {
    const { app } = appWith({ db });

    expect(await request(app, 'GET', '/health')).toMatchObject({ status: 200, body: { ok: true } });
    const config = await request(app, 'GET', '/api/config');
    expect(config.status).toBe(200);
    expect(config.body).toMatchObject({
      resourceName: '会議室',
      reservationMonthsAhead: 6,
      maxSlotsPerRequest: 3
    });
  });

  it('rejects authenticated routes without a bearer token', async () => {
    const { app } = appWith({ db });

    const response = await request(app, 'GET', '/api/me');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('ログインが必要です。');
  });

  it('returns the current allowed user', async () => {
    await allowUser(db);
    const { app } = appWith({ db });

    const response = await request(app, 'GET', '/api/me', {
      headers: { Authorization: 'Bearer test-token' }
    });
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
      uid: 'user-1',
      email: 'user@example.com',
      role: 'user',
      isAdmin: false
    });
  });

  it('blocks non-admin users from admin APIs', async () => {
    await allowUser(db);
    const { app } = appWith({ db });

    const response = await request(app, 'GET', '/api/admin/users', {
      headers: { Authorization: 'Bearer test-token' }
    });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('管理者権限が必要です。');
  });

  it('validates reservation creation input before writing', async () => {
    await allowUser(db);
    const { app } = appWith({ db });

    const invalid = await request(app, 'POST', '/api/reservations', {
      headers: { Authorization: 'Bearer test-token' },
      body: {}
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('入力内容を確認してください。');

    const duplicate = await request(app, 'POST', '/api/reservations', {
      headers: { Authorization: 'Bearer test-token' },
      body: {
        slots: [
          { date: '2026-05-10', period: 'morning' },
          { date: '2026-05-10', period: 'morning' }
        ],
        groupName: 'テスト団体',
        representative: { name: '代表者', phone: '090-0000-0000', email: 'rep@example.com' },
        expectedAttendees: 10,
        purpose: '会議'
      }
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toBe('重複したコマが含まれています。');
  });

  it('creates a pending reservation and occupied slot records', async () => {
    await allowUser(db);
    const { app } = appWith({ db });

    const response = await request(app, 'POST', '/api/reservations', {
      headers: { Authorization: 'Bearer test-token' },
      body: {
        slots: [{ date: '2026-05-10', period: 'morning' }],
        groupName: 'テスト団体',
        representative: { name: '代表者', phone: '090-0000-0000', email: 'rep@example.com' },
        expectedAttendees: 10,
        purpose: '会議'
      }
    });
    expect(response.status).toBe(201);

    expect(response.body.reservation).toMatchObject({
      groupName: 'テスト団体',
      status: 'pending'
    });
    expect(db.collection('reservations').items.size).toBe(1);
    expect(db.collection('reservationSlots').items.get('2026-05-10_morning')).toMatchObject({
      groupName: 'テスト団体',
      status: 'pending'
    });
  });

  it('returns conflict when an active slot is already reserved', async () => {
    await allowUser(db);
    await db.collection('reservationSlots').doc('2026-05-10_morning').set({ status: 'pending' });
    const { app } = appWith({ db });

    const response = await request(app, 'POST', '/api/reservations', {
      headers: { Authorization: 'Bearer test-token' },
      body: {
        slots: [{ date: '2026-05-10', period: 'morning' }],
        groupName: 'テスト団体',
        representative: { name: '代表者', phone: '090-0000-0000', email: 'rep@example.com' },
        expectedAttendees: 10,
        purpose: '会議'
      }
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('予約済みのコマが含まれています。');
  });
});
