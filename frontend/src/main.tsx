import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CalendarDays, Check, ChevronLeft, ChevronRight, LogIn, LogOut, ShieldCheck, Trash2 } from 'lucide-react';
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
type OccupiedSlot = Slot & { id: string; reservationId: string; status: ReservationStatus };
type ReservationStatus = 'pending' | 'approved' | 'cancelled';
type ApiUser = { uid: string; email: string; name: string; isAdmin: boolean };
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
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';

function authErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return 'Googleログインに失敗しました。';
  const message = error.message;
  if (message.includes('auth/unauthorized-domain')) {
    return 'Firebase Authentication の承認済みドメインに localhost が登録されていません。Firebase Console で Authentication > Settings > Authorized domains に localhost を追加してください。';
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

function statusLabel(status: ReservationStatus) {
  return { pending: '仮予約', approved: '予約確定', cancelled: '取消済み' }[status];
}

function App() {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [apiUser, setApiUser] = useState<ApiUser | null>(null);
  const [occupiedSlots, setOccupiedSlots] = useState<OccupiedSlot[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [selectedSlots, setSelectedSlots] = useState<Slot[]>([]);
  const [monthOffset, setMonthOffset] = useState(0);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
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

  async function token() {
    if (!auth.currentUser) throw new Error('ログインが必要です。');
    return auth.currentUser.getIdToken();
  }

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const idToken = await token();
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
        ...(init?.headers || {})
      }
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'APIエラーが発生しました。');
    return body;
  }

  async function refresh() {
    if (!auth.currentUser) return;
    const start = isoDate(new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1));
    const end = isoDate(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0));
    const [me, availability, reservationList] = await Promise.all([
      api<{ user: ApiUser }>('/api/me'),
      api<{ slots: OccupiedSlot[] }>(`/api/availability?start=${start}&end=${end}`),
      api<{ reservations: Reservation[] }>('/api/reservations')
    ]);
    setApiUser(me.user);
    setOccupiedSlots(availability.slots);
    setReservations(reservationList.reservations);
  }

  useEffect(() => {
    return onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      if (!user) {
        setApiUser(null);
        setOccupiedSlots([]);
        setReservations([]);
        setSelectedSlots([]);
      }
    });
  }, []);

  useEffect(() => {
    if (!firebaseUser) return;
    refresh().catch((error) => setMessage(error.message));
  }, [firebaseUser, monthOffset]);

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

  useEffect(() => {
    if (firebaseUser?.email && !form.representativeEmail) {
      setForm((current) => ({ ...current, representativeEmail: firebaseUser.email || '' }));
    }
  }, [firebaseUser]);

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
      <header className="topbar">
        <div>
          <h1>会議室予約</h1>
          <p>{firebaseUser.email}</p>
        </div>
        <button className="ghost-button" onClick={logout}>
          <LogOut size={18} />
          ログアウト
        </button>
      </header>

      {message && <div className="notice">{message}</div>}

      <section className="workspace">
        <div className="calendar-area">
          <div className="calendar-header">
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

          <div className="weekday-row">
            {['日', '月', '火', '水', '木', '金', '土'].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="calendar-grid">
            {monthDays(currentMonth).map((date, index) => {
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
                          disabled={outOfRange || Boolean(occupied)}
                          onClick={() => toggleSlot(slot)}
                        >
                          {period.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <aside className="side-panel">
          <h2>申込内容</h2>
          <div className="selection-summary">
            <strong>{selectedSlots.length}</strong>
            <span>/ 50 コマ選択中</span>
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
        <h2>{apiUser?.isAdmin ? '予約管理' : '自分の申込'}</h2>
        <div className="reservation-list">
          {reservations.map((reservation) => (
            <article className="reservation-card" key={reservation.id}>
              <div>
                <strong>{reservation.groupName}</strong>
                <span className={`status ${reservation.status}`}>{statusLabel(reservation.status)}</span>
              </div>
              <p>{reservation.slots.map((slot) => `${slot.date} ${PERIODS.find((p) => p.id === slot.period)?.label}`).join('、')}</p>
              <p>{reservation.representative.name} / {reservation.representative.phone} / {reservation.expectedAttendees}名</p>
              <p>{reservation.purpose}</p>
              {apiUser?.isAdmin && reservation.status !== 'cancelled' && (
                <div className="admin-actions">
                  {reservation.status === 'pending' && (
                    <button className="secondary-button" onClick={() => adminAction(reservation.id, 'approve')}>
                      <ShieldCheck size={16} />
                      承認
                    </button>
                  )}
                  <button className="danger-button" onClick={() => adminAction(reservation.id, 'cancel')}>
                    <Trash2 size={16} />
                    取消
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
