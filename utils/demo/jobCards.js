// Demo: customers, their vehicles and job cards (the work order for one visit).
// Mirrors customerController/customerService and jobCardController/jobCardService
// of the real backend: same response shapes, status rules and messages.
//
// Tables in the demo db: customers, customer_vehicles, job_cards,
// job_card_events (the timeline) and job_card_photos (metadata only).
// Uploaded photo files stay in memory (`photoFiles`), not in localStorage, so
// they are gone after a reload (the photo then answers 404, like a missing file).

import { route, seeder, httpError, nextId, nowIso } from './core';
import { SAMPLE_CUSTOMERS, SAMPLE_CARS, insertBooking, formatBooking, logActivity } from './bookings';
import { servicePrice, findExtra } from '../priceList';

// ── rules (same as services/jobCardService.js) ─────────────
const STATUSES = ['open', 'in_progress', 'quality_check', 'ready', 'delivered', 'cancelled'];
const FUEL_LEVELS = ['empty', 'quarter', 'half', 'three_quarters', 'full'];
const OPEN_STATUSES = ['open', 'in_progress', 'quality_check', 'ready'];
const NEXT = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['quality_check', 'cancelled'],
  quality_check: ['ready', 'in_progress'],
  ready: ['delivered', 'in_progress'],
  delivered: [],
  cancelled: [],
};
const QC_ITEMS = [
  ['services_done', 'All requested services done'],
  ['exterior_clean', 'Exterior clean, no soap or water marks'],
  ['interior_clean', 'Interior clean and vacuumed'],
  ['glass_clean', 'Windows and mirrors clean'],
  ['tyres_rims', 'Tyres and rims clean'],
  ['no_new_damage', 'No new damage (checked against check-in)'],
  ['items_returned', "Customer's items and mats back in place"],
];
const QC_PASSED = () => QC_ITEMS.map(([key, label]) => ({ key, label, ok: true }));
const PAYMENT_METHODS = ['Cash', 'Card'];
const PAYMENT_TYPES = ['Fawran', 'Paylater', 'Partner Credit'];
const MAX_PHOTOS_PER_JOB = 30;
const MAX_PHOTOS_PER_UPLOAD = 6;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SERVICES = 30;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Uploaded photo files, by photo id. In memory only (lost on reload). */
const photoFiles = new Map();

// ── small helpers ──────────────────────────────────────────
const actor = (user) => user?.username || 'demo';
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const totalOf = (services) => round2(services.reduce((s, x) => s + (Number(x.price) || 0), 0));
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** "YYYY-MM-DD HH:MM:00" local, like a MySQL DATETIME. */
const localSql = (d) => `${localDate(d)} ${localTime(d)}:00`;

const validId = (raw) => {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 && String(id) === String(raw).trim() ? id : null;
};

/** Job card text field (trimmed). */
const jobText = (value, label, max) => {
  const t = String(value ?? '').trim();
  if (t.length > max) return { error: `${label} must be ${max} characters or less` };
  return { value: t || null };
};

/** Customer / vehicle text field (trimmed, spaces collapsed). */
const custText = (value, label, max, { required = false } = {}) => {
  const t = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (required && !t) return { error: `${label} is required` };
  if (t.length > max) return { error: `${label} must be ${max} characters or less` };
  return { value: t || null };
};

