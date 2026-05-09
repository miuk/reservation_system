// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './main';

const firebaseMocks = vi.hoisted(() => {
  const auth = {
    currentUser: null as null | {
      email: string;
      getIdToken: () => Promise<string>;
    }
  };
  return {
    auth,
    onAuthStateChanged: vi.fn((_auth, callback: (user: typeof auth.currentUser) => void) => {
      callback(auth.currentUser);
      return vi.fn();
    }),
    signInWithPopup: vi.fn(),
    signOut: vi.fn()
  };
});

vi.mock('firebase/app', () => ({
  initializeApp: vi.fn(() => ({}))
}));

vi.mock('firebase/auth', () => ({
  GoogleAuthProvider: vi.fn(),
  getAuth: vi.fn(() => firebaseMocks.auth),
  onAuthStateChanged: firebaseMocks.onAuthStateChanged,
  signInWithPopup: firebaseMocks.signInWithPopup,
  signOut: firebaseMocks.signOut
}));

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

type FetchMockOptions = {
  admin?: boolean;
  availabilitySlots?: unknown[];
  config?: {
    resourceName: string;
    reservationMonthsAhead: number;
    maxSlotsPerRequest: number;
  };
  reservations?: unknown[];
  users?: unknown[];
};

function installFetchMock(options: FetchMockOptions = {}) {
  const posts: unknown[] = [];
  const adminActions: Array<{ url: string; method: string }> = [];
  const userPosts: unknown[] = [];
  const config = options.config || { resourceName: '会議室', reservationMonthsAhead: 6, maxSlotsPerRequest: 3 };
  const isAdmin = options.admin || false;
  const availabilitySlots = options.availabilitySlots || [
    {
      id: '2026-05-10_morning',
      date: '2026-05-10',
      period: 'morning',
      reservationId: 'reservation-1',
      status: 'approved',
      groupName: '既存予約'
    }
  ];
  const reservations = options.reservations || [];
  const users = options.users || [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/config') {
      return jsonResponse(config);
    }
    if (url === '/api/me') {
      return jsonResponse({
        user: {
          uid: isAdmin ? 'admin-1' : 'user-1',
          email: isAdmin ? 'admin@example.com' : 'user@example.com',
          name: isAdmin ? '管理者' : '利用者',
          role: isAdmin ? 'admin' : 'user',
          isAdmin
        }
      });
    }
    if (url.startsWith('/api/availability')) {
      return jsonResponse({
        slots: availabilitySlots
      });
    }
    if (url === '/api/admin/users') {
      if (init?.method === 'POST') {
        userPosts.push(JSON.parse(String(init.body)));
        return jsonResponse({ user: { id: 'new@example.com' } }, { status: 201 });
      }
      return jsonResponse({ users });
    }
    if (url.startsWith('/api/admin/users/')) {
      adminActions.push({ url, method: init?.method || 'GET' });
      return jsonResponse({ user: { id: 'user-1' } });
    }
    if (url.startsWith('/api/reservations/') && init?.method === 'PATCH') {
      adminActions.push({ url, method: init.method });
      return jsonResponse({ reservation: { id: 'reservation-1' } });
    }
    if (url.startsWith('/api/reservations') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return jsonResponse({ reservation: { id: 'reservation-2' } }, { status: 201 });
    }
    if (url.startsWith('/api/reservations')) {
      return jsonResponse({ reservations });
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { adminActions, fetchMock, posts, userPosts };
}

function loginAsUser() {
  firebaseMocks.auth.currentUser = {
    email: 'user@example.com',
    getIdToken: vi.fn(async () => 'test-token')
  };
}

function loginAsAdmin() {
  firebaseMocks.auth.currentUser = {
    email: 'admin@example.com',
    getIdToken: vi.fn(async () => 'test-token')
  };
}

const pendingReservation = {
  id: 'reservation-1',
  slots: [{ date: '2026-05-10', period: 'morning' }],
  status: 'pending',
  groupName: 'テスト団体',
  representative: { name: '代表者', phone: '090-0000-0000', email: 'rep@example.com' },
  expectedAttendees: 10,
  purpose: '会議',
  createdAt: '2026-05-09T10:30:00.000Z',
  approvedAt: null,
  cancelledAt: null
};

describe('App', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-09T00:00:00+09:00'));
    window.history.replaceState({}, '', '/reservations');
    firebaseMocks.auth.currentUser = null;
    firebaseMocks.onAuthStateChanged.mockClear();
    firebaseMocks.signInWithPopup.mockClear();
    firebaseMocks.signOut.mockClear();
    installFetchMock();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows the login screen when no Firebase user is present', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '会議室予約' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Googleでログイン/ })).toBeInTheDocument();
  });

  it('loads availability and the reservation screen for a signed-in user', async () => {
    loginAsUser();

    render(<App />);

    expect(await screen.findByText('user@example.com')).toBeInTheDocument();
    expect(await screen.findByText('既存予約')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '自分の申込' })).toBeInTheDocument();
  });

  it('selects an available slot and submits a reservation', async () => {
    loginAsUser();
    const { posts } = installFetchMock();
    const user = userEvent.setup();

    render(<App />);

    await screen.findByText('user@example.com');
    const afternoonButtons = await screen.findAllByRole('button', { name: '午後' });
    const selectableAfternoon = afternoonButtons.find((button) => !button.hasAttribute('disabled'));
    expect(selectableAfternoon).toBeDefined();
    await user.click(selectableAfternoon!);

    await user.type(screen.getByPlaceholderText('団体名'), 'テスト団体');
    await user.type(screen.getByPlaceholderText('代表者名'), '代表者');
    await user.type(screen.getByPlaceholderText('代表者 電話番号'), '090-0000-0000');
    await user.clear(screen.getByPlaceholderText('代表者 email'));
    await user.type(screen.getByPlaceholderText('代表者 email'), 'rep@example.com');
    await user.type(screen.getByPlaceholderText('利用予定人数'), '10');
    await user.type(screen.getByPlaceholderText('利用目的'), '会議');
    await user.click(screen.getByRole('button', { name: /仮予約を申し込む/ }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      groupName: 'テスト団体',
      representative: { name: '代表者', phone: '090-0000-0000', email: 'rep@example.com' },
      expectedAttendees: 10,
      purpose: '会議'
    });
    expect((posts[0] as { slots: unknown[] }).slots).toHaveLength(1);
    expect(await screen.findByText('仮予約として申込を受け付けました。')).toBeInTheDocument();
  });

  it('does not allow selecting occupied or out-of-range slots', async () => {
    loginAsUser();
    const user = userEvent.setup();

    render(<App />);

    const occupiedSlot = await screen.findByRole('button', { name: /既存予約/ });
    expect(occupiedSlot).toBeDisabled();
    await user.click(occupiedSlot);
    expect(screen.getByText('/ 3 コマ選択中')).toBeInTheDocument();

    const firstDayAfternoon = (await screen.findAllByRole('button', { name: '午後' }))[0];
    expect(firstDayAfternoon).toBeDisabled();
    await user.click(firstDayAfternoon);
    expect(screen.getByText('/ 3 コマ選択中')).toBeInTheDocument();
  });

  it('shows a message when selecting more than the configured maximum slots', async () => {
    loginAsUser();
    installFetchMock({
      availabilitySlots: [],
      config: { resourceName: '会議室', reservationMonthsAhead: 6, maxSlotsPerRequest: 2 }
    });
    const user = userEvent.setup();

    render(<App />);

    await screen.findByText('user@example.com');
    await screen.findByText('/ 2 コマ選択中');
    const nextSelectableButton = () =>
      screen
        .getAllByRole('button', { name: /午前|午後|夜/ })
        .find((button) => !(button as HTMLButtonElement).disabled && !button.classList.contains('selected'));

    await user.click(nextSelectableButton()!);
    await waitFor(() => expect(document.querySelectorAll('.selected-slot-row')).toHaveLength(1));
    await user.click(nextSelectableButton()!);
    await waitFor(() => expect(document.querySelectorAll('.selected-slot-row')).toHaveLength(2));
    await user.click(nextSelectableButton()!);

    expect(await screen.findByText('一度に選択できるのは2コマまでです。')).toBeInTheDocument();
    expect(screen.getByText('/ 2 コマ選択中')).toBeInTheDocument();
  });

  it('shows the admin screen with reservation actions for an admin user', async () => {
    window.history.replaceState({}, '', '/admin');
    loginAsAdmin();
    const { adminActions } = installFetchMock({
      admin: true,
      reservations: [pendingReservation],
      users: []
    });
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole('heading', { name: '管理者画面' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '予約管理' })).toBeInTheDocument();
    expect(screen.getByText('テスト団体')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /承認/ }));
    await waitFor(() =>
      expect(adminActions).toContainEqual({
        url: '/api/reservations/reservation-1/approve',
        method: 'PATCH'
      })
    );

    await user.click(screen.getByRole('button', { name: /取消/ }));
    await waitFor(() =>
      expect(adminActions).toContainEqual({
        url: '/api/reservations/reservation-1/cancel',
        method: 'PATCH'
      })
    );
  });

  it('adds an allowed user from the admin users tab', async () => {
    window.history.replaceState({}, '', '/admin');
    loginAsAdmin();
    const { userPosts } = installFetchMock({
      admin: true,
      reservations: [],
      users: [{ id: 'existing@example.com', email: 'existing@example.com', name: '既存利用者', role: 'user', active: true }]
    });
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('heading', { name: '管理者画面' });
    await user.click(screen.getByRole('button', { name: '利用者管理' }));
    expect(await screen.findByRole('heading', { name: '利用者管理' })).toBeInTheDocument();
    expect(screen.getByText('既存利用者')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('email'), 'new@example.com');
    await user.type(screen.getByPlaceholderText('名前'), '新規利用者');
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'admin');
    await user.click(screen.getByRole('button', { name: /追加/ }));

    await waitFor(() => expect(userPosts).toHaveLength(1));
    expect(userPosts[0]).toEqual({
      email: 'new@example.com',
      name: '新規利用者',
      role: 'admin',
      active: true
    });
  });

  it('blocks the admin screen for a signed-in non-admin user', async () => {
    window.history.replaceState({}, '', '/admin');
    loginAsUser();

    render(<App />);

    expect(await screen.findByRole('heading', { name: '管理者画面' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '管理者権限が必要です' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '利用者管理' })).not.toBeInTheDocument();
  });
});
