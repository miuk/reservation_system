import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  LogIn,
  LogOut,
  Printer,
  ShieldCheck,
  Trash2,
  UserPlus,
  X
} from 'lucide-react';
import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  User,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from 'firebase/auth';
import './styles.css';

type Period = 'morning' | 'afternoon' | 'night';
type Slot = { date: string; period: Period };
type ReservationStatus = 'pending' | 'approved' | 'cancelled';
type OccupiedSlot = Slot & {
  id: string;
  reservationId: string;
  status: ReservationStatus;
  groupName?: string;
};
type ApiUser = { uid: string; email: string; name: string; role: 'user' | 'admin'; isAdmin: boolean };
type Reservation = {
  id: string;
  slots: Slot[];
  status: ReservationStatus;
  groupName: string;
  representative: { name: string; phone: string; email: string };
  secondaryRepresentative?: { name?: string; phone?: string; email?: string };
  expectedAttendees: number;
  purpose: string;
  notes?: string;
  createdAt: string | null;
};
type AllowedUser = {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  active: boolean;
};
type AdminTab = 'reservations' | 'users' | 'print';

const PERIODS: Array<{ id: Period; label: string }> = [
  { id: 'morning', label: '午前' },
  { id: 'afternoon', label: '午後' },
  { id: 'night', label: '夜' }
];
const MIN_MONTH_OFFSET = -6;
const MAX_MONTH_OFFSET = 6;

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};
const missingFirebaseConfig = Object.entries(firebaseConfig)
  .filter(([, value]) => !value)
  .map(([key]) => key);

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

function authErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return 'Googleログインに失敗しました。';
  const message = error.message;
  if (message.includes('auth/unauthorized-domain')) {
    return `Firebase Authentication の承認済みドメインに ${window.location.hostname} が登録されていません。Firebase Console で Authentication > Settings > Authorized domains に ${window.location.hostname} を追加してください。`;
  }
  if (message.includes('auth/operation-not-allowed')) {
    return 'Firebase Authentication で Google ログインが有効になっていません。Sign-in method で Google を有効化してください。';
  }
  if (message.includes('auth/configuration-not-found')) {
    return 'Firebase Authentication の設定が見つかりません。Firebase Console でこのプロジェクトの Authentication を開始し、Sign-in method で Google を有効化してください。API key、authDomain、projectId が同じ Firebase プロジェクトの値かも確認してください。';
  }
  if (message.includes('auth/invalid-api-key') || missingFirebaseConfig.length > 0) {
    return `Firebase のフロントエンド設定が不足しています: ${missingFirebaseConfig.join(', ')}`;
  }
  if (message.includes('auth/popup-closed-by-user')) {
    return 'Googleログインのポップアップが閉じられました。';
  }
  return message;
}

function isoDate(date: Date) {
  const copy = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  return copy.toISOString().slice(0, 10);
}

