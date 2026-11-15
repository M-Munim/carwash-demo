// Demo backend that runs in the browser. Every API call the dashboard makes
// goes to `demoAdapter` (set on the axios instance in utils/axiosInstance.js)
// instead of the network. Data lives in one object, seeded with sample data
// and saved to localStorage, so changes survive a page reload in the same
// browser. "Reset demo data" (Sidebar) puts the sample data back.
//
// A domain module registers its routes with route(...) and its sample data
// with seeder(...). See utils/demo/index.js for the list of modules.

import { AxiosError } from 'axios';

const STORAGE_KEY = 'washdesk-demo-db-v1';

// ── routes ──────────────────────────────────────────────────
const routes = [];

/**
 * route('GET', '/api/v1/job-cards/:id', (req) => ...)
 * req = { params, query, body, files, db, user, method, path }
 *  - body: JSON body, or the FormData fields as a plain object (strings)
 *  - files: { fieldName: [File, ...] } from a FormData body
 *  - user: the logged-in demo user, or null
 * Return { status, data } (status defaults to 200), or just the data object.
 * Throw httpError(status, body) for an error response.
 */
export function route(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp(
    '^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\?:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$',
  );
  routes.push({ method: method.toUpperCase(), rx, keys, handler });
}

export class HttpError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}
export const httpError = (status, message, extra = {}) => new HttpError(status, { success: false, message, ...extra });

// ── data ────────────────────────────────────────────────────
const seeders = [];
/** seeder(order, (db, h) => { db.things = [...] }) — lower order runs first. */
export function seeder(order, fn) {
  seeders.push({ order, fn });
}

let db = null;

function seed() {
  const fresh = { _ids: {} };
  db = fresh; // seeders call nextId(), which reads the data being built
  [...seeders].sort((a, b) => a.order - b.order).forEach((s) => s.fn(fresh, helpers));
  return fresh;
}

export function getDb() {
  if (db) return db;
  if (typeof window !== 'undefined') {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) db = JSON.parse(saved);
    } catch {
      db = null;
    }
  }
  if (!db) {
    db = seed();
    save();
  }
  return db;
}

export function save() {
  if (typeof window === 'undefined' || !db) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    /* storage full or blocked: the demo still works until the page reloads */
  }
}

/** Back to the sample data. */
export function resetDemoData() {
  db = seed();
  save();
}

/** Next id for a table (1, 2, 3 …), kept in db._ids. */
export function nextId(table) {
  const d = getDb();
  const list = d[table] || [];
  const current = d._ids[table] ?? list.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
  d._ids[table] = current + 1;
  return current + 1;
}

// ── helpers for seeders and handlers ───────────────────────
const pad = (n) => String(n).padStart(2, '0');

/** Local date "YYYY-MM-DD", `daysAgo` days before today. */
export function dateOnly(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "YYYY-MM-DD HH:MM:SS" (local time, like MySQL DATETIME) at `daysAgo` days ago, hour:minute. */
export function sqlDateTime(daysAgo = 0, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  if (hour !== undefined) d.setHours(hour, minute, 0, 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** ISO timestamp (UTC, with Z) at `daysAgo` days ago, local hour:minute. */
export function isoAt(daysAgo = 0, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  if (hour !== undefined) d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

export const nowSql = () => sqlDateTime(0);
export const nowIso = () => new Date().toISOString();

/** Deterministic pseudo-random numbers, so the sample data is the same every reset. */
export function rng(seedValue = 42) {
  let s = seedValue >>> 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
}

/** Pagination helper: { page, limit } → slice + meta. */
export function paginate(list, page = 1, limit = 50) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.max(1, Number(limit) || 50);
  return {
    results: list.slice((p - 1) * l, p * l),
    total: list.length,
    page: p,
    limit: l,
    total_pages: Math.max(1, Math.ceil(list.length / l)),
  };
}

export const helpers = { dateOnly, sqlDateTime, isoAt, nowSql, nowIso, rng, nextId: (d, table) => {
  const current = d._ids[table] ?? (d[table] || []).reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
  d._ids[table] = current + 1;
  return current + 1;
} };

// ── current user ────────────────────────────────────────────
function currentUser(headers) {
  const auth = headers?.Authorization || headers?.authorization || '';
  const token = String(auth).replace(/^Bearer\s+/i, '');
  if (!token.startsWith('demo-token-')) return null;
  const id = Number(token.slice('demo-token-'.length));
  return (getDb().users || []).find((u) => u.id === id) || null;
}

// ── the axios adapter ───────────────────────────────────────
function readBody(data) {
  const files = {};
  if (typeof FormData !== 'undefined' && data instanceof FormData) {
    const body = {};
    for (const [key, value] of data.entries()) {
      if (typeof value === 'string') {
        body[key] = value;
      } else {
        (files[key] = files[key] || []).push(value);
      }
    }
    return { body, files };
  }
  if (typeof data === 'string' && data) {
    try {
      return { body: JSON.parse(data), files };
    } catch {
      return { body: {}, files };
    }
  }
  return { body: data && typeof data === 'object' ? data : {}, files };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function demoAdapter(config) {
  const url = new URL(config.url || '', 'http://demo.local');
  const path = url.pathname;
  const method = (config.method || 'get').toUpperCase();
  const query = Object.fromEntries(url.searchParams.entries());
  Object.entries(config.params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null) query[k] = v;
  });
  const { body, files } = readBody(config.data);

  // A short wait so loading states look natural.
  await delay(120 + Math.random() * 180);

  const respond = (status, data) => {
    const response = { data, status, statusText: String(status), headers: {}, config, request: {} };
    if (status >= 200 && status < 300) return response;
    throw new AxiosError(data?.message || `Request failed with status code ${status}`, status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST', config, {}, response);
  };

  const match = routes.find((r) => r.method === method && r.rx.test(path));
  if (!match) {
    // Pages outside the demo (older admin screens): an empty, successful reply.
    if (method === 'GET') return respond(200, { success: true, data: [] });
    return respond(200, { success: true, message: 'Saved (demo).' });
  }

  const m = path.match(match.rx);
  const params = {};
  match.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

  const d = getDb();
  try {
    const out = await match.handler({ params, query, body, files, db: d, user: currentUser(config.headers), method, path });
    if (method !== 'GET') save();
    if (out && typeof out === 'object' && 'status' in out && 'data' in out && Object.keys(out).length === 2) {
      return respond(out.status, out.data);
    }
    return respond(200, out);
  } catch (err) {
    if (err instanceof AxiosError) throw err;
    if (err instanceof HttpError) return respond(err.status, err.body);
    console.error('[demo] handler error', method, path, err);
    return respond(500, { success: false, message: 'Demo error: ' + (err?.message || 'unknown') });
  }
}