/** Digits with the country code: an 8-digit Qatar number gets 974. */
const normalizePhone = (raw) => {
  const digits = String(raw || '').replace(/\D/g, '').replace(/^00/, '');
  if (/^[3-7]\d{7}$/.test(digits)) return `974${digits}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
};
const phoneTail = (digits) => String(digits || '').replace(/\D/g, '').slice(-8);
/** Saved-vehicle plate (keeps Arabic letters), like bookingService.normalizePlate. */
const normalizePlate = (plate) => String(plate || '').toUpperCase().replace(/[^A-Z0-9؀-ۿ]/g, '');
/** Order plates are compared on A-Z / 0-9 only (the SQL REGEXP in customerService). */
const orderPlate = (plate) => String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const bad = (message) => httpError(400, message);

// ── formatting (same shapes as the backend) ────────────────
const liveCustomers = (d) => (d.customers || []).filter((c) => !c.is_deleted);
const liveVehicles = (d) => (d.customer_vehicles || []).filter((v) => !v.is_deleted);

function formatVehicle(v) {
  if (!v) return null;
  return {
    id: v.id, customer_id: v.customer_id, plate: v.plate, vehicle_type: v.vehicle_type, make: v.make,
    model: v.model, color: v.color, year: v.year, notes: v.notes, created_at: v.created_at,
  };
}

function formatCustomer(d, c) {
  if (!c) return null;
  return {
    id: c.id, name: c.name, phone: c.phone, email: c.email, notes: c.notes,
    created_by: c.created_by, created_at: c.created_at,
    vehicles: liveVehicles(d).filter((v) => v.customer_id === c.id).sort((a, b) => a.id - b.id).map(formatVehicle),
  };
}

const findCustomer = (d, id) => liveCustomers(d).find((c) => c.id === id) || null;
const findVehicle = (d, id) => liveVehicles(d).find((v) => v.id === id) || null;

function formatJob(d, r) {
  const c = (d.customers || []).find((x) => x.id === r.customer_id) || {};
  const v = (d.customer_vehicles || []).find((x) => x.id === r.vehicle_id) || {};
  return {
    id: r.id,
    job_number: r.job_number,
    status: r.status,
    customer: { id: r.customer_id, name: c.name, phone: c.phone },
    vehicle: { id: r.vehicle_id, plate: v.plate, vehicle_type: v.vehicle_type, make: v.make, model: v.model, color: v.color, year: v.year },
    mileage: r.mileage,
    fuel_level: r.fuel_level,
    damage_notes: r.damage_notes,
    complaints: r.complaints,
    services: Array.isArray(r.services) ? r.services : [],
    total: r.total === null || r.total === undefined ? null : Number(r.total),
    technician: r.technician,
    promised_at: r.promised_at,
    notes: r.notes,
    booking_id: r.booking_id,
    qc_checklist: Array.isArray(r.qc_checklist) ? r.qc_checklist : [],
    qc_by: r.qc_by ?? null,
    qc_at: r.qc_at ?? null,
    invoiced_at: r.invoiced_at ?? null,
    created_by: r.created_by,
    updated_by: r.updated_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const formatPhoto = (p) => ({ id: p.id, caption: p.caption, file_type: p.file_type, created_by: p.created_by, created_at: p.created_at });
const photosOf = (d, jobId) => (d.job_card_photos || []).filter((p) => p.job_card_id === jobId).sort((a, b) => a.id - b.id);

/** One job card with its timeline, photos and linked order (getById). */
function getJob(d, id) {
  const r = (d.job_cards || []).find((j) => j.id === id);
  if (!r) return null;
  const events = (d.job_card_events || [])
    .filter((e) => e.job_card_id === id)
    .sort((a, b) => a.id - b.id)
    .map((e) => ({ from_status: e.from_status, to_status: e.to_status, note: e.note, created_by: e.created_by, created_at: e.created_at }));
  const b = r.booking_id ? (d.bookings || []).find((x) => x.id === r.booking_id) : null;
  return { ...formatJob(d, r), events, photos: photosOf(d, id).map(formatPhoto), order: b ? formatBooking(b) : null };
}

function addEvent(d, jobId, from, to, note, by, at = nowIso(), idFn = nextId) {
  d.job_card_events = d.job_card_events || [];
  d.job_card_events.push({ id: idFn('job_card_events'), job_card_id: jobId, from_status: from, to_status: to, note: note ?? null, created_by: by, created_at: at });
}

/** The booking columns for the order a Ready job card becomes (jobCardService.invoice). */
function orderFields(job, { payment_method, payment_type = null, payment_status }, when) {
  const names = job.services.map((s) => s.name);
  const date = localDate(when);
  const time = localTime(when);
  return {
    Service: 'car wash',
    service_type: 'job-card',
    status: 'collected',
    passenger_name: job.customer.name,
    contact_number: `+${job.customer.phone}`,
    package: names.join(', ') || `Job card ${job.job_number}`,
    sub_Service: JSON.stringify(names),
    package_price: job.total,
    car_name: job.vehicle.vehicle_type || null,
    car_number: job.vehicle.plate,
    subtotal: job.total,
    price: job.total,
    payment_method,
    payment_type,
    payment_channel: payment_type,
    payment_status,
    date,
    time,
    date_time: `${date} ${time}`,
    special_instructions: `Job card ${job.job_number}`,
    images: '[]',
    tokens: 'none', // the real invoice issues no queue tokens; cleared right after insert
  };
}

function insertJobOrder(d, job, pay, when) {
  const row = insertBooking(d, orderFields(job, pay, when), { createdAt: when.toISOString(), day: localDate(when) });
  row.tokens = null;
  return row;
}

const invoiceNote = (bookingNumber, { payment_method, payment_type, payment_status }) =>
  `Invoiced as order #${bookingNumber} (${payment_status}, ${[payment_method, payment_type].filter(Boolean).join(' · ')})`;

// ── reading request bodies (same checks as the controllers) ─
function readServices(raw) {
  if (!Array.isArray(raw)) return 'services must be a list of { name, price }';
  if (raw.length > MAX_SERVICES) return `services can have at most ${MAX_SERVICES} lines`;
  const out = [];
  for (const [i, s] of raw.entries()) {
    const name = String(s?.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) return `services[${i}].name is required`;
    if (name.length > 150) return `services[${i}].name must be 150 characters or less`;
    const priceText = String(s?.price ?? '0').trim() || '0';
    if (!/^\d+(\.\d{1,2})?$/.test(priceText) || Number(priceText) > 1_000_000) return `services[${i}].price must be a number (up to 2 decimals)`;
    out.push({ name, price: Number(priceText) });
  }
  return out;
}

function readJob(body = {}, partial = false) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('mileage')) {
    const raw = String(body.mileage ?? '').trim();
    if (raw) {
      if (!/^\d{1,7}$/.test(raw)) return 'mileage must be a whole number of km';
      out.mileage = Number(raw);
    } else out.mileage = null;
  }
  if (!partial || has('fuel_level')) {
    const f = body.fuel_level || null;
    if (f && !FUEL_LEVELS.includes(f)) return `fuel_level must be one of: ${FUEL_LEVELS.join(', ')}`;
    out.fuel_level = f;
  }
  for (const [key, max] of [['damage_notes', 2000], ['complaints', 2000], ['technician', 100], ['notes', 255]]) {
    if (partial && !has(key)) continue;
    const t = jobText(body[key], key, max);
    if (t.error) return t.error;
    out[key] = t.value;
  }
  if (!partial || has('services')) {
    const s = readServices(body.services ?? []);
    if (typeof s === 'string') return s;
    out.services = s;
  }
  if (!partial || has('promised_at')) {
    const raw = String(body.promised_at ?? '').trim();
    if (raw && !DATETIME.test(raw)) return 'promised_at must be a date and time like 2026-11-12T17:30';
    // Kept as local "YYYY-MM-DD HH:MM:00" so the form's datetime-local reads it back as typed
    out.promised_at = raw ? `${raw.replace('T', ' ').slice(0, 16)}:00` : null;
  }
  return out;
}

function readCustomer(body = {}, partial = false) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('name')) {
    const t = custText(body.name, 'name', 150, { required: true });
    if (t.error) return t.error;
    out.name = t.value;
  }
  if (!partial || has('phone')) {
    const phone = normalizePhone(body.phone);
    if (!phone) return 'phone is not a valid phone number';
    out.phone = phone;
  }
  if (!partial || has('email')) {
    const t = custText(body.email, 'email', 150);
    if (t.error) return t.error;
    if (t.value && !EMAIL.test(t.value)) return 'email is not valid';
    out.email = t.value;
  }
  if (!partial || has('notes')) {
    const t = custText(body.notes, 'notes', 255);
    if (t.error) return t.error;
    out.notes = t.value;
  }
  return out;
}

function readVehicle(body = {}, partial = false) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('plate')) {
    const t = custText(body.plate, 'plate', 30, { required: true });
    if (t.error) return t.error;
    if (!normalizePlate(t.value)) return 'plate must have letters or numbers';
    out.plate = t.value.toUpperCase();
  }
  for (const [key, max] of [['vehicle_type', 40], ['make', 60], ['model', 60], ['color', 40], ['notes', 255]]) {
    if (partial && !has(key)) continue;
    const t = custText(body[key], key, max);
    if (t.error) return t.error;
    out[key] = t.value;
  }
  if (!partial || has('year')) {
    const raw = String(body.year ?? '').trim();
    if (raw) {
      const year = Number(raw);
      const max = new Date().getFullYear() + 1;
      if (!Number.isInteger(year) || year < 1950 || year > max) return `year must be from 1950 to ${max}`;
      out.year = year;
    } else out.year = null;
  }
  return out;
}

