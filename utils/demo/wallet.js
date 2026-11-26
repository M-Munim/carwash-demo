// Demo: customer wallet (prepaid balance per phone). Mirrors walletController /
// walletService of the real backend: same routes, response shapes, rules and messages.
//
// Tables in the demo db: wallets, wallet_transactions.

import { route, seeder, httpError, nextId, nowIso } from './core';
import { SAMPLE_CUSTOMERS } from './bookings';

const WALLET_PAY_METHODS = ['Cash', 'Card', 'Fawran'];
const MAX_AMOUNT = 20000;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Digits with the country code: an 8-digit Qatar number gets 974. */
const normalizePhone = (raw) => {
  const digits = String(raw || '').replace(/\D/g, '').replace(/^00/, '');
  if (/^[3-7]\d{7}$/.test(digits)) return `974${digits}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
};

function readAmount(raw, label, { min = 0.01, required = true } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) return required ? { error: `${label} is required` } : { value: 0 };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { error: `${label} must be a number with at most 2 decimals` };
  const value = Number(text);
  if (value < min) return { error: `${label} must be at least ${min}` };
  if (value > MAX_AMOUNT) return { error: `${label} can't be more than QAR ${MAX_AMOUNT}` };
  return { value };
}
const readNote = (raw) => String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 255) || null;
const bad = (message) => httpError(400, message);

const formatWallet = (w) => w && ({ id: w.id, phone: w.phone, name: w.name, balance: round2(w.balance), created_at: w.created_at, updated_at: w.updated_at });

function addTransaction(db, wallet, { type, amount, payment_method = null, booking_id = null, note = null }, actor, at = nowIso()) {
  wallet.balance = round2(Number(wallet.balance) + amount);
  wallet.updated_at = at;
  db.wallet_transactions.push({
    id: nextId('wallet_transactions'),
    wallet_id: wallet.id,
    type,
    amount: round2(amount),
    balance_after: wallet.balance,
    payment_method,
    booking_id,
    note,
    created_by: actor,
    created_at: at,
  });
}

function ensureTables(db) {
  db.wallets ||= [];
  db.wallet_transactions ||= [];
}

// ── sample data: two customers already have a balance ───────
seeder(40, (d, h) => {
  d.wallets = [];
  d.wallet_transactions = [];
  const at = (daysAgo, hour) => h.isoAt(daysAgo, hour, 15);
  const make = (index, steps) => {
    const [name, phone] = SAMPLE_CUSTOMERS[index];
    const wallet = { id: h.nextId(d, 'wallets'), phone, name, balance: 0, created_by: 'owner', created_at: at(steps[0].daysAgo, 10), updated_at: null };
    d.wallets.push(wallet);
    for (const s of steps) {
      wallet.balance = round2(wallet.balance + s.amount);
      wallet.updated_at = at(s.daysAgo, s.hour);
      d.wallet_transactions.push({
        id: h.nextId(d, 'wallet_transactions'), wallet_id: wallet.id, type: s.type, amount: s.amount, balance_after: wallet.balance,
        payment_method: s.method || null, booking_id: null, note: s.note || null, created_by: s.by || 'staff', created_at: wallet.updated_at,
      });
    }
  };
  make(0, [
    { daysAgo: 12, hour: 10, type: 'topup', amount: 500, method: 'Cash', note: 'Monthly package' },
    { daysAgo: 12, hour: 10, type: 'bonus', amount: 50, note: 'Bonus with QAR 500 top-up' },
  ]);
  make(3, [
    { daysAgo: 5, hour: 16, type: 'topup', amount: 200, method: 'Card' },
  ]);
});

// ── routes ──────────────────────────────────────────────────
route('GET', '/api/v1/wallets', ({ db }) => {
  ensureTables(db);
  const data = [...db.wallets].sort((a, b) => String(a.name).localeCompare(String(b.name))).map(formatWallet);
  return { success: true, message: 'Wallets', data };
});

