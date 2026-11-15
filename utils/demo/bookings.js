// Demo: car wash orders, appointments, the queue screen and the activity log
// (deletions, price changes). Mirrors the booking endpoints of the real backend.

import { route, seeder, httpError, nextId, nowIso, dateOnly, isoAt, rng, paginate, getDb } from './core';
import { SERVICE_GROUPS, EXTRAS, TOKEN_LETTERS, EXTRAS_TOKEN_LETTER, servicesPrice, findExtra } from '../priceList';

// ── sample people ───────────────────────────────────────────
export const SAMPLE_CUSTOMERS = [
  ['Ahmed Al-Mansoori', '97455012301'], ['Fatima Hassan', '97455012302'], ['Omar Khalid', '97455012303'],
  ['Sara Ibrahim', '97455012304'], ['Yousef Al-Kuwari', '97455012305'], ['Mariam Saleh', '97455012306'],
  ['Khalid Rahman', '97455012307'], ['Noura Al-Thani', '97455012308'], ['Hamad Nasser', '97455012309'],
  ['Aisha Mohammed', '97455012310'], ['Rashid Ali', '97455012311'], ['Layla Faris', '97455012312'],
  ['John Mathews', '97455012313'], ['Priya Nair', '97455012314'], ['David Wilson', '97455012315'],
  ['Ravi Kumar', '97455012316'], ['Hassan Tariq', '97455012317'], ['Mohammed Saeed', '97455012318'],
  ['Abdullah Jaber', '97455012319'], ['Reem Adel', '97455012320'], ['Tariq Aziz', '97455012321'],
  ['Salman Qureshi', '97455012322'], ['Ali Haider', '97455012323'], ['Huda Kamal', '97455012324'],
  ['Faisal Al-Marri', '97455012325'], ['Mona Youssef', '97455012326'], ['Imran Sheikh', '97455012327'],
  ['George Thomas', '97455012328'], ['Nasser Al-Sulaiti', '97455012329'], ['Dana Al-Emadi', '97455012330'],
  ['Bilal Anwar', '97455012331'], ['Zainab Hussain', '97455012332'], ['Karim Mostafa', '97455012333'],
  ['Lina Haddad', '97455012334'], ['Sami Al-Kaabi', '97455012335'], ['Arjun Menon', '97455012336'],
];
/** Each sample customer's car: [vehicle type, plate]. Same index as SAMPLE_CUSTOMERS. */
export const SAMPLE_CARS = SAMPLE_CUSTOMERS.map((_, i) => [
  ['Sedan', 'SUV', '7-Seater', 'Sedan', 'SUV'][i % 5],
  String(310000 + i * 7919 % 689999),
]);

const WASH = 'Body Wash – In & Out';
const SERVICE_MIX = [
  [WASH], [WASH], [WASH], [WASH], [WASH], [WASH], [WASH], [WASH],
  ['Full Interior Cleaning'], [WASH, 'Glass Polish'], ['Body Polishing'], [WASH, 'Full Interior Cleaning'],
  ['Interior & Exterior Polishing'], ['Nano Ceramic Tint'], ['Nano Ceramic Coating – Graphene Pro'], ['Glass Polish'],
];

// ── formatting like the backend ─────────────────────────────
const splitTokens = (v) => String(v || '').split(',').map((t) => t.trim()).filter(Boolean);