// ── customer data operations ───────────────────────────────
function vehicleByPlate(d, plate) {
  const norm = normalizePlate(plate);
  if (!norm) return null;
  const v = liveVehicles(d).find((x) => x.plate_norm === norm && findCustomer(d, x.customer_id));
  return v ? { ...v, customer_name: findCustomer(d, v.customer_id).name } : null;
}

function addVehicleRow(d, customerId, v, by) {
  const owner = vehicleByPlate(d, v.plate);
  if (owner) {
    throw httpError(409, owner.customer_id === customerId
      ? `This customer already has the plate ${owner.plate}`
      : `The plate ${owner.plate} is saved for ${owner.customer_name}`, { vehicle_id: owner.id, customer_id: owner.customer_id });
  }
  const now = nowIso();
  const row = {
    id: nextId('customer_vehicles'), customer_id: customerId, plate: v.plate, plate_norm: normalizePlate(v.plate),
    vehicle_type: v.vehicle_type ?? null, make: v.make ?? null, model: v.model ?? null, color: v.color ?? null,
    year: v.year ?? null, notes: v.notes ?? null, created_by: by, is_deleted: 0, created_at: now, updated_at: now,
  };
  d.customer_vehicles.push(row);
  return row;
}

/** Car wash orders of a customer: same phone (last 8 digits) or one of their plates. */
function pastOrders(d, customer) {
  const tail = phoneTail(customer.phone);
  const plates = customer.vehicles.map((v) => orderPlate(v.plate)).filter(Boolean);
  if (tail.length !== 8 && !plates.length) return [];
  const list = (v) => {
    try {
      const parsed = JSON.parse(v || '[]');
      return Array.isArray(parsed) ? parsed : [String(parsed)];
    } catch {
      return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
    }
  };
  return (d.bookings || [])
    .filter((b) => !b.is_deleted && String(b.Service || '').trim().toLowerCase() === 'car wash')
    .filter((b) => (tail.length === 8 && String(b.contact_number || '').replace(/\D/g, '').endsWith(tail))
      || (plates.length && plates.includes(orderPlate(b.car_number))))
    .sort((a, b) => b.id - a.id)
    .slice(0, 100)
    .map((b) => {
      const services = list(b.sub_Service);
      return {
        id: b.id,
        booking_number: b.booking_number,
        created_at: b.created_at,
        services: services.length ? services : list(b.package),
        plate: b.car_number || '',
        vehicle_type: b.car_name || '',
        total: Number(b.price) || 0,
        paid: String(b.payment_status || b.status || '').toLowerCase() === 'paid',
        source: b.service_type || '',
      };
    });
}

// ── sample data ────────────────────────────────────────────
const CATALOGUE = {
  Sedan: [['Toyota', 'Camry'], ['Nissan', 'Altima'], ['Hyundai', 'Sonata'], ['Lexus', 'ES 350'], ['Honda', 'Accord'], ['Mercedes-Benz', 'C 200'], ['Kia', 'K5'], ['BMW', '520i']],
  SUV: [['Toyota', 'Land Cruiser'], ['Nissan', 'Patrol'], ['Lexus', 'LX 600'], ['Toyota', 'Prado'], ['Hyundai', 'Tucson'], ['Land Rover', 'Range Rover Sport'], ['Kia', 'Sportage'], ['Mitsubishi', 'Pajero']],
  '7-Seater': [['GMC', 'Yukon'], ['Chevrolet', 'Tahoe'], ['Kia', 'Carnival'], ['Hyundai', 'Palisade'], ['Ford', 'Expedition'], ['Toyota', 'Sequoia']],
};
const COLOURS = ['White', 'Pearl White', 'Black', 'Silver', 'Grey', 'Dark Blue', 'Maroon', 'Beige'];
const COLOUR_HEX = { White: '#f4f4f4', 'Pearl White': '#ece8df', Black: '#2b2b2b', Silver: '#c3c6c9', Grey: '#8a8f94', 'Dark Blue': '#1f3a64', Maroon: '#6d1f2a', Beige: '#d8c7a6' };

/** Sample customers left unsaved, so search also shows "from past orders" people. */
const UNSAVED = [];
/** Sample customers with a second car: [index, vehicle type, plate]. */
const SECOND_CARS = [[1, 'SUV', '604112']];
const EMAILS = { 1: 'fatima.hassan@example.com' };
const CUSTOMER_NOTES = { 0: 'Regular every Friday', 1: 'Two family cars' };

const WASH = 'Body Wash – In & Out';
/** Rough minutes each service takes (for the sample timelines). */
const WORK_MIN = { [WASH]: 40, 'Glass Polish': 60, 'Full Interior Cleaning': 120, 'Body Polishing': 180, 'Interior & Exterior Polishing': 240, 'Nano Ceramic Tint': 180, 'Nano Ceramic Coating – Graphene Pro': 360, 'Paint Protection Film (PPF)': 600 };

/**
 * Sample job cards. c = SAMPLE_CUSTOMERS index, v = which of their cars.
 * Past cards: ago (days) + h:m created. Today's: minsAgo (created that long ago).
 */
const JOBS = [
  // delivered and invoiced
  { c: 0, ago: 2, h: 10, m: 15, status: 'delivered', services: ['Body Polishing', 'Glass Polish'], tech: 'Ramesh', fuel: 'half',
    damage: 'Light swirl marks on bonnet and roof. Small scratch on rear bumper (left).', complaints: 'Wants the shine back before a family trip.',
    pay: { payment_method: 'Card', payment_status: 'paid' }, photos: ['Before polishing: bonnet', 'After polishing: bonnet'] },
  // still in the workshop
  { c: 4, minsAgo: 260, work: 180, status: 'ready', services: ['Body Polishing'], tech: 'Ramesh', fuel: 'quarter',
    damage: 'Scratch on the rear bumper (right).', promise: 300 },
  { c: 3, minsAgo: 150, work: 110, status: 'quality_check', services: ['Full Interior Cleaning'], tech: 'Joseph', fuel: 'half',
    complaints: 'Coffee stain on the passenger seat. Smell of smoke inside.', promise: 180 },
  { c: 2, minsAgo: 70, status: 'in_progress', services: ['Interior & Exterior Polishing'], tech: 'Sunil', fuel: 'half',
    damage: 'Small dent on the boot lid.', notes: 'Keep the floor mats in the boot', promise: 300 },
  { c: 1, v: 1, minsAgo: 20, status: 'open', services: ['Body Polishing'], fuel: 'half',
    damage: 'Scratch on the rear bumper, swirl marks on both front doors.', complaints: 'Wants the scratches polished out if possible.', promise: 240,
    photos: ['Check-in: rear bumper scratch'] },
];