route('GET', '/api/v1/wallet', ({ db, query }) => {
  ensureTables(db);
  const phone = normalizePhone(query?.phone);
  if (!phone) throw bad('phone is not a valid phone number');
  const wallet = db.wallets.find((w) => w.phone === phone);
  const transactions = wallet
    ? db.wallet_transactions.filter((t) => t.wallet_id === wallet.id).sort((a, b) => b.id - a.id).slice(0, 100)
    : [];
  return { success: true, message: 'Wallet', data: { phone, wallet: formatWallet(wallet) || null, transactions } };
});

route('POST', '/api/v1/wallet/topup', ({ db, body = {}, user }) => {
  ensureTables(db);
  const phone = normalizePhone(body.phone);
  if (!phone) throw bad('phone is not a valid phone number');
  const amount = readAmount(body.amount, 'amount');
  if (amount.error) throw bad(amount.error);
  const bonus = readAmount(body.bonus, 'bonus', { min: 0, required: false });
  if (bonus.error) throw bad(bonus.error);
  if (bonus.value > amount.value) throw bad("bonus can't be more than the amount paid");
  if (!WALLET_PAY_METHODS.includes(body.payment_method)) throw bad(`payment_method must be one of: ${WALLET_PAY_METHODS.join(', ')}`);
  const name = String(body.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 150) || null;
  const actor = user?.username || null;

  let wallet = db.wallets.find((w) => w.phone === phone);
  if (!wallet) {
    wallet = { id: nextId('wallets'), phone, name, balance: 0, created_by: actor, created_at: nowIso(), updated_at: nowIso() };
    db.wallets.push(wallet);
  } else if (name) {
    wallet.name = name;
  }
  addTransaction(db, wallet, { type: 'topup', amount: amount.value, payment_method: body.payment_method, note: readNote(body.note) }, actor);
  if (bonus.value > 0) addTransaction(db, wallet, { type: 'bonus', amount: bonus.value, note: `Bonus with QAR ${amount.value} top-up` }, actor);
  return { success: true, message: 'Balance added', data: formatWallet(wallet) };
});

route('POST', '/api/v1/wallet/refund', ({ db, body = {}, user }) => {
  ensureTables(db);
  // Like requireRole(["super_admin"]): staff (admin) get the backend's 403.
  if (user && String(user.role || '').trim().toLowerCase() !== 'super_admin') {
    throw httpError(403, 'This endpoint requires one of: super_admin', { error: 'forbidden' });
  }
  const phone = normalizePhone(body.phone);
  if (!phone) throw bad('phone is not a valid phone number');
  const amount = readAmount(body.amount, 'amount');
  if (amount.error) throw bad(amount.error);
  if (!WALLET_PAY_METHODS.includes(body.payment_method)) throw bad(`payment_method must be one of: ${WALLET_PAY_METHODS.join(', ')}`);
  const note = readNote(body.note);
  if (!note) throw bad('note is required: say why the balance is refunded');
  const wallet = db.wallets.find((w) => w.phone === phone);
  if (!wallet) throw httpError(404, 'This customer has no wallet');
  if (amount.value > Number(wallet.balance)) throw bad(`The wallet only has QAR ${round2(wallet.balance)}`);
  addTransaction(db, wallet, { type: 'refund', amount: -amount.value, payment_method: body.payment_method, note }, user?.username || null);
  return { success: true, message: 'Balance refunded', data: formatWallet(wallet) };
});

// ── paying orders from the wallet (phase 2) ─────────────────
const WALLET_METHOD = 'Wallet';
const isPaid = (b) => String(b.payment_status || b.status || '').toLowerCase() === 'paid';

/** Net wallet payment of an order (payments minus reversals) and the wallet it came from. */
export function walletPaidFor(db, bookingId) {
  ensureTables(db);
  const byWallet = new Map();
  db.wallet_transactions
    .filter((t) => String(t.booking_id) === String(bookingId) && (t.type === 'payment' || t.type === 'reversal'))
    .forEach((t) => byWallet.set(t.wallet_id, round2((byWallet.get(t.wallet_id) || 0) - Number(t.amount))));
  const entry = [...byWallet.entries()].find(([, paid]) => paid > 0);
  return { paid: entry ? entry[1] : 0, walletId: entry ? entry[0] : null };
}