export function formatBooking(row) {
  let sub = row.sub_Service;
  if (typeof sub === 'string' && sub.trim().startsWith('[')) {
    try { sub = JSON.parse(sub); } catch { /* text */ }
  } else if (typeof sub === 'string' && sub) {
    sub = sub.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const { is_deleted: _d, ...rest } = row;
  return { ...rest, sub_Service: sub ?? null, tokens: splitTokens(row.tokens) };
}

const isCarWash = (row) => String(row.Service || '').trim().toLowerCase() === 'car wash';
const normalizePlate = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const OPEN_STAGES = ['waiting', 'washing', 'ready'];

function tokenLetters(fields) {
  let list = fields.sub_Service;
  if (typeof list === 'string' && list.trim().startsWith('[')) {
    try { list = JSON.parse(list); } catch { /* text */ }
  }
  const names = (Array.isArray(list) ? list : String(list || fields.package || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean);
  const letters = [];
  names.forEach((n) => { const l = TOKEN_LETTERS[n]; if (l && !letters.includes(l)) letters.push(l); });
  if (String(fields.add_ons || '').trim()) letters.push(EXTRAS_TOKEN_LETTER);
  return letters;
}

function issueTokens(d, letters, day = dateOnly(0)) {
  d.token_counters = d.token_counters || {};
  return letters.map((l) => {
    const key = `${day}:${l}`;
    d.token_counters[key] = (d.token_counters[key] || 100) + 1;
    return `${l}${d.token_counters[key]}`;
  }).join(',');
}

function nextBookingNumber(d) {
  return String((d.bookings || []).reduce((m, b) => Math.max(m, Number(b.booking_number) || 0), 0) + 1);
}

/**
 * Adds a booking row (used by POST /booking/booking and by the job card invoice).
 * `fields` = booking columns. Returns the stored row.
 */
export function insertBooking(d, fields, { createdAt = nowIso(), day } = {}) {
  const row = {
    id: nextId('bookings'),
    booking_number: nextBookingNumber(d),
    user_id: null,
    status: 'waiting',
    Service: 'car wash',
    service_type: 'walk-in',
    passenger_name: null,
    contact_number: null,
    package: null,
    sub_Service: null,
    package_price: null,
    car_name: null,
    car_number: null,
    add_ons: null,
    add_ons_price: null,
    date: null,
    time: null,
    date_time: null,
    price: null,
    payment_method: null,
    payment_channel: null,
    payment_type: null,
    payment_status: null,
    discount: null,
    coupon_serial: null,
    fleet_discount: null,
    subtotal: null,
    special_instructions: null,
    price_note: null,
    tokens: null,
    ...fields,
    created_at: createdAt,
    updated_at: createdAt,
    is_deleted: 0,
  };
  if (isCarWash(row) && !fields.tokens) {
    const letters = tokenLetters(row);
    row.tokens = letters.length ? issueTokens(d, letters, day || row.date || dateOnly(0)) : null;
  }
  if (typeof row.sub_Service === 'string' && row.sub_Service && !row.sub_Service.startsWith('[')) {
    row.sub_Service = JSON.stringify(row.sub_Service.split(',').map((s) => s.trim()).filter(Boolean));
  }
  ['package_price', 'add_ons_price', 'price', 'subtotal', 'fleet_discount'].forEach((k) => {
    if (row[k] !== null && row[k] !== undefined && row[k] !== '') row[k] = Number(row[k]);
  });
  d.bookings.push(row);
  return row;
}

export function logActivity(d, user, entry) {
  d.activity_log = d.activity_log || [];
  d.activity_log.push({
    id: nextId('activity_log'),
    actor_id: user ? String(user.id) : null,
    actor_name: user ? user.username : null,
    actor_role: user ? user.role : null,
    entity: 'booking',
    booking_id: null,
    old_values: null,
    new_values: null,
    created_at: nowIso(),
    ...entry,
  });
}

// ── sample data ─────────────────────────────────────────────
seeder(10, (d) => {
  d.bookings = [];
  d.activity_log = [];
  d.token_counters = {};
  const r = rng(7);
  const DAYS = 75;
  for (let ago = DAYS; ago >= 0; ago--) {
    const day = dateOnly(ago);
    const weekday = new Date(`${day}T12:00:00`).getDay();
    const busy = weekday === 5 || weekday === 6; // Friday / Saturday
    const count = ago === 0 ? 14 : r.int(busy ? 16 : 9, busy ? 26 : 17);
    for (let i = 0; i < count; i++) {
      // Past days: spread over 8:00-21:00. Today: one every ~25 minutes up to now.
      let hour = 8 + Math.floor((i / count) * 13);
      let minute = r.int(0, 59);
      if (ago === 0) {
        const at = new Date(Date.now() - (count - i) * 25 * 60000);
        hour = at.getHours();
        minute = at.getMinutes();
      }
      // The last 8 sample customers stopped coming 3+ weeks ago ("haven't come back" audience).
      const ci = r.int(0, ago < 22 ? SAMPLE_CUSTOMERS.length - 9 : SAMPLE_CUSTOMERS.length - 1);
      const walkIn = r.chance(0.18);
      const [name, phone] = walkIn ? ['Walk-in customer', ''] : SAMPLE_CUSTOMERS[ci];
      const [vehicle, plate] = walkIn ? [r.pick(['Sedan', 'SUV', '7-Seater']), String(r.int(100000, 999999))] : SAMPLE_CARS[ci];
      const services = r.pick(SERVICE_MIX);
      const extras = r.chance(0.08) ? [r.pick(EXTRAS).name] : [];
      const main = servicesPrice(services, vehicle) ?? 0;
      const extrasPrice = extras.reduce((s, n) => s + (findExtra(n)?.price ?? 0), 0);
      const subtotal = main + extrasPrice;
      const discount = r.chance(0.06) ? 'Coupon' : r.chance(0.03) ? 'Loyalty Free' : null;
      const total = discount === 'Coupon' ? Math.round(subtotal / 2) : discount === 'Loyalty Free' ? 0 : subtotal;
      const method = r.chance(0.55) ? 'Card' : 'Cash';
      const type = r.chance(0.12) ? r.pick(['Fawran', 'Paylater', 'Partner Credit']) : null;
      let stage = 'collected';
      let paid = 'paid';
      if (ago === 0) {
        const left = count - i;
        stage = left <= 3 ? 'waiting' : left <= 5 ? 'washing' : left <= 7 ? 'ready' : 'collected';
        paid = stage === 'collected' ? 'paid' : r.chance(0.4) ? 'paid' : 'unpaid';
      } else if (r.chance(0.04)) {
        paid = 'unpaid';
      }
      const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      insertBooking(d, {
        status: stage,
        Service: 'car wash',
        service_type: r.chance(0.35) ? 'kiosk' : 'walk-in',
        passenger_name: name,
        contact_number: phone ? `+${phone}` : null,
        package: services.join(', '),
        sub_Service: JSON.stringify(services),
        package_price: main,
        car_name: vehicle,
        car_number: plate,
        add_ons: extras.join(', ') || null,
        add_ons_price: extras.length ? extrasPrice : null,
        date: day,
        time: `${time}:00`,
        date_time: `${day} ${time}`,
        price: total,
        subtotal,
        discount,
        coupon_serial: discount === 'Coupon' ? `CP-${r.int(1000, 9999)}` : null,
        payment_method: method,
        payment_type: type,
        payment_channel: type,
        payment_status: paid,
      }, { createdAt: isoAt(ago, hour, minute), day });
    }
  }

  // A few upcoming appointments
  const appts = [
    [1, '10:00', 'Detailing', 3], [2, '11:30', 'Polishing', 7], [3, '16:00', 'Graphene', 12], [5, '09:30', 'Detailing', 20],
  ];
  appts.forEach(([ahead, time, type, ci]) => {
    const date = dateOnly(-ahead);
    insertBooking(d, {
      status: 'scheduled', Service: 'appointment', service_type: 'appointment',
      passenger_name: SAMPLE_CUSTOMERS[ci][0], contact_number: `+${SAMPLE_CUSTOMERS[ci][1]}`,
      package: type, sub_Service: type, date, time: `${time}:00`, date_time: `${date} ${time}`,
      special_instructions: 'Booked by phone',
    }, { createdAt: isoAt(1, 12) });
  });
});

// ── routes ──────────────────────────────────────────────────
const live = (d) => d.bookings.filter((b) => !b.is_deleted);

route('POST', '/api/v1/booking/all-bookings', ({ db, body }) => {
  const { status, Service, search, page = 1, limit = 100 } = body || {};
  let list = live(db);
  if (status && String(status).toLowerCase() !== 'all') list = list.filter((b) => b.status === status);
  if (Service && String(Service).toLowerCase() !== 'all') list = list.filter((b) => b.Service === Service);
  if (search) {
    const s = String(search).toLowerCase();
    list = list.filter((b) => [b.passenger_name, b.contact_number, b.car_number, b.booking_number].some((v) => String(v || '').toLowerCase().includes(s)));
  }
  list = [...list].sort((a, b) => b.id - a.id);
  const p = paginate(list, page, limit);
  return {
    success: true,
    message: 'Bookings fetched successfully',
    data: { status, total_records: p.total, page: p.page, per_page: p.limit, total_pages: p.total_pages, results: p.results.map(formatBooking) },
  };
});

route('GET', '/api/v1/booking/recent', ({ db }) => ({
  success: true,
  bookings: [...live(db)].sort((a, b) => b.id - a.id).slice(0, 10).map(formatBooking),
}));

route('GET', '/api/v1/booking/one-booking-details/:id', ({ db, params }) => {
  const b = live(db).find((x) => String(x.id) === params.id);
  if (!b) throw httpError(404, 'Booking not found');
  return { success: true, data: formatBooking(b) };
});

route('POST', '/api/v1/booking/booking', ({ db, body, user }) => {
  const fields = { ...body };
  delete fields.tokens;
  if (isCarWash(fields) && fields.car_number) {
    const plate = normalizePlate(fields.car_number);
    const since = Date.now() - 24 * 3600 * 1000;
    const open = live(db)
      .filter((b) => isCarWash(b) && OPEN_STAGES.includes(b.status) && new Date(b.created_at).getTime() >= since)
      .sort((a, b) => b.id - a.id)
      .find((b) => normalizePlate(b.car_number) === plate);
    if (open) {
      throw httpError(409, `This car (${open.car_number}) already has an open order #${open.booking_number} (${open.status}). Update that order instead of entering the car again.`, {
        code: 'duplicate_order',
        existing: { id: open.id, booking_number: open.booking_number, status: open.status },
      });
    }
  }
  const row = insertBooking(db, fields);
  if (user) {
    logActivity(db, user, {
      action: 'booking.create',
      booking_id: String(row.id),
      new_values: { booking_number: row.booking_number, car_number: row.car_number, Service: row.Service, status: row.status },
    });
  }
  return { status: 201, data: { success: true, booking: formatBooking(row), nearbyDrivers: [] } };
});

route('POST', '/api/v1/booking/update-status', ({ db, body }) => {
  const b = live(db).find((x) => String(x.id) === String(body?.bookingId));
  if (!b) throw httpError(404, 'Booking not found');
  b.status = body.newStatus;
  b.updated_at = nowIso();
  return { success: true, bookingId: b.id };
});

route('PUT', '/api/v1/booking/update-booking/:id', ({ db, params, body, user }) => {
  const b = live(db).find((x) => String(x.id) === params.id);
  if (!b) throw httpError(404, 'Booking not found');
  const old = {};
  Object.entries(body || {}).forEach(([k, v]) => {
    if (['id', 'booking_number', 'tokens', 'created_at'].includes(k)) return;
    old[k] = b[k];
    b[k] = ['price', 'subtotal', 'package_price', 'add_ons_price'].includes(k) && v !== '' ? Number(v) : v === '' ? null : v;
  });
  b.updated_at = nowIso();
  if ('price' in (body || {}) && 'price_note' in (body || {})) {
    logActivity(db, user, {
      action: 'booking.price_change',
      booking_id: String(b.id),
      old_values: { price: old.price, booking_number: b.booking_number },
      new_values: { price: b.price, price_note: b.price_note, booking_number: b.booking_number, passenger_name: b.passenger_name, car_number: b.car_number },
    });
  }
  return { success: true, message: 'Booking updated', data: formatBooking(b) };
});

route('PUT', '/api/v1/booking/delete-booking/:id', ({ db, params, body, user }) => {
  const b = live(db).find((x) => String(x.id) === params.id);
  if (!b) throw httpError(404, 'Booking not found');
  b.is_deleted = 1;
  logActivity(db, user, {
    action: 'booking.delete',
    booking_id: String(b.id),
    old_values: formatBooking(b),
    new_values: { reason: body?.reason || null },
  });
  return { success: true, message: 'Booking deleted' };
});

// Receipt PDF: kept in this browser as a data link (no file server in the demo).
route('POST', '/api/v1/booking/receipt/:id', async ({ files }) => {
  const file = files.file?.[0];
  if (!file) throw httpError(400, 'No file');
  const url = typeof window !== 'undefined' ? window.URL.createObjectURL(file) : '';
  return { success: true, data: { url } };
});

route('GET', '/api/v1/booking/queue-today', ({ db }) => ({
  success: true,
  data: live(db)
    .filter((b) => b.date === dateOnly(0) || String(b.created_at).slice(0, 10) === dateOnly(0))
    .sort((a, b) => a.id - b.id)
    .map((b) => ({ booking_number: b.booking_number, status: b.status, car_number: b.car_number ? String(b.car_number).slice(-3) : null, tokens: splitTokens(b.tokens) })),
}));

route('GET', '/api/v1/activity-log', ({ db, query }) => {
  let list = [...(db.activity_log || [])].sort((a, b) => b.id - a.id);
  if (query.action) list = list.filter((r) => r.action === query.action);
  if (query.booking_id) list = list.filter((r) => r.booking_id === String(query.booking_id));
  if (query.actor_role) list = list.filter((r) => r.actor_role === query.actor_role);
  const p = paginate(list, query.page, query.limit || 50);
  return {
    success: true,
    message: 'Activity log fetched',
    data: { total_records: p.total, page: p.page, per_page: p.limit, total_pages: p.total_pages, results: p.results },
  };
});

/** For other demo modules: today's live bookings etc. */
export const liveBookings = () => live(getDb());
export { SERVICE_GROUPS };