const FRONT_DESK = 'staff';
const SUPERVISOR = 'owner';

/** Price-list price of a service for a vehicle type (0 when not on the list). */
const priceOf = (name, type) => servicePrice(name, type) ?? findExtra(name)?.price ?? 0;

/**
 * Gives every booking an id and order number in time order. The job card
 * orders are added after the 75 days of sample orders, so without this they
 * would sit at the top of Car Wash Orders (sorted by id).
 */
function renumberBookings(d) {
  const sorted = [...d.bookings].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
  const map = new Map();
  sorted.forEach((b, i) => { map.set(b.id, i + 1); b.id = i + 1; b.booking_number = String(i + 1); });
  d.bookings = sorted;
  d._ids.bookings = sorted.length;
  (d.activity_log || []).forEach((a) => { if (a.booking_id && map.has(Number(a.booking_id))) a.booking_id = String(map.get(Number(a.booking_id))); });
  return map;
}

seeder(20, (d, h) => {
  const id = (table) => h.nextId(d, table);
  const r = h.rng(31);
  const now = new Date();
  const at = (ago, hour, minute) => { const t = new Date(); t.setDate(t.getDate() - ago); t.setHours(hour, minute, 0, 0); return t; };
  const plus = (t, mins) => new Date(t.getTime() + mins * 60000);
  const notAfterNow = (t) => (t > now ? new Date(now.getTime() - 60000) : t);

  d.customers = [];
  d.customer_vehicles = [];
  d.job_cards = [];
  d.job_card_events = [];
  d.job_card_photos = [];

  // customers and their cars (same phones and plates as the sample orders)
  const bySample = {}; // sample index → { customer, vehicles: [] }
  const addCar = (customer, type, plate, createdAt) => {
    const [make, model] = r.pick(CATALOGUE[type]);
    const row = {
      id: id('customer_vehicles'), customer_id: customer.id, plate, plate_norm: normalizePlate(plate), vehicle_type: type,
      make, model, color: r.pick(COLOURS), year: r.int(2015, now.getFullYear()), notes: null, created_by: FRONT_DESK,
      is_deleted: 0, created_at: createdAt, updated_at: createdAt,
    };
    d.customer_vehicles.push(row);
    bySample[customer._sample].vehicles.push(row);
  };
  SAMPLE_CUSTOMERS.forEach(([name, phone], i) => {
    if (UNSAVED.includes(i)) return;
    const createdAt = h.isoAt(90 - i * 2, 9 + (i % 9), (i * 13) % 60);
    const c = {
      id: id('customers'), name, phone, email: EMAILS[i] || null, notes: CUSTOMER_NOTES[i] || null,
      created_by: FRONT_DESK, updated_by: FRONT_DESK, is_deleted: 0, created_at: createdAt, updated_at: createdAt, _sample: i,
    };
    d.customers.push(c);
    bySample[i] = { customer: c, vehicles: [] };
    addCar(c, SAMPLE_CARS[i][0], SAMPLE_CARS[i][1], createdAt);
  });
  SECOND_CARS.forEach(([i, type, plate]) => addCar(bySample[i].customer, type, plate, h.isoAt(40 - i, 12)));
  d.customers.forEach((c) => { delete c._sample; });

  // job cards, oldest first
  const order = [...JOBS].sort((a, b) => {
    const t = (j) => (j.minsAgo !== undefined ? now.getTime() - j.minsAgo * 60000 : at(j.ago, j.h, j.m).getTime());
    return t(a) - t(b);
  });
  const invoiced = []; // [job row, booking row, pay, time] to finish after renumbering
  order.forEach((spec) => {
    const { customer, vehicles } = bySample[spec.c];
    const vehicle = vehicles[spec.v || 0];
    const created = spec.minsAgo !== undefined ? new Date(now.getTime() - spec.minsAgo * 60000) : at(spec.ago, spec.h, spec.m);
    const services = spec.services.map((name) => ({ name, price: priceOf(name, vehicle.vehicle_type) }));
    const jobId = id('job_cards');
    let promised = null;
    if (spec.promiseAt) promised = at(-spec.promiseAt[0], spec.promiseAt[1], spec.promiseAt[2]);
    else if (spec.promise) { promised = plus(created, spec.promise); promised.setMinutes(Math.ceil(promised.getMinutes() / 30) * 30, 0, 0); }
    const job = {
      id: jobId, job_number: `JC-${1000 + jobId}`, customer_id: customer.id, vehicle_id: vehicle.id,
      mileage: r.int(8, 190) * 1000 + r.int(0, 999), fuel_level: spec.fuel || null,
      damage_notes: spec.damage || null, complaints: spec.complaints || null, services, total: totalOf(services),
      technician: null, status: 'open', promised_at: promised ? localSql(promised) : null, notes: spec.notes || null,
      booking_id: null, qc_checklist: [], qc_by: null, qc_at: null, invoiced_at: null,
      created_by: FRONT_DESK, updated_by: FRONT_DESK, created_at: created.toISOString(), updated_at: created.toISOString(),
    };
    d.job_cards.push(job);

    // the timeline, step by step until the card's status
    let t = created;
    const step = (from, to, note, by, mins) => {
      t = notAfterNow(plus(t, mins));
      addEvent(d, jobId, from, to, note, by, t.toISOString(), id);
      job.status = to;
      job.updated_by = by;
      job.updated_at = t.toISOString();
    };
    addEvent(d, jobId, null, 'open', 'Job card created', FRONT_DESK, created.toISOString(), id);
    const target = spec.status;
    if (target === 'cancelled') {
      step('open', 'cancelled', spec.cancelNote, FRONT_DESK, 25);
    } else if (target !== 'open') {
      job.technician = spec.tech || null;
      step('open', 'in_progress', null, FRONT_DESK, r.int(10, 25));
      if (target !== 'in_progress') {
        const work = spec.work ?? spec.services.reduce((s, n) => s + (WORK_MIN[n] || 60), 0);
        step('in_progress', 'quality_check', null, FRONT_DESK, work);
        if (spec.qcFail) {
          step('quality_check', 'in_progress', spec.qcFail, SUPERVISOR, 10);
          step('in_progress', 'quality_check', null, FRONT_DESK, 25);
        }
        if (target === 'ready' || target === 'delivered') {
          step('quality_check', 'ready', null, SUPERVISOR, 15);
          job.qc_checklist = QC_PASSED();
          job.qc_by = SUPERVISOR;
          job.qc_at = t.toISOString();
        }
        if (target === 'delivered') {
          const when = notAfterNow(plus(t, r.int(20, 90)));
          const booking = insertJobOrder(d, formatJob(d, job), spec.pay, when);
          job.booking_id = booking.id;
          invoiced.push([job, booking, spec.pay, when]);
        }
      }
    }
    if (spec.photos) {
      spec.photos.forEach((caption, k) => {
        const pAt = plus(created, 5 + k).toISOString();
        d.job_card_photos.push({ id: id('job_card_photos'), job_card_id: jobId, file_name: 'sample', file_type: 'image/svg+xml', caption, created_by: FRONT_DESK, created_at: pAt, sample: true, color: vehicle.color });
      });
    }
  });

  // the orders get their final numbers, then the "Invoiced as order #…" events
  const map = renumberBookings(d);
  invoiced.forEach(([job, booking, pay, when]) => {
    job.booking_id = map.get(job.booking_id) ?? booking.id;
    addEvent(d, job.id, 'ready', 'delivered', invoiceNote(booking.booking_number, pay), FRONT_DESK, when.toISOString(), id);
    job.status = 'delivered';
    job.invoiced_at = when.toISOString();
    job.updated_at = when.toISOString();
  });
  // events were added out of order for delivered cards: put the table in time order
  d.job_card_events.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  d.job_card_events.forEach((e, i) => { e.id = i + 1; });
  d._ids.job_card_events = d.job_card_events.length;
});