function addMonths(date: Date, months: number) {
  const copy = new Date(date.getFullYear(), date.getMonth(), 1);
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

function slotKey(slot: Slot) {
  return `${slot.date}_${slot.period}`;
}

function monthDays(month: Date) {
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

function printRangeDays(month: Date) {
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

function statusLabel(status: ReservationStatus) {
  return { pending: '仮予約', approved: '予約確定', cancelled: '取消済み' }[status];
}

function slotLabel(slot: Slot) {
  return `${slot.date} ${PERIODS.find((period) => period.id === slot.period)?.label || slot.period}`;
}

function App() {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [apiUser, setApiUser] = useState<ApiUser | null>(null);
  const [occupiedSlots, setOccupiedSlots] = useState<OccupiedSlot[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [allowedUsers, setAllowedUsers] = useState<AllowedUser[]>([]);
  const [selectedSlots, setSelectedSlots] = useState<Slot[]>([]);
  const [monthOffset, setMonthOffset] = useState(0);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [adminTab, setAdminTab] = useState<AdminTab>('reservations');
  const [path, setPath] = useState(window.location.pathname);
  const [userForm, setUserForm] = useState({ email: '', name: '', role: 'user' as 'user' | 'admin' });
  const [form, setForm] = useState({
    groupName: '',
    representativeName: '',
    representativePhone: '',
    representativeEmail: '',
    secondaryName: '',
    secondaryPhone: '',
    secondaryEmail: '',
    expectedAttendees: '',
    purpose: '',
    notes: ''
  });

  const currentMonth = useMemo(() => addMonths(new Date(), monthOffset), [monthOffset]);
  const minDate = isoDate(new Date());
  const maxDate = isoDate(addMonths(new Date(), 6));
  const occupiedByKey = useMemo(
    () => new Map(occupiedSlots.map((slot) => [slotKey(slot), slot])),
    [occupiedSlots]
  );
  const selectedByKey = useMemo(
    () => new Set(selectedSlots.map((slot) => slotKey(slot))),
    [selectedSlots]
  );
  const isAdminPath = path.startsWith('/admin');

  async function token() {
    if (!auth.currentUser) throw new Error('ログインが必要です。');
    return auth.currentUser.getIdToken();
  }

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const idToken = await token();
    const response = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
        ...(init?.headers || {})
      }
    });
    const text = await response.text();
    let body: { error?: string } = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: text || `${response.status} ${response.statusText}` };
    }
    if (!response.ok) throw new Error(body.error || 'APIエラーが発生しました。');
    return body as T;
  }

  async function refresh() {
    if (!auth.currentUser) return;
    const start = isoDate(new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1));
    const end = isoDate(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0));
    const me = await api<{ user: ApiUser }>('/api/me');
    const reservationScope = path.startsWith('/admin') && me.user.isAdmin ? 'all' : 'mine';
    const [availability, reservationList] = await Promise.all([
      api<{ slots: OccupiedSlot[] }>(`/api/availability?start=${start}&end=${end}`),
      api<{ reservations: Reservation[] }>(`/api/reservations?scope=${reservationScope}`)
    ]);
    setApiUser(me.user);
    setOccupiedSlots(availability.slots);
    setReservations(reservationList.reservations);
    if (me.user.isAdmin) {
      const userList = await api<{ users: AllowedUser[] }>('/api/admin/users');
      setAllowedUsers(userList.users);
    }
  }

  useEffect(() => {
    return onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      if (!user) {
        setApiUser(null);
        setOccupiedSlots([]);
        setReservations([]);
        setAllowedUsers([]);
        setSelectedSlots([]);
      }
    });
  }, []);

  useEffect(() => {
    if (!firebaseUser) return;
    refresh().catch((error) => setMessage(error.message));
  }, [firebaseUser, monthOffset, path]);

  useEffect(() => {
    if (firebaseUser?.email && !form.representativeEmail) {
      setForm((current) => ({ ...current, representativeEmail: firebaseUser.email || '' }));
    }
  }, [firebaseUser]);

  async function login() {
    setMessage('');
    if (missingFirebaseConfig.length > 0) {
      setMessage(`Firebase のフロントエンド設定が不足しています: ${missingFirebaseConfig.join(', ')}`);
      return;
    }
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (error) {
      setMessage(authErrorMessage(error));
    }
  }

  async function logout() {
    await signOut(auth);
  }

  function go(path: string) {
    window.history.pushState({}, '', path);
    setPath(path);
  }

  useEffect(() => {
    const updatePath = () => setPath(window.location.pathname);
    window.addEventListener('popstate', updatePath);
    return () => window.removeEventListener('popstate', updatePath);
  }, []);

  function toggleSlot(slot: Slot) {
    const key = slotKey(slot);
    if (occupiedByKey.has(key)) return;
    if (selectedByKey.has(key)) {
      setSelectedSlots((slots) => slots.filter((item) => slotKey(item) !== key));
      return;
    }
    if (selectedSlots.length >= 50) {
      setMessage('一度に選択できるのは50コマまでです。');
      return;
    }
    setSelectedSlots((slots) => [...slots, slot].sort((a, b) => slotKey(a).localeCompare(slotKey(b))));
  }

  async function submitReservation(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      await api('/api/reservations', {
        method: 'POST',
        body: JSON.stringify({
          slots: selectedSlots,
          groupName: form.groupName,
          representative: {
            name: form.representativeName,
            phone: form.representativePhone,
            email: form.representativeEmail
          },
          secondaryRepresentative: {
            name: form.secondaryName,
            phone: form.secondaryPhone,
            email: form.secondaryEmail
          },
          expectedAttendees: Number(form.expectedAttendees),
          purpose: form.purpose,
          notes: form.notes
        })
      });
      setSelectedSlots([]);
      setForm({
        groupName: '',
        representativeName: '',
        representativePhone: '',
        representativeEmail: firebaseUser?.email || '',
        secondaryName: '',
        secondaryPhone: '',
        secondaryEmail: '',
        expectedAttendees: '',
        purpose: '',
        notes: ''
      });
      setMessage('仮予約として申込を受け付けました。');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '申込に失敗しました。');
    } finally {
      setLoading(false);
    }
  }

  async function adminAction(id: string, action: 'approve' | 'cancel') {
    setLoading(true);
    setMessage('');
    try {
      await api(`/api/reservations/${id}/${action}`, { method: 'PATCH' });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '更新に失敗しました。');
    } finally {
      setLoading(false);
    }
  }

  async function addUser(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ ...userForm, active: true })
      });
      setUserForm({ email: '', name: '', role: 'user' });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '利用者の登録に失敗しました。');
    } finally {
      setLoading(false);
    }
  }

  async function updateUser(user: AllowedUser, patch: Partial<AllowedUser>) {
    setLoading(true);
    setMessage('');
    try {
      await api(`/api/admin/users/${encodeURIComponent(user.email)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch)
      });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '利用者の更新に失敗しました。');
    } finally {
      setLoading(false);
    }
  }

  async function deactivateUser(user: AllowedUser) {
    setLoading(true);
    setMessage('');
    try {
      await api(`/api/admin/users/${encodeURIComponent(user.email)}`, { method: 'DELETE' });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '利用者の無効化に失敗しました。');
    } finally {
      setLoading(false);
    }
  }

  function Calendar({ selectable, printMode = false }: { selectable: boolean; printMode?: boolean }) {
    const days = printMode ? printRangeDays(currentMonth) : monthDays(currentMonth);
    return (
      <div className={printMode ? 'print-calendar' : 'calendar-area'}>
        <div className="calendar-header no-print">
          <button
            className="secondary-button"
            disabled={monthOffset <= MIN_MONTH_OFFSET}
            onClick={() => setMonthOffset((v) => v - 1)}
          >
            <ChevronLeft size={18} />
            前月
          </button>
          <h2>{currentMonth.getFullYear()}年 {currentMonth.getMonth() + 1}月</h2>
          <button
            className="secondary-button"
            disabled={monthOffset >= MAX_MONTH_OFFSET}
            onClick={() => setMonthOffset((v) => v + 1)}
          >
            次月
            <ChevronRight size={18} />
          </button>
        </div>
        {printMode && <h2 className="print-title">{currentMonth.getFullYear()}年 {currentMonth.getMonth() + 1}月 会議室予約</h2>}
        <div className="weekday-row">
          {['日', '月', '火', '水', '木', '金', '土'].map((day) => (
            <span key={day}>{day}</span>
          ))}
        </div>
        <div className="calendar-grid">
          {days.map((date, index) => {
            if (!date) return <div className="day-cell empty" key={`empty-${index}`} />;
            const dateString = isoDate(date);
            const outOfRange = dateString < minDate || dateString > maxDate;
            return (
              <div className="day-cell" key={dateString}>
                <div className="day-number">{date.getDate()}</div>
                <div className="period-list">
                  {PERIODS.map((period) => {
                    const slot = { date: dateString, period: period.id };
                    const key = slotKey(slot);
                    const occupied = occupiedByKey.get(key);
                    const selected = selectedByKey.has(key);
                    return (
                      <button
                        key={key}
                        className={`slot-button ${selected ? 'selected' : ''} ${occupied ? occupied.status : ''}`}
                        disabled={!selectable || outOfRange || Boolean(occupied)}
                        onClick={() => toggleSlot(slot)}
                      >
                        {printMode ? (
                          <span>{occupied?.groupName || '-'}</span>
                        ) : occupied ? (
                          <>
                            <strong>{occupied.groupName || '予約あり'}</strong>
                            <small>{statusLabel(occupied.status)}</small>
                          </>
                        ) : (
                          <span>{period.label}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function ReservationList({ admin }: { admin: boolean }) {
    return (
      <div className="reservation-list">
        {reservations.map((reservation) => (
          <article className="reservation-card" key={reservation.id}>
            <div>
              <strong>{reservation.groupName}</strong>
              <span className={`status ${reservation.status}`}>{statusLabel(reservation.status)}</span>
            </div>
            <p>{reservation.slots.map(slotLabel).join('、')}</p>
            <p>{reservation.representative.name} / {reservation.representative.phone} / {reservation.representative.email} / {reservation.expectedAttendees}名</p>
            {reservation.secondaryRepresentative?.email && (
              <p>{reservation.secondaryRepresentative.name || '代表者2'} / {reservation.secondaryRepresentative.phone || '-'} / {reservation.secondaryRepresentative.email}</p>
            )}
            <p>{reservation.purpose}</p>
            {admin && reservation.status !== 'cancelled' && (
              <div className="admin-actions">
                <div>
                  {reservation.status === 'pending' && (
                    <button className="secondary-button" disabled={loading} onClick={() => adminAction(reservation.id, 'approve')}>
                      <ShieldCheck size={16} />
                      承認
                    </button>
                  )}
                </div>
                <div className="admin-cancel-cell">
                  <button className="danger-button" disabled={loading} onClick={() => adminAction(reservation.id, 'cancel')}>
                    <Trash2 size={16} />
                    取消
                  </button>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
    );
  }

  if (!firebaseUser) {
    return (
      <main className="login-screen">
        <section className="login-panel">
          <CalendarDays size={44} aria-hidden />
          <h1>会議室予約</h1>
          {message && <div className="notice">{message}</div>}
          <button className="primary-button" onClick={login}>
            <LogIn size={18} />
            Googleでログイン
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar no-print">
        <div>
          <h1>{isAdminPath ? '管理者画面' : '会議室予約'}</h1>
          <p>{firebaseUser.email}</p>
        </div>
        <nav className="top-actions">
          <button className="ghost-button" onClick={() => go('/reservations')}>予約画面</button>
          {apiUser?.isAdmin && <button className="ghost-button" onClick={() => go('/admin')}>管理者画面</button>}
          <button className="ghost-button" onClick={logout}>
            <LogOut size={18} />
            ログアウト
          </button>
        </nav>
      </header>

      {message && <div className="notice no-print">{message}</div>}

      {!apiUser && message ? (
        <section className="reservations-section">
          <h2>利用できません</h2>
        </section>
      ) : isAdminPath ? (
        <section className="admin-shell">
          {!apiUser?.isAdmin ? (
            <section className="reservations-section">
              <h2>管理者権限が必要です</h2>
            </section>
          ) : (
            <>
              <div className="tabs no-print">
                <button className={adminTab === 'reservations' ? 'active' : ''} onClick={() => setAdminTab('reservations')}>予約管理</button>
                <button className={adminTab === 'users' ? 'active' : ''} onClick={() => setAdminTab('users')}>利用者管理</button>
                <button className={adminTab === 'print' ? 'active' : ''} onClick={() => setAdminTab('print')}>印刷</button>
              </div>

              {adminTab === 'reservations' && (
                <section className="reservations-section">
                  <h2>予約管理</h2>
                  <ReservationList admin />
                </section>
              )}

              {adminTab === 'users' && (
                <section className="reservations-section">
                  <h2>利用者管理</h2>
                  <form className="user-form" onSubmit={addUser}>
                    <input required type="email" placeholder="email" value={userForm.email} onChange={(e) => setUserForm({ ...userForm, email: e.target.value })} />
                    <input required placeholder="名前" value={userForm.name} onChange={(e) => setUserForm({ ...userForm, name: e.target.value })} />
                    <select value={userForm.role} onChange={(e) => setUserForm({ ...userForm, role: e.target.value as 'user' | 'admin' })}>
                      <option value="user">利用者</option>
                      <option value="admin">管理者</option>
                    </select>
                    <button className="primary-button" disabled={loading}>
                      <UserPlus size={18} />
                      追加
                    </button>
                  </form>
                  <div className="user-list">
                    {allowedUsers.map((user) => (
                      <article className="user-row" key={user.email}>
                        <div>
                          <strong>{user.name}</strong>
                          <span>{user.email}</span>
                        </div>
                        <select value={user.role} disabled={loading} onChange={(e) => updateUser(user, { role: e.target.value as 'user' | 'admin' })}>
                          <option value="user">利用者</option>
                          <option value="admin">管理者</option>
                        </select>
                        <label className="toggle-label">
                          <input type="checkbox" checked={user.active} disabled={loading} onChange={(e) => updateUser(user, { active: e.target.checked })} />
                          有効
                        </label>
                        <button className="danger-button" disabled={loading || !user.active} onClick={() => deactivateUser(user)}>
                          <Trash2 size={16} />
                          無効化
                        </button>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {adminTab === 'print' && (
                <section className="reservations-section print-section">
                  <div className="print-actions no-print">
                    <h2>カレンダー印刷</h2>
                    <button className="primary-button compact" onClick={() => window.print()}>
                      <Printer size={18} />
                      印刷
                    </button>
                  </div>
                  <Calendar selectable={false} printMode />
                </section>
              )}
            </>
          )}
        </section>
      ) : (
        <>
          <section className="workspace">
            <Calendar selectable />
            <aside className="side-panel">
              <h2>申込内容</h2>
              <div className="selection-summary">
                <strong>{selectedSlots.length}</strong>
                <span>/ 50 コマ選択中</span>
              </div>
              <div className="selected-slots">
                {selectedSlots.map((slot) => (
                  <button className="selected-slot-row" key={slotKey(slot)} onClick={() => toggleSlot(slot)}>
                    <span>{slotLabel(slot)}</span>
                    <X size={14} />
                  </button>
                ))}
              </div>
              <form className="reservation-form" onSubmit={submitReservation}>
                <input required placeholder="団体名" value={form.groupName} onChange={(e) => setForm({ ...form, groupName: e.target.value })} />
                <input required placeholder="代表者名" value={form.representativeName} onChange={(e) => setForm({ ...form, representativeName: e.target.value })} />
                <input required placeholder="代表者 電話番号" value={form.representativePhone} onChange={(e) => setForm({ ...form, representativePhone: e.target.value })} />
                <input required type="email" placeholder="代表者 email" value={form.representativeEmail} onChange={(e) => setForm({ ...form, representativeEmail: e.target.value })} />
                <input placeholder="代表者名2" value={form.secondaryName} onChange={(e) => setForm({ ...form, secondaryName: e.target.value })} />
                <input placeholder="代表者2 電話番号" value={form.secondaryPhone} onChange={(e) => setForm({ ...form, secondaryPhone: e.target.value })} />
                <input type="email" placeholder="代表者2 email" value={form.secondaryEmail} onChange={(e) => setForm({ ...form, secondaryEmail: e.target.value })} />
                <input required type="number" min="1" placeholder="利用予定人数" value={form.expectedAttendees} onChange={(e) => setForm({ ...form, expectedAttendees: e.target.value })} />
                <textarea required placeholder="利用目的" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} />
                <textarea placeholder="その他連絡事項" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                <button className="primary-button" disabled={loading || selectedSlots.length === 0}>
                  <Check size={18} />
                  仮予約を申し込む
                </button>
              </form>
            </aside>
          </section>

          <section className="reservations-section">
            <h2>自分の申込</h2>
            <ReservationList admin={false} />
          </section>
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