/** Gives a wallet payment back (used by Undo and when a wallet-paid order is deleted). */
export function returnOrderPayment(db, booking, { note = null, unpaid = true } = {}, actor = null) {
  const { paid, walletId } = walletPaidFor(db, booking.id);
  if (!(paid > 0)) throw httpError(409, `Order #${booking.booking_number} was not paid from the wallet`);
  const wallet = db.wallets.find((w) => w.id === walletId);
  addTransaction(db, wallet, { type: 'reversal', amount: paid, booking_id: booking.id, note: note || `Order #${booking.booking_number}` }, actor);
  if (unpaid) {
    booking.payment_status = 'unpaid';
    booking.payment_method = null;
  }
  return { wallet: formatWallet(wallet), returned: paid, booking_number: booking.booking_number };
}

const findOrder = (db, id) => {
  const bookingId = Number(id);
  if (!Number.isInteger(bookingId) || bookingId < 1) throw bad('booking_id is required');
  const b = db.bookings.find((x) => x.id === bookingId && !x.is_deleted);
  if (!b) throw httpError(404, 'Order not found');
  return b;
};

route('POST', '/api/v1/wallet/pay', ({ db, body = {}, user }) => {
  ensureTables(db);
  const booking = findOrder(db, body.booking_id);
  if (isPaid(booking)) throw httpError(409, `Order #${booking.booking_number} is already paid`);
  const total = round2(booking.price);
  if (!(total > 0)) throw bad(`Order #${booking.booking_number} has no amount to pay`);
  const phone = normalizePhone(booking.contact_number);
  if (!phone) throw bad('This order has no customer phone number, so it has no wallet');
  const wallet = db.wallets.find((w) => w.phone === phone);
  if (!wallet) throw httpError(404, 'This customer has no wallet. Add balance first.');
  if (Number(wallet.balance) < total) {
    throw bad(`The wallet has QAR ${round2(wallet.balance)}, less than the order total QAR ${total}. Add balance first.`);
  }
  addTransaction(db, wallet, { type: 'payment', amount: -total, booking_id: booking.id, note: `Order #${booking.booking_number}` }, user?.username || null);
  booking.payment_status = 'paid';
  booking.payment_method = WALLET_METHOD;
  booking.updated_at = nowIso();
  return { success: true, message: 'Paid from the wallet', data: { wallet: formatWallet(wallet), paid: total, booking_number: booking.booking_number } };
});

route('POST', '/api/v1/wallet/undo-payment', ({ db, body = {}, user }) => {
  ensureTables(db);
  const booking = findOrder(db, body.booking_id);
  const data = returnOrderPayment(db, booking, {}, user?.username || null);
  return { success: true, message: 'Payment returned to the wallet', data };
});

route('GET', '/api/v1/wallet/transactions', ({ db, query = {} }) => {
  ensureTables(db);
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = String(query.from || '');
  const to = String(query.to || from);
  if (!day.test(from) || !day.test(to)) throw bad('from and to must be YYYY-MM-DD');
  if (to < from) throw bad("to can't be before from");
  // A day wider each side, like the backend; the page keeps its own local days
  const lo = new Date(`${from}T00:00:00Z`).getTime() - 86400000;
  const hi = new Date(`${to}T00:00:00Z`).getTime() + 2 * 86400000;
  const data = db.wallet_transactions
    .filter((t) => { const at = new Date(t.created_at).getTime(); return at >= lo && at < hi; })
    .map((t) => {
      const w = db.wallets.find((x) => x.id === t.wallet_id);
      return { ...t, phone: w?.phone, name: w?.name };
    });
  return { success: true, message: 'Wallet transactions', data };
});