/** A simple car drawing with the caption, for the sample photos. */
function sampleCarSvg(caption, colorName) {
  const body = COLOUR_HEX[colorName] || '#c3c6c9';
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="800" height="800">
  <rect width="400" height="400" fill="#e9edf1"/>
  <rect y="270" width="400" height="130" fill="#cfd5db"/>
  <path d="M60 250 L80 205 Q90 185 115 180 L150 150 Q165 138 190 138 L255 138 Q280 138 295 155 L320 182 Q345 188 352 210 L355 250 Z" fill="${body}" stroke="#3b4450" stroke-width="3"/>
  <path d="M158 160 Q168 150 188 150 L222 150 L222 182 L135 182 Z" fill="#9fb4c8" stroke="#3b4450" stroke-width="2"/>
  <path d="M232 150 L255 150 Q273 150 285 163 L303 182 L232 182 Z" fill="#9fb4c8" stroke="#3b4450" stroke-width="2"/>
  <circle cx="125" cy="252" r="28" fill="#2f343a"/><circle cx="125" cy="252" r="12" fill="#a9b0b8"/>
  <circle cx="295" cy="252" r="28" fill="#2f343a"/><circle cx="295" cy="252" r="12" fill="#a9b0b8"/>
  <text x="200" y="330" font-family="Arial, sans-serif" font-size="17" fill="#2f343a" text-anchor="middle">${esc(caption)}</text>
  <text x="200" y="356" font-family="Arial, sans-serif" font-size="12" fill="#6b7480" text-anchor="middle">Sample photo</text>
</svg>`;
  return new Blob([svg], { type: 'image/svg+xml' });
}

// ── customer routes (specific paths before /customers/:id) ─
route('GET', '/api/v1/customers/search', ({ db, query }) => {
  const text = String(query.q || '').trim().slice(0, 50);
  const digits = text.replace(/\D/g, '');
  const plate = normalizePlate(text);
  const byPhone = digits.length >= 4 && digits.length === text.replace(/[\s+\-()]/g, '').length;
  if (!byPhone && plate.length < 2) return { success: true, message: 'Search results', data: { customers: [], past_orders: [] } };

  // saved customers: phone, plate or name
  const phonePart = digits.replace(/^00/, '');
  const lower = text.toLowerCase();
  const customers = liveCustomers(db)
    .filter((c) => (byPhone && c.phone.includes(phonePart))
      || (plate.length >= 2 && liveVehicles(db).some((v) => v.customer_id === c.id && v.plate_norm.includes(plate)))
      || c.name.toLowerCase().includes(lower))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 10)
    .map((c) => formatCustomer(db, c));
  const savedTails = new Set(customers.map((c) => phoneTail(c.phone)));
  const savedPlates = new Set(customers.flatMap((c) => c.vehicles.map((v) => normalizePlate(v.plate))));

  // past orders whose person isn't saved yet: newest first, one per phone + plate
  const tail = phoneTail(digits) || digits;
  const oPlate = plate.replace(/[^A-Z0-9]/g, '');
  const rows = (db.bookings || [])
    .filter((b) => !b.is_deleted)
    .filter((b) => (byPhone && String(b.contact_number || '').replace(/\D/g, '').includes(tail))
      || (plate.length >= 2 && orderPlate(b.car_number).includes(oPlate)))
    .sort((a, b) => b.id - a.id)
    .slice(0, 200);
  const seen = new Map();
  for (const b of rows) {
    const phone = normalizePhone(b.contact_number);
    const key = `${phoneTail(b.contact_number)}|${normalizePlate(b.car_number)}`;
    if (!phone || savedTails.has(phoneTail(phone))) continue;
    if (b.car_number && savedPlates.has(normalizePlate(b.car_number))) continue;
    if (seen.has(key)) { seen.get(key).visits += 1; continue; }
    seen.set(key, { name: b.passenger_name || '', phone, plate: b.car_number || '', vehicle_type: b.car_name || '', last_visit: b.created_at, visits: 1 });
  }
  return { success: true, message: 'Search results', data: { customers, past_orders: [...seen.values()].slice(0, 10) } };
});

route('POST', '/api/v1/customers/add', ({ db, body, user }) => {
  const customer = readCustomer(body);
  if (typeof customer === 'string') throw bad(customer);
  let vehicle = null;
  if (body?.vehicle) {
    vehicle = readVehicle(body.vehicle);
    if (typeof vehicle === 'string') throw bad(`vehicle: ${vehicle}`);
  }
  const existing = liveCustomers(db).find((c) => c.phone === customer.phone);
  if (existing) throw httpError(409, `${existing.name} is already saved with this phone number`, { customer_id: existing.id });
  if (vehicle) {
    // checked before saving, so a plate clash saves nothing (the real one rolls back)
    const owner = vehicleByPlate(db, vehicle.plate);
    if (owner) throw httpError(409, `The plate ${owner.plate} is saved for ${owner.customer_name}`, { vehicle_id: owner.id, customer_id: owner.customer_id });
  }
  const now = nowIso();
  const row = {
    id: nextId('customers'), name: customer.name, phone: customer.phone, email: customer.email ?? null, notes: customer.notes ?? null,
    created_by: actor(user), updated_by: actor(user), is_deleted: 0, created_at: now, updated_at: now,
  };
  db.customers.push(row);
  if (vehicle) addVehicleRow(db, row.id, vehicle, actor(user));
  const saved = formatCustomer(db, row);
  logActivity(db, user, { action: 'customer.add', entity: 'customer', new_values: { id: saved.id, name: saved.name, phone: saved.phone, plate: vehicle?.plate } });
  return { status: 201, data: { success: true, message: 'Customer saved', data: saved } };
});

route('PUT', '/api/v1/customers/update/:id', ({ db, params, body, user }) => {
  const id = validId(params.id);
  const row = id && findCustomer(db, id);
  if (!row) throw httpError(404, 'Customer not found');
  const fields = readCustomer(body, true);
  if (typeof fields === 'string') throw bad(fields);
  if (!Object.keys(fields).length) throw bad('No fields provided to update');
  if (fields.phone) {
    const other = liveCustomers(db).find((c) => c.phone === fields.phone);
    if (other && other.id !== id) throw httpError(409, `${other.name} is already saved with this phone number`, { customer_id: other.id });
  }
  const before = { ...row };
  Object.assign(row, fields, { updated_by: actor(user), updated_at: nowIso() });
  const changed = Object.keys(fields).filter((k) => before[k] !== row[k]);
  if (changed.length) {
    logActivity(db, user, {
      action: 'customer.update', entity: 'customer',
      old_values: Object.fromEntries(changed.map((k) => [k, before[k]])),
      new_values: { id, ...Object.fromEntries(changed.map((k) => [k, row[k]])) },
    });
  }
  return { success: true, message: 'Customer updated', data: formatCustomer(db, row) };
});

route('POST', '/api/v1/customers/:id/vehicles/add', ({ db, params, body, user }) => {
  const id = validId(params.id);
  if (!id || !findCustomer(db, id)) throw httpError(404, 'Customer not found');
  const vehicle = readVehicle(body);
  if (typeof vehicle === 'string') throw bad(vehicle);
  const saved = formatVehicle(addVehicleRow(db, id, vehicle, actor(user)));
  logActivity(db, user, { action: 'customer.vehicle_add', entity: 'customer', new_values: { customer_id: id, ...vehicle } });
  return { status: 201, data: { success: true, message: 'Vehicle added', data: saved } };
});

route('PUT', '/api/v1/customers/vehicles/update/:id', ({ db, params, body, user }) => {
  const id = validId(params.id);
  const row = id && findVehicle(db, id);
  if (!row) throw httpError(404, 'Vehicle not found');
  const fields = readVehicle(body, true);
  if (typeof fields === 'string') throw bad(fields);
  if (!Object.keys(fields).length) throw bad('No fields provided to update');
  if (fields.plate) {
    const owner = vehicleByPlate(db, fields.plate);
    if (owner && owner.id !== id) throw httpError(409, `The plate ${owner.plate} is saved for ${owner.customer_name}`);
    fields.plate_norm = normalizePlate(fields.plate);
  }
  const before = formatVehicle(row);
  Object.assign(row, fields, { updated_at: nowIso() });
  const saved = formatVehicle(row);
  logActivity(db, user, { action: 'customer.vehicle_update', entity: 'customer', old_values: before, new_values: saved });
  return { success: true, message: 'Vehicle updated', data: saved };
});

route('GET', '/api/v1/customers/:id/history', ({ db, params }) => {
  const id = validId(params.id);
  const row = id && findCustomer(db, id);
  if (!row) throw httpError(404, 'Customer not found');
  const customer = formatCustomer(db, row);
  const jobCards = (db.job_cards || []).filter((j) => j.customer_id === id).sort((a, b) => b.id - a.id).slice(0, 100).map((j) => formatJob(db, j));
  const orders = pastOrders(db, customer);
  const paid = orders.filter((o) => o.paid);
  return {
    success: true,
    message: 'Customer history',
    data: {
      customer,
      job_cards: jobCards,
      orders,
      stats: {
        visits: orders.length,
        spent: Math.round(paid.reduce((s, o) => s + o.total, 0) * 100) / 100,
        last_visit: orders[0]?.created_at || null,
      },
    },
  };
});

route('GET', '/api/v1/customers/:id', ({ db, params }) => {
  const id = validId(params.id);
  const row = id && findCustomer(db, id);
  if (!row) throw httpError(404, 'Customer not found');
  return { success: true, message: 'Customer', data: formatCustomer(db, row) };
});

// ── job card routes (specific paths before /job-cards/:id) ─
route('GET', '/api/v1/job-cards', ({ db, query }) => {
  const status = query.status || '';
  if (status && status !== 'active' && !STATUSES.includes(status)) throw bad('Unknown status');
  const search = String(query.search || '').trim().slice(0, 50);
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, Number.parseInt(query.limit, 10) || 50));

  let list = db.job_cards || [];
  if (status === 'active') list = list.filter((j) => OPEN_STATUSES.includes(j.status));
  else if (status) list = list.filter((j) => j.status === status);
  if (search) {
    const s = search.toLowerCase();
    const digits = search.replace(/\D/g, '');
    const plate = normalizePlate(search);
    list = list.filter((j) => {
      const c = (db.customers || []).find((x) => x.id === j.customer_id) || {};
      const v = (db.customer_vehicles || []).find((x) => x.id === j.vehicle_id) || {};
      return String(j.job_number || '').toLowerCase().includes(s)
        || String(c.name || '').toLowerCase().includes(s)
        || (digits && String(c.phone || '').includes(digits))
        || (plate && String(v.plate_norm || '').includes(plate));
    });
  }
  list = [...list].sort((a, b) => b.id - a.id);
  const counts = Object.fromEntries(STATUSES.map((st) => [st, (db.job_cards || []).filter((j) => j.status === st).length]));
  return {
    success: true,
    message: 'Job cards',
    data: list.slice((page - 1) * limit, page * limit).map((j) => formatJob(db, j)),
    total: list.length,
    counts,
    page,
    limit,
  };
});

route('GET', '/api/v1/job-cards/technicians', ({ db }) => {
  // names used before, most recent first
  const last = new Map();
  (db.job_cards || []).forEach((j) => {
    if (j.technician) last.set(j.technician, Math.max(last.get(j.technician) || 0, j.id));
  });
  const data = [...last.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name]) => name);
  return { success: true, message: 'Technicians', data };
});

route('POST', '/api/v1/job-cards/add', ({ db, body, user }) => {
  const customerId = validId(body?.customer_id);
  const vehicleId = validId(body?.vehicle_id);
  if (!customerId || !vehicleId) throw bad('customer_id and vehicle_id are required');
  const fields = readJob(body);
  if (typeof fields === 'string') throw bad(fields);
  const vehicle = findVehicle(db, vehicleId);
  if (!vehicle) throw httpError(404, 'Vehicle not found');
  if (vehicle.customer_id !== customerId) throw bad('This vehicle belongs to another customer');

  // one open job card per vehicle (no double entry)
  const open = (db.job_cards || []).filter((j) => j.vehicle_id === vehicleId && OPEN_STATUSES.includes(j.status)).sort((a, b) => b.id - a.id)[0];
  if (open) {
    throw httpError(409, `This vehicle already has an open job card ${open.job_number} (${open.status.replace('_', ' ')}). Update that one instead.`, { job_card_id: open.id });
  }
  const id = nextId('job_cards');
  const now = nowIso();
  const by = actor(user);
  const services = fields.services || [];
  db.job_cards.push({
    id, job_number: `JC-${1000 + id}`, customer_id: customerId, vehicle_id: vehicleId,
    mileage: fields.mileage ?? null, fuel_level: fields.fuel_level ?? null, damage_notes: fields.damage_notes ?? null,
    complaints: fields.complaints ?? null, services, total: totalOf(services), technician: fields.technician ?? null,
    status: 'open', promised_at: fields.promised_at ?? null, notes: fields.notes ?? null, booking_id: null,
    qc_checklist: [], qc_by: null, qc_at: null, invoiced_at: null,
    created_by: by, updated_by: by, created_at: now, updated_at: now,
  });
  addEvent(db, id, null, 'open', 'Job card created', by, now);
  const job = getJob(db, id);
  logActivity(db, user, {
    action: 'job_card.add', entity: 'job_card',
    new_values: { id: job.id, job_number: job.job_number, plate: job.vehicle.plate, customer: job.customer.name, total: job.total },
  });
  return { status: 201, data: { success: true, message: `Job card ${job.job_number} created`, data: job } };
});

route('PUT', '/api/v1/job-cards/update/:id', ({ db, params, body, user }) => {
  const id = validId(params.id);
  if (!id) throw httpError(404, 'Job card not found');
  if (body?.status !== undefined) throw bad('Change the status with POST /job-cards/status/:id');
  const fields = readJob(body, true);
  if (typeof fields === 'string') throw bad(fields);
  if (!Object.keys(fields).length) throw bad('No fields provided to update');
  const row = (db.job_cards || []).find((j) => j.id === id);
  if (!row) throw httpError(404, 'Job card not found');
  if (!OPEN_STATUSES.includes(row.status)) throw httpError(409, `A ${row.status} job card can't be changed`);

  const before = getJob(db, id);
  Object.assign(row, fields);
  if (fields.services) row.total = totalOf(fields.services);
  row.updated_by = actor(user);
  row.updated_at = nowIso();
  const job = getJob(db, id);
  const changed = Object.keys(fields).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(job[k]));
  if (changed.length) {
    logActivity(db, user, {
      action: 'job_card.update', entity: 'job_card',
      old_values: Object.fromEntries(changed.map((k) => [k, before[k]])),
      new_values: { id, job_number: job.job_number, ...Object.fromEntries(changed.map((k) => [k, job[k]])) },
    });
  }
  return { success: true, message: 'Job card updated', data: job };
});

