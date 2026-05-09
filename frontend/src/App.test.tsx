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

function installFetchMock() {
  const posts: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/config') {
      return jsonResponse({ resourceName: '会議室', reservationMonthsAhead: 6, maxSlotsPerRequest: 3 });
    }
    if (url === '/api/me') {
      return jsonResponse({
        user: { uid: 'user-1', email: 'user@example.com', name: '利用者', role: 'user', isAdmin: false }
      });
    }
    if (url.startsWith('/api/availability')) {
      return jsonResponse({
        slots: [
          {
            id: '2026-05-10_morning',
            date: '2026-05-10',
            period: 'morning',
            reservationId: 'reservation-1',
            status: 'approved',
            groupName: '既存予約'
          }
        ]
      });
    }
    if (url.startsWith('/api/reservations') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return jsonResponse({ reservation: { id: 'reservation-2' } }, { status: 201 });
    }
    if (url.startsWith('/api/reservations')) {
      return jsonResponse({ reservations: [] });
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, posts };
}

function loginAsUser() {
  firebaseMocks.auth.currentUser = {
    email: 'user@example.com',
    getIdToken: vi.fn(async () => 'test-token')
  };
}

describe('App', () => {
  beforeEach(() => {
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
});