route('POST', '/api/v1/job-cards/status/:id', ({ db, params, body, user }) => {
  const id = validId(params.id);
  if (!id) throw httpError(404, 'Job card not found');
  const status = body?.status;
  if (status === 'delivered') throw bad('Close a Ready job card with POST /job-cards/invoice/:id (it makes the order and receipt)');
  if (!STATUSES.includes(status) || status === 'open') throw bad('status must be in_progress, quality_check, ready or cancelled');
  const qc = body?.qc;
  if (qc !== undefined && (!Array.isArray(qc) || qc.length > 30 || qc.some((k) => typeof k !== 'string'))) {
    throw bad('qc must be a list of ticked checklist keys');
  }
  const note = jobText(body?.note, 'note', 255);
  if (note.error) throw bad(note.error);
  let technician;
  if (body?.technician !== undefined) {
    const t = jobText(body.technician, 'technician', 100);
    if (t.error) throw bad(t.error);
    technician = t.value;
  }
  const row = (db.job_cards || []).find((j) => j.id === id);
  if (!row) throw httpError(404, 'Job card not found');
  const goingBack = status === 'in_progress' && ['quality_check', 'ready'].includes(row.status);
  if ((status === 'cancelled' || goingBack) && !note.value) {
    throw bad(status === 'cancelled' ? 'Please give the reason for cancelling' : 'Please write what needs fixing');
  }

  const from = row.status;
  if (!NEXT[from].includes(status)) {
    throw httpError(409, `A job card that is ${from.replace('_', ' ')} can't go to ${status.replace('_', ' ')}`, { allowed: NEXT[from] });
  }
  // passing QC: every checklist item ticked, saved with who checked it
  if (from === 'quality_check' && status === 'ready') {
    const ticked = new Set(Array.isArray(qc) ? qc : []);
    const missing = QC_ITEMS.filter(([key]) => !ticked.has(key));
    if (missing.length) {
      throw httpError(400, `Tick every quality check item first. Not ticked: ${missing.map(([, label]) => label).join('; ')}`, { missing: missing.map(([key]) => key) });
    }
  }
  const by = actor(user);
  const now = nowIso();
  row.status = status;
  row.updated_by = by;
  row.updated_at = now;
  if (technician !== undefined) row.technician = technician;
  if (from === 'quality_check' && status === 'ready') {
    row.qc_checklist = QC_PASSED();
    row.qc_by = by;
    row.qc_at = now;
  }
  addEvent(db, id, from, status, note.value, by, now);
  const job = getJob(db, id);
  logActivity(db, user, {
    action: 'job_card.status', entity: 'job_card',
    old_values: { status: from },
    new_values: { id, job_number: job.job_number, status, note: note.value, ...(technician !== undefined ? { technician } : {}) },
  });
  return { success: true, message: `${job.job_number}: ${status.replace('_', ' ')}`, data: job };
});

route('POST', '/api/v1/job-cards/invoice/:id', ({ db, params, body, user }) => {
  const id = validId(params.id);
  if (!id) throw httpError(404, 'Job card not found');
  const b = body || {};
  if (!PAYMENT_METHODS.includes(b.payment_method)) throw bad(`payment_method must be ${PAYMENT_METHODS.join(' or ')}`);
  const paymentType = b.payment_type ? String(b.payment_type) : null;
  if (paymentType && !PAYMENT_TYPES.includes(paymentType)) throw bad(`payment_type must be one of: ${PAYMENT_TYPES.join(', ')}`);
  if (!['paid', 'unpaid'].includes(b.payment_status)) throw bad('payment_status must be paid or unpaid');

  const row = (db.job_cards || []).find((j) => j.id === id);
  if (!row) throw httpError(404, 'Job card not found');
  if (row.booking_id) throw httpError(409, 'This job card already has an invoice', { booking_id: row.booking_id });
  if (row.status !== 'ready') throw httpError(409, `Only a Ready job card can be invoiced. This one is ${row.status.replace('_', ' ')}.`);

  // the job card becomes a normal car wash order, then it is Delivered
  const pay = { payment_method: b.payment_method, payment_type: paymentType, payment_status: b.payment_status };
  const when = new Date();
  const booking = insertJobOrder(db, formatJob(db, row), pay, when);
  const by = actor(user);
  row.booking_id = booking.id;
  row.status = 'delivered';
  row.invoiced_at = when.toISOString();
  row.updated_by = by;
  row.updated_at = when.toISOString();
  addEvent(db, id, 'ready', 'delivered', invoiceNote(booking.booking_number, pay), by, when.toISOString());
  const job = getJob(db, id);
  logActivity(db, user, {
    action: 'job_card.invoice', entity: 'job_card', booking_id: String(booking.id),
    new_values: { id, job_number: job.job_number, booking_number: job.order?.booking_number, total: job.total, ...pay },
  });
  return { success: true, message: `${job.job_number} invoiced as order #${job.order?.booking_number} and delivered`, data: job };
});

route('POST', '/api/v1/job-cards/:id/photos', ({ db, params, body, files, user }) => {
  const list = files.photos || [];
  // what the upload middleware checks first
  if (list.length > MAX_PHOTOS_PER_UPLOAD) throw bad('Too many files');
  if (list.some((f) => !PHOTO_TYPES.includes(f.type))) throw bad('Unsupported file type. Allowed: JPG, PNG, WEBP.');
  if (list.some((f) => f.size > 10 * 1024 * 1024)) throw bad('File too large');

  const id = validId(params.id);
  const job = id && (db.job_cards || []).find((j) => j.id === id);
  if (!job) throw httpError(404, 'Job card not found');
  if (!list.length) throw bad('Choose at least one photo');
  const caption = jobText(body?.caption, 'caption', 150);
  if (caption.error) throw bad(caption.error);
  const have = photosOf(db, id).length;
  if (have + list.length > MAX_PHOTOS_PER_JOB) throw bad(`A job card can have at most ${MAX_PHOTOS_PER_JOB} photos (it has ${have})`);

  const now = nowIso();
  list.forEach((file) => {
    const photoId = nextId('job_card_photos');
    photoFiles.set(photoId, file);
    db.job_card_photos.push({ id: photoId, job_card_id: id, file_name: 'upload', file_type: file.type, caption: caption.value, created_by: actor(user), created_at: now });
  });
  logActivity(db, user, { action: 'job_card.photos', entity: 'job_card', new_values: { id, job_number: job.job_number, added: list.length, caption: caption.value } });
  return { status: 201, data: { success: true, message: `${list.length} photo${list.length === 1 ? '' : 's'} added`, data: photosOf(db, id).map(formatPhoto) } };
});

route('GET', '/api/v1/job-cards/photo/:photoId', ({ db, params }) => {
  const id = validId(params.photoId);
  const photo = id && (db.job_card_photos || []).find((p) => p.id === id);
  if (!photo) throw httpError(404, 'Photo not found');
  if (photo.sample) return { status: 200, data: sampleCarSvg(photo.caption, photo.color) };
  const file = photoFiles.get(id);
  if (!file) throw httpError(404, 'The photo file is missing on the server');
  return { status: 200, data: file };
});

route('PUT', '/api/v1/job-cards/photo/delete/:photoId', ({ db, params, user }) => {
  const id = validId(params.photoId);
  const photo = id && (db.job_card_photos || []).find((p) => p.id === id);
  if (!photo) throw httpError(404, 'Photo not found');
  const job = (db.job_cards || []).find((j) => j.id === photo.job_card_id);
  // only while the job card is open: after delivery the photos are the record
  if (!job || !OPEN_STATUSES.includes(job.status)) throw httpError(409, `Photos of a ${job?.status} job card can't be removed`);
  db.job_card_photos = db.job_card_photos.filter((p) => p.id !== id);
  photoFiles.delete(id);
  logActivity(db, user, {
    action: 'job_card.photo_delete', entity: 'job_card',
    old_values: { photo_id: id, caption: photo.caption },
    new_values: { id: photo.job_card_id, job_number: job.job_number },
  });
  return { success: true, message: 'Photo removed' };
});

route('GET', '/api/v1/job-cards/:id', ({ db, params }) => {
  const id = validId(params.id);
  const job = id && getJob(db, id);
  if (!job) throw httpError(404, 'Job card not found');
  return { success: true, message: 'Job card', data: job };
});