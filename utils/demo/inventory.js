// Demo: Inventory (stock items, stock movements, consumption, machinery) and
// Expenses (running costs with an optional bill file). Mirrors the inventory
// and expense controllers/services of the real backend: same response shapes,
// field names, computed fields and validation messages.

import { route, seeder, httpError, nextId, nowIso, dateOnly, isoAt, rng, paginate } from './core';

// ── shared helpers (same rules as the backend) ──────────────
const MAX_QTY = 1_000_000;
const MAX_PRICE = 1_000_000;
const MAX_AMOUNT = 10_000_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['supply', 'product'];
const TYPES = ['in', 'use', 'sell', 'adjust'];
export const EXPENSE_TYPES = ['utility', 'shop_rent', 'room_rent', 'salary', 'other'];

const round2 = (v) => Math.round(Number(v) * 100) / 100;
const num = (v) => (v === null || v === undefined ? null : Number(v));
const bad = (message) => httpError(400, message);
const actorName = (user) => user?.username || 'demo';
const pad = (n) => String(n).padStart(2, '0');

/** Local "YYYY-MM-DD" of a stored ISO timestamp (the backend compares local DATETIMEs). */
const localDay = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const inRange = (iso, from, to) => {
  const day = localDay(iso);
  return (!from || day >= from) && (!to || day <= to);
};

/** A number with at most 2 decimals in [min, max], or an error string. */
function readNumber(value, label, { min = 0, max = MAX_QTY, allowZero = true } = {}) {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return `${label} must be a number (up to 2 decimals)`;
  const n = Number(text);
  if (n < min || n > max || (!allowZero && n === 0)) {
    return allowZero ? `${label} must be from ${min} to ${max}` : `${label} must be more than 0`;
  }
  return n;
}

/** Digits with the country code: an 8-digit Qatar number gets 974. */
const toPhone = (raw) => {
  const digits = String(raw).replace(/\D/g, '').replace(/^00/, '');
  if (/^[3-7]\d{7}$/.test(digits)) return `974${digits}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
};

const optText = (value, label, max) => {
  const text = String(value ?? '').trim();
  if (text.length > max) return { error: `${label} must be ${max} characters or less` };
  return { value: text || null };
};

const validId = (raw) => {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 && String(id) === String(raw).trim() ? id : null;
};

/** A real calendar day as YYYY-MM-DD, or null. */
const validDate = (raw) => {
  const text = String(raw ?? '').trim();
  if (!DATE.test(text)) return null;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text ? text : null;
};

function readReason(body) {
  const reason = String(body?.reason ?? '').trim();
  if (!reason) throw bad('reason is required');
  if (reason.length > 255) throw bad('reason must be 255 characters or less');
  return reason;
}

// ── inventory: formatting ───────────────────────────────────
function formatItem(row) {
  if (!row) return null;
  const quantity = num(row.quantity);
  const minQuantity = num(row.min_quantity);
  const cost = num(row.cost_price);
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    kind: row.kind,
    category: row.category,
    unit: row.unit,
    quantity,
    min_quantity: minQuantity,
    cost_price: cost,
    sell_price: num(row.sell_price),
    supplier: row.supplier,
    supplier_phone: row.supplier_phone,
    notes: row.notes,
    low_stock: quantity <= minQuantity,
    stock_value: cost === null ? null : round2(quantity * cost),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** A movement joined with its item (name, unit, kind, deleted flag). */
function formatMovement(d, row) {
  const item = d.inventory_items.find((i) => i.id === row.item_id) || {};
  return {
    id: row.id,
    item_id: row.item_id,
    item_name: item.name,
    item_unit: item.unit,
    item_kind: item.kind,
    item_deleted: item.is_deleted === 1,
    type: row.type,
    change: num(row.change),
    balance: num(row.balance),
    unit_price: num(row.unit_price),
    note: row.note,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

function formatMachine(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    purchase_date: row.purchase_date,
    amount: num(row.amount),
    supplier: row.supplier,
    notes: row.notes,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const liveItems = (d) => d.inventory_items.filter((i) => !i.is_deleted);
const findItem = (d, id) => liveItems(d).find((i) => i.id === id) || null;
const liveMachines = (d) => d.inventory_machinery.filter((m) => !m.is_deleted);
const sortByName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const byNewest = (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id);

// ── inventory: body readers (same checks as the controller) ─
/** Item fields from a body. `partial` = only what was sent (edits). Returns an object or an error string. */
function readItem(body = {}, partial = false) {
  const out = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has('name')) {
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) return 'name is required';
    if (name.length > 150) return 'name must be 150 characters or less';
    out.name = name;
  }
  if (!partial || has('kind')) {
    const kind = body.kind ?? 'supply';
    if (!KINDS.includes(kind)) return 'kind must be supply or product';
    out.kind = kind;
  }
  if (!partial || has('unit')) {
    const unit = String(body.unit ?? '').trim() || 'piece';
    if (unit.length > 30) return 'unit must be 30 characters or less';
    out.unit = unit;
  }
  if (!partial || has('code')) {
    const code = String(body.code ?? '').trim().toUpperCase();
    if (code && !/^[A-Z0-9][A-Z0-9._\-/]{0,39}$/.test(code)) {
      return 'code may only have letters, numbers and . _ - / (up to 40, no spaces)';
    }
    out.code = code || null;
  }
  if (!partial || has('supplier_phone')) {
    const raw = String(body.supplier_phone ?? '').trim();
    const phone = raw ? toPhone(raw) : null;
    if (raw && !phone) return 'supplier_phone is not a valid phone number';
    out.supplier_phone = phone;
  }
  for (const [key, label, max] of [['category', 'category', 60], ['supplier', 'supplier', 150], ['notes', 'notes', 255]]) {
    if (partial && !has(key)) continue;
    const t = optText(body[key], label, max);
    if (t.error) return t.error;
    out[key] = t.value;
  }
  if (!partial || has('min_quantity')) {
    const raw = body.min_quantity;
    const n = raw === undefined || raw === null || raw === '' ? 0 : readNumber(raw, 'min_quantity');
    if (typeof n === 'string') return n;
    out.min_quantity = n;
  }
  for (const key of ['cost_price', 'sell_price']) {
    if (partial && !has(key)) continue;
    const raw = body[key];
    if (raw === undefined || raw === null || raw === '') {
      out[key] = null;
      continue;
    }
    const n = readNumber(raw, key, { max: MAX_PRICE });
    if (typeof n === 'string') return n;
    out[key] = n;
  }
  return out;
}

function readMachine(body = {}, partial = false) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('name')) {
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) return 'name is required';
    if (name.length > 150) return 'name must be 150 characters or less';
    out.name = name;
  }
  if (!partial || has('purchase_date')) {
    const date = validDate(body.purchase_date);
    if (!date) return 'purchase_date must be a date like 2026-11-12';
    out.purchase_date = date;
  }
  if (!partial || has('amount')) {
    const n = readNumber(body.amount, 'amount', { max: MAX_PRICE * 10 });
    if (typeof n === 'string') return n;
    out.amount = n;
  }
  for (const [key, max] of [['supplier', 150], ['notes', 255]]) {
    if (partial && !has(key)) continue;
    const t = optText(body[key], key, max);
    if (t.error) return t.error;
    out[key] = t.value;
  }
  return out;
}

const nameTaken = (d, name, exceptId = 0) =>
  liveItems(d).some((i) => i.id !== exceptId && i.name.toLowerCase() === String(name).toLowerCase());
const codeTaken = (d, code, exceptId = 0) => Boolean(code) && liveItems(d).some((i) => i.id !== exceptId && i.code === code);

// ── inventory: stock changes ────────────────────────────────
/**
 * One stock change (same rules as inventoryService.move):
 *   in +quantity (a unit_price becomes the cost price), use / sell -quantity,
 *   adjust sets the stock to `counted`. Returns { item, movement } rows.
 */
function move(d, item, { type, quantity, counted, unitPrice = null, note = null }, actor, createdAt = nowIso()) {
  const before = Number(item.quantity);
  let change;
  let price = unitPrice;
  if (type === 'in') {
    change = quantity;
  } else if (type === 'use' || type === 'sell') {
    if (quantity > before) {
      throw httpError(409, `Only ${before} ${item.unit} of "${item.name}" in stock. Record the stock that came in first, or fix the count.`);
    }
    change = -quantity;
    if (type === 'sell' && price === null) price = num(item.sell_price);
    if (type === 'use') price = null;
  } else {
    change = round2(counted - before);
    if (change === 0) throw httpError(409, `The stock is already ${before} ${item.unit}`);
    price = null;
  }
  const balance = round2(before + change);
  item.quantity = balance;
  item.updated_by = actor;
  item.updated_at = createdAt;
  if (type === 'in' && price !== null) item.cost_price = price;
  const movement = {
    id: nextId('inventory_movements'),
    item_id: item.id,
    type,
    change: round2(change),
    balance,
    unit_price: price,
    note,
    created_by: actor,
    created_at: createdAt,
  };
  d.inventory_movements.push(movement);
  return { item, movement };
}

/** Bought / used / sold totals for a period (inventoryService.getSummary). */
function inventorySummary(d, from, to) {
  let bought = 0;
  let used = 0;
  let sold = 0;
  let soldCost = 0;
  let salesCount = 0;
  for (const m of d.inventory_movements) {
    if (!inRange(m.created_at, from, to)) continue;
    const item = d.inventory_items.find((i) => i.id === m.item_id);
    const cost = Number(item?.cost_price || 0);
    if (m.type === 'in') bought += m.change * Number(m.unit_price || 0);
    if (m.type === 'use') used += -m.change * cost;
    if (m.type === 'sell') {
      sold += -m.change * Number(m.unit_price || 0);
      soldCost += -m.change * cost;
      salesCount += 1;
    }
  }
  const items = liveItems(d).map(formatItem);
  const soldValue = round2(sold);
  const soldCostValue = round2(soldCost);
  return {
    from,
    to,
    bought_value: round2(bought),
    used_value: round2(used),
    sold_value: soldValue,
    sold_cost: soldCostValue,
    sales_profit: round2(soldValue - soldCostValue),
    sales_count: salesCount,
    item_count: items.length,
    low_stock_count: items.filter((i) => i.low_stock).length,
    stock_value: round2(items.reduce((s, i) => s + (i.stock_value || 0), 0)),
  };
}

// ── inventory: sample data ──────────────────────────────────
// Clearly fictional suppliers and phone numbers.
const SUPPLIERS = {
  pearl: ['Pearl Coast Car Care Supplies', '97444001201'],
  gloss: ['Desert Gloss Trading', '97444001202'],
  lusail: ['Lusail Auto Accessories', '97444001203'],
  tint: ['Corniche Tint & Film', '97444001204'],
  bayline: ['Bayline Cleaning Chemicals', '97444001205'],
};

// [name, code, kind, category, unit, alert at, cost, sell price, supplier, avg per day, step, restock qty, flag]
// flag: 'low' = ends below the alert level, 'out' = ends at 0.
const SAMPLE_ITEMS = [
  ['Car Shampoo (5 gal drum)', 'CW-001', 'supply', 'Car Wash', 'gallon', 4, 95, null, 'bayline', 0.9, 0.5, 20],
  ['Snow Foam Concentrate', 'CW-002', 'supply', 'Car Wash', 'gallon', 3, 120, null, 'bayline', 0.6, 0.5, 15],
  ['Tyre Shine Gel', 'CW-003', 'supply', 'Car Wash', 'bottle', 6, 38, null, 'pearl', 1.2, 1, 30, 'low'],
  ['Glass Cleaner', 'CW-004', 'supply', 'Car Wash', 'bottle', 6, 18, null, 'pearl', 1, 1, 30],
  ['Microfiber Towels (pack of 10)', 'CW-005', 'supply', 'Car Wash', 'pack', 5, 45, null, 'pearl', 0.35, 1, 15],
  ['Wash Mitts', 'CW-006', 'supply', 'Car Wash', 'piece', 6, 15, null, 'pearl', 0.2, 1, 12],
  ['Interior Cleaner (APC)', 'CW-007', 'supply', 'Car Wash', 'gallon', 3, 70, null, 'bayline', 0.5, 0.5, 12, 'out'],
  ['Wheel & Rim Cleaner', 'CW-008', 'supply', 'Car Wash', 'gallon', 2, 85, null, 'bayline', 0.3, 0.5, 10],
  ['Car Air Freshener', 'CW-009', 'product', 'Car Wash', 'piece', 30, 3.5, 10, 'lusail', 2.5, 1, 150],
  ['Spray Wax (500 ml)', 'CW-010', 'product', 'Car Wash', 'bottle', 8, 22, 45, 'pearl', 0.6, 1, 30],
  ['Cutting Compound (1 L)', 'PL-001', 'supply', 'Polishing', 'bottle', 2, 110, null, 'gloss', 0.12, 1, 6],
  ['Finishing Polish (1 L)', 'PL-002', 'supply', 'Polishing', 'bottle', 2, 95, null, 'gloss', 0.12, 1, 6],
  ['Foam Polishing Pads', 'PL-003', 'supply', 'Polishing', 'pack', 3, 60, null, 'gloss', 0.1, 1, 6, 'low'],
  ['Clay Bar Kit', 'PL-004', 'supply', 'Polishing', 'piece', 3, 35, null, 'gloss', 0.1, 1, 8],
  ['Leather Conditioner', 'DT-001', 'supply', 'Detailing', 'bottle', 3, 48, null, 'gloss', 0.15, 1, 8],
  ['Nano Ceramic Coating Kit', 'DT-002', 'supply', 'Detailing', 'box', 2, 380, null, 'gloss', 0.07, 1, 5],
  ['Graphene Coating Kit', 'DT-003', 'supply', 'Detailing', 'box', 2, 520, null, 'gloss', 0.05, 1, 4, 'low'],
  ['Engine Bay Degreaser', 'DT-004', 'supply', 'Detailing', 'can', 4, 28, null, 'bayline', 0.2, 1, 12],
  ['Odour Removal Fogger', 'DT-005', 'supply', 'Detailing', 'can', 4, 25, null, null, 0.1, 1, 10],
  ['Nano Ceramic Tint Film', 'WT-001', 'supply', 'Window Tints', 'roll', 2, 650, null, 'tint', 0.05, 1, 4],
  ['Carbon Tint Film', 'WT-002', 'supply', 'Window Tints', 'roll', 2, 320, null, 'tint', 0.06, 1, 5],
  ['Tint Slip Solution', 'WT-003', 'supply', 'Window Tints', 'bottle', 3, 20, null, 'tint', 0.12, 1, 10],
  ['Dashboard Cover - Sedan', 'DB-001', 'product', 'Dashboards', 'piece', 4, 55, 120, 'lusail', 0.15, 1, 10],
  ['Dashboard Cover - SUV', 'DB-002', 'product', 'Dashboards', 'piece', 4, 65, 140, 'lusail', 0.12, 1, 10],
  ['Dashboard Protectant', 'DB-003', 'supply', 'Dashboards', 'bottle', 4, 24, null, 'pearl', 0.3, 1, 15],
  ['Leather Seat Cover Set', 'SC-001', 'product', 'Seat Cover', 'set', 2, 450, 850, 'lusail', 0.05, 1, 5],
  ['Fabric Seat Cover Set', 'SC-002', 'product', 'Seat Cover', 'set', 4, 180, 350, 'lusail', 0.1, 1, 8, 'low'],
  ['Steering Wheel Cover', 'SC-003', 'product', 'Seat Cover', 'piece', 6, 18, 45, 'lusail', 0.2, 1, 20],
  ['Roof Rack Crossbars', 'RM-001', 'product', 'Roof Modification', 'pair', 2, 280, 550, 'lusail', 0.03, 1, 4],
  ['Roof Star Light Kit', 'RM-002', 'product', 'Roof Modification', 'box', 2, 210, 450, 'lusail', 0.03, 1, 4],
  ['Headliner Fabric', 'RM-003', 'supply', 'Roof Modification', 'roll', 1, 140, null, null, 0.03, 1, 3],
  ['3D Floor Mats - Sedan', 'FM-001', 'product', 'Floor Modification', 'set', 4, 120, 260, 'lusail', 0.12, 1, 10],
  ['Rubber Floor Mats', 'FM-002', 'product', 'Floor Modification', 'set', 6, 45, 95, 'lusail', 0.25, 1, 15, 'out'],
  ['Floor Carpet Roll', 'FM-003', 'supply', 'Floor Modification', 'roll', 1, 210, null, null, 0.02, 1, 2],
];

// Physical counts that found a difference: [days ago, item code, change, note]
const SAMPLE_COUNTS = [
  [31, 'CW-004', -1, 'Monthly count: 1 bottle leaked in the store'],
  [31, 'CW-005', -1, 'Monthly count: 1 pack missing'],
  [9, 'CW-009', -3, 'Count fix: 3 damaged by the heat'],
  [9, 'CW-006', 1, 'Count fix: 1 found in the detailing bay'],
];

const SALE_NOTES = [null, null, null, 'Sold with a wash', 'Walk-in customer', 'Added to the order'];
const DAYS = 60;

seeder(30, (d, h) => {
  d.inventory_items = [];
  d.inventory_movements = [];
  d.inventory_machinery = [];
  const r = rng(30);
  const movements = [];
  const now = new Date();
  const ts = (ago, hour, minute) => isoAt(ago, hour, minute);

  // Items start with their opening stock DAYS + 1 days ago.
  const sims = SAMPLE_ITEMS.map((row, i) => {
    const [name, code, kind, category, unit, min, cost, sell, sup, rate, step, restock, flag] = row;
    const created = ts(DAYS + 1, 8, i);
    const item = {
      id: i + 1,
      name, code, kind, category, unit,
      quantity: restock,
      min_quantity: min,
      cost_price: cost,
      sell_price: sell,
      supplier: sup ? SUPPLIERS[sup][0] : null,
      supplier_phone: sup ? SUPPLIERS[sup][1] : null,
      notes: null,
      created_by: 'owner',
      updated_by: 'owner',
      is_deleted: 0,
      created_at: created,
      updated_at: created,
    };
    movements.push({ item_id: item.id, type: 'in', change: restock, balance: restock, unit_price: null, note: 'Opening stock', created_by: 'owner', created_at: created });
    return { item, rate, step, restock, flag };
  });
  sims.find((s) => s.item.code === 'CW-001').item.notes = 'Dilute 1:400 for the foam lance';
  sims.find((s) => s.item.code === 'DT-003').item.notes = 'Order 2 weeks ahead';

  const push = (s, type, change, createdAt, extra = {}) => {
    s.item.quantity = round2(s.item.quantity + change);
    movements.push({
      item_id: s.item.id, type, change: round2(change), balance: s.item.quantity,
      unit_price: null, note: null, created_by: r.chance(0.7) ? 'staff' : 'owner', created_at: createdAt, ...extra,
    });
  };

  for (let ago = DAYS; ago >= 0; ago--) {
    if (ago === 0 && now.getHours() < 9) break; // nothing recorded yet today
    const weekday = new Date(`${dateOnly(ago)}T12:00:00`).getDay();
    const factor = weekday === 5 || weekday === 6 ? 1.5 : 1; // Friday / Saturday busier
    const frozen = (s) => s.flag && ago <= 12; // low / out items: no delivery lately

    for (const s of sims) {
      const { item } = s;
      // Morning delivery when the shelf runs low
      if (!frozen(s) && item.quantity <= item.min_quantity * 1.5) {
        push(s, 'in', s.restock, ts(ago, 9, ago === 0 ? 0 : r.int(0, 50)), { unit_price: item.cost_price, note: r.pick([null, 'Delivery', 'Invoice on file']), created_by: 'owner' });
      }
      // How much went out today
      const expected = (s.rate * factor) / s.step;
      const events = Math.floor(expected) + (r.chance(expected % 1) ? 1 : 0);
      if (!events) continue;
      if (item.kind === 'product') {
        // Sales through the day, in time order (minutes of the day, 10:00 to 20:59)
        const times = Array.from({ length: events }, () => r.int(600, 1259)).sort((a, b) => a - b);
        for (const t of times) {
          if (item.quantity < 1) break;
          const hour = Math.floor(t / 60);
          if (ago === 0 && hour >= now.getHours()) break; // not in the future
          const q = item.quantity >= 2 && r.chance(0.1) ? 2 : 1;
          push(s, 'sell', -q, ts(ago, hour, t % 60), { unit_price: item.sell_price, note: r.pick(SALE_NOTES) });
        }
      } else if (ago > 0) {
        // Supplies: one "used" entry at the end of each day
        const q = Math.min(round2(events * s.step), item.quantity);
        if (q > 0) push(s, 'use', -q, ts(ago, 20, r.int(30, 55)), { note: s.rate < 0.2 ? r.pick([null, 'Detailing job', 'Polishing job']) : null });
      }
    }

    // Count fixes
    SAMPLE_COUNTS.filter(([a]) => a === ago).forEach(([, code, diff, note]) => {
      const s = sims.find((x) => x.item.code === code);
      if (s.item.quantity + diff >= 0) push(s, 'adjust', diff, ts(ago, 21, 10), { note, created_by: 'owner' });
    });

    // Yesterday evening: make sure the low / out items really end low / out
    if (ago === 1) {
      for (const s of sims) {
        const { item } = s;
        const outType = item.kind === 'product' ? 'sell' : 'use';
        const extra = () => ({ unit_price: outType === 'sell' ? item.sell_price : null });
        if (s.flag === 'out' && item.quantity > 0) {
          push(s, outType, -item.quantity, ts(1, 21, 30), extra());
        } else if (s.flag === 'low') {
          const target = Math.max(1, Math.round(item.min_quantity * 0.5));
          if (item.quantity > target) push(s, outType, -(item.quantity - target), ts(1, 21, 30), extra());
          else if (item.quantity < 1) push(s, 'in', target, ts(1, 21, 35), { unit_price: item.cost_price, note: 'Small top-up', created_by: 'owner' });
        } else if (!s.flag && item.quantity <= item.min_quantity) {
          push(s, 'in', s.restock, ts(1, 21, 40), { unit_price: item.cost_price, note: 'Evening delivery', created_by: 'owner' });
        }
      }
    }
  }

  // Chronological ids, like rows inserted over time
  movements.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  movements.forEach((m) => { m.id = h.nextId(d, 'inventory_movements'); d.inventory_movements.push(m); });
  sims.forEach((s) => { d.inventory_items.push(s.item); });
  d._ids.inventory_items = d.inventory_items.length;
  // The items' updated_at: their last movement
  d.inventory_movements.forEach((m) => { d.inventory_items[m.item_id - 1].updated_at = m.created_at; });

  // Machinery bought over the last two years
  const machines = [
    ['High-pressure washer 200 bar (x2)', 640, 14800, 'Bayline Cleaning Chemicals', 'Both bays. Service every 6 months'],
    ['Foam cannon unit 50 L', 420, 3200, 'Pearl Coast Car Care Supplies', null],
    ['Wet & dry vacuum 80 L (x3)', 410, 5400, 'Pearl Coast Car Care Supplies', null],
    ['Dual-action polisher (x2)', 230, 2600, 'Desert Gloss Trading', 'Spare backing plates in the store'],
    ['Air compressor 300 L', 380, 4300, null, 'Used for tyres and drying'],
    ['Water softener / RO system', 300, 9600, 'Bayline Cleaning Chemicals', 'Filter change every 3 months'],
    ['Steam cleaner for interiors', 95, 3900, 'Desert Gloss Trading', null],
    ['Tint film cutting plotter', 35, 7200, 'Corniche Tint & Film', 'Warranty 1 year'],
  ];
  machines.forEach(([name, ago, amount, supplier, notes]) => {
    const created = ts(ago, 12, 0);
    d.inventory_machinery.push({
      id: h.nextId(d, 'inventory_machinery'),
      name, purchase_date: dateOnly(ago), amount, supplier, notes,
      created_by: 'owner', updated_by: 'owner', is_deleted: 0, created_at: created, updated_at: created,
    });
  });
});

// ── inventory: routes ───────────────────────────────────────
route('GET', '/api/v1/inventory/items', ({ db }) => ({
  success: true,
  message: 'Inventory items',
  data: [...liveItems(db)].sort(sortByName).map(formatItem),
}));

route('GET', '/api/v1/inventory/items/:id', ({ db, params }) => {
  const id = validId(params.id);
  const item = id && findItem(db, id);
  if (!item) throw httpError(404, 'Item not found');
  return { success: true, message: 'Inventory item', data: formatItem(item) };
});

route('POST', '/api/v1/inventory/items/add', ({ db, body, user }) => {
  const fields = readItem(body);
  if (typeof fields === 'string') throw bad(fields);
  const rawOpening = body?.quantity;
  const opening = rawOpening === undefined || rawOpening === null || rawOpening === '' ? 0 : readNumber(rawOpening, 'quantity');
  if (typeof opening === 'string') throw bad(opening);
  if (nameTaken(db, fields.name)) throw httpError(409, `An item called "${fields.name}" already exists`);
  if (codeTaken(db, fields.code)) throw httpError(409, `Another item already has the code ${fields.code}`);

  const actor = actorName(user);
  const now = nowIso();
  const item = {
    id: nextId('inventory_items'),
    name: null, code: null, kind: 'supply', category: null, unit: 'piece',
    min_quantity: 0, cost_price: null, sell_price: null, supplier: null, supplier_phone: null, notes: null,
    ...fields,
    quantity: opening,
    created_by: actor, updated_by: actor, is_deleted: 0, created_at: now, updated_at: now,
  };
  db.inventory_items.push(item);
  // Stock already on the shelf: no price (it isn't money spent this month)
  if (opening > 0) {
    db.inventory_movements.push({
      id: nextId('inventory_movements'), item_id: item.id, type: 'in', change: opening, balance: opening,
      unit_price: null, note: 'Opening stock', created_by: actor, created_at: now,
    });
  }
  return { status: 201, data: { success: true, message: 'Item added', data: formatItem(item) } };
});

route('PUT', '/api/v1/inventory/items/update/:id', ({ db, params, body, user }) => {
  const id = validId(params.id);
  const item = id && findItem(db, id);
  if (!item) throw httpError(404, 'Item not found');
  if (body?.quantity !== undefined) {
    throw bad("The stock can't be edited here. Record stock in, use, sale or a count instead.");
  }
  const fields = readItem(body, true);
  if (typeof fields === 'string') throw bad(fields);
  if (!Object.keys(fields).length) throw bad('No fields provided to update');
  if (fields.name !== undefined && nameTaken(db, fields.name, id)) throw httpError(409, `An item called "${fields.name}" already exists`);
  if (fields.code && codeTaken(db, fields.code, id)) throw httpError(409, `Another item already has the code ${fields.code}`);
  Object.assign(item, fields, { updated_by: actorName(user), updated_at: nowIso() });
  return { success: true, message: 'Item updated', data: formatItem(item) };
});

route('PUT', '/api/v1/inventory/items/delete/:id', ({ db, params, body, user }) => {
  const id = validId(params.id);
  const item = id && findItem(db, id);
  if (!item) throw httpError(404, 'Item not found');
  readReason(body);
  Object.assign(item, { is_deleted: 1, updated_by: actorName(user), updated_at: nowIso() });
  return { success: true, message: 'Item deleted' };
});

route('POST', '/api/v1/inventory/movements/add', ({ db, body = {}, user }) => {
  const itemId = validId(body.item_id);
  if (!itemId) throw bad('item_id is required');
  const { type } = body;
  if (!TYPES.includes(type)) throw bad('type must be in, use, sell or adjust');

  const input = { type };
  if (type === 'adjust') {
    const counted = readNumber(body.counted, 'counted');
    if (typeof counted === 'string') throw bad(counted);
    input.counted = counted;
  } else {
    const quantity = readNumber(body.quantity, 'quantity', { allowZero: false });
    if (typeof quantity === 'string') throw bad(quantity);
    input.quantity = quantity;
  }
  if ((type === 'in' || type === 'sell') && body.unit_price !== undefined && body.unit_price !== null && body.unit_price !== '') {
    const price = readNumber(body.unit_price, 'unit_price', { max: MAX_PRICE });
    if (typeof price === 'string') throw bad(price);
    input.unitPrice = price;
  }
  const note = optText(body.note, 'note', 255);
  if (note.error) throw bad(note.error);
  if (type === 'adjust' && !note.value) throw bad('A note is required when correcting the stock (why it was different)');
  input.note = note.value;

  const item = findItem(db, itemId);
  if (!item) throw httpError(404, 'Item not found');
  const { movement } = move(db, item, input, actorName(user));
  const words = { in: 'Stock added', use: 'Use recorded', sell: 'Sale recorded', adjust: 'Stock corrected' };
  return { status: 201, data: { success: true, message: words[type], data: { item: formatItem(item), movement: formatMovement(db, movement) } } };
});

route('GET', '/api/v1/inventory/movements', ({ db, query: q }) => {
  let itemId = null;
  if (q.item_id !== undefined && q.item_id !== '') {
    itemId = validId(q.item_id);
    if (!itemId) throw bad('item_id must be a number');
  }
  if (q.type && !TYPES.includes(q.type)) throw bad('type must be in, use, sell or adjust');
  for (const k of ['from', 'to']) {
    if (q[k] && !DATE.test(q[k])) throw bad(`${k} must be a date like 2026-11-10`);
  }
  const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, Number.parseInt(q.limit, 10) || 50));

  const list = db.inventory_movements
    .filter((m) => (!itemId || m.item_id === itemId) && (!q.type || m.type === q.type) && inRange(m.created_at, q.from, q.to))
    .sort(byNewest);
  const p = paginate(list, page, limit);
  return { success: true, message: 'Stock history', data: p.results.map((m) => formatMovement(db, m)), total: p.total, page, limit };
});

route('GET', '/api/v1/inventory/summary', ({ db, query }) => {
  const { from, to } = query;
  for (const [k, v] of [['from', from], ['to', to]]) {
    if (v && !DATE.test(v)) throw bad(`${k} must be a date like 2026-11-10`);
  }
  return { success: true, message: 'Inventory summary', data: inventorySummary(db, from || null, to || null) };
});

route('GET', '/api/v1/inventory/consumption', ({ db, query }) => {
  const { from, to } = query;
  if (!from || !to || !DATE.test(from) || !DATE.test(to)) throw bad('from and to are required, as dates like 2026-11-12');
  if (from > to) throw bad('from must be on or before to');

  // Per item: used in washing and sold, with their value
  const per = new Map();
  for (const m of db.inventory_movements) {
    if ((m.type !== 'use' && m.type !== 'sell') || !inRange(m.created_at, from, to)) continue;
    const i = db.inventory_items.find((x) => x.id === m.item_id);
    if (!i) continue;
    if (!per.has(i.id)) {
      per.set(i.id, {
        item_id: i.id, name: i.name, code: i.code, unit: i.unit, kind: i.kind, category: i.category,
        item_deleted: i.is_deleted === 1, used: 0, sold: 0, used_value: 0, sold_value: 0, entries: 0,
      });
    }
    const row = per.get(i.id);
    if (m.type === 'use') {
      row.used += -m.change;
      row.used_value += -m.change * Number(i.cost_price || 0);
    } else {
      row.sold += -m.change;
      row.sold_value += -m.change * Number(m.unit_price || 0);
    }
    row.entries += 1;
  }
  const items = [...per.values()].sort(sortByName).map((row) => ({
    ...row,
    used: round2(row.used),
    sold: round2(row.sold),
    used_value: round2(row.used_value),
    sold_value: round2(row.sold_value),
  }));
  return {
    success: true,
    message: 'Stock consumption',
    data: {
      from,
      to,
      items,
      used_value: round2(items.reduce((s, i) => s + i.used_value, 0)),
      sold_value: round2(items.reduce((s, i) => s + i.sold_value, 0)),
    },
  };
});

// Machinery
route('GET', '/api/v1/inventory/machinery', ({ db }) => ({
  success: true,
  message: 'Machinery',
  data: [...liveMachines(db)]
    .sort((a, b) => (a.purchase_date < b.purchase_date ? 1 : a.purchase_date > b.purchase_date ? -1 : b.id - a.id))
    .map(formatMachine),
}));

route('POST', '/api/v1/inventory/machinery/add', ({ db, body, user }) => {
  const fields = readMachine(body);
  if (typeof fields === 'string') throw bad(fields);
  const actor = actorName(user);
  const now = nowIso();
  const machine = {
    id: nextId('inventory_machinery'), supplier: null, notes: null, ...fields,
    created_by: actor, updated_by: actor, is_deleted: 0, created_at: now, updated_at: now,
  };
  db.inventory_machinery.push(machine);
  return { status: 201, data: { success: true, message: 'Machine added', data: formatMachine(machine) } };
});

route('PUT', '/api/v1/inventory/machinery/update/:id', ({ db, params, body, user }) => {
  const id = validId(params.id);
  const machine = id && liveMachines(db).find((m) => m.id === id);
  if (!machine) throw httpError(404, 'Machine not found');
  const fields = readMachine(body, true);
  if (typeof fields === 'string') throw bad(fields);
  if (!Object.keys(fields).length) throw bad('No fields provided to update');
  Object.assign(machine, fields, { updated_by: actorName(user), updated_at: nowIso() });
  return { success: true, message: 'Machine updated', data: formatMachine(machine) };
});

route('PUT', '/api/v1/inventory/machinery/delete/:id', ({ db, params, body, user }) => {
  const id = validId(params.id);
  const machine = id && liveMachines(db).find((m) => m.id === id);
  if (!machine) throw httpError(404, 'Machine not found');
  readReason(body);
  Object.assign(machine, { is_deleted: 1, updated_by: actorName(user), updated_at: nowIso() });
  return { success: true, message: 'Machine deleted' };
});

// ── expenses ────────────────────────────────────────────────
// Uploaded bill files stay in memory only (not in the saved demo data), keyed
// by expense id. The row keeps bill_file = 'upload' as the flag; a seeded bill
// has bill_file = 'sample' and is generated as a small PDF when opened.
const uploadedBills = new Map();

function formatExpense(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    expense_date: row.expense_date,
    amount: num(row.amount),
    paid_to: row.paid_to,
    note: row.note,
    has_bill: Boolean(row.bill_file),
    bill_name: row.bill_name,
    bill_type: row.bill_type,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const liveExpenses = (d) => d.expenses.filter((e) => !e.is_deleted);
const findExpense = (d, id) => liveExpenses(d).find((e) => e.id === id) || null;

/** Same filters as the backend's whereFor: type, from / to (expense_date), search (paid_to or note). */
function filterExpenses(d, { type = null, from = null, to = null, search = '' } = {}) {
  const s = String(search || '').toLowerCase();
  return liveExpenses(d).filter((e) =>
    (!type || e.type === type) &&
    (!from || e.expense_date >= from) &&
    (!to || e.expense_date <= to) &&
    (!s || String(e.paid_to || '').toLowerCase().includes(s) || String(e.note || '').toLowerCase().includes(s)));
}

/** Expense fields from a (multipart) body. `partial` = only what was sent. */
function readExpense(body = {}, partial = false) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('type')) {
    if (!EXPENSE_TYPES.includes(body.type)) return `type must be one of: ${EXPENSE_TYPES.join(', ')}`;
    out.type = body.type;
  }
  if (!partial || has('expense_date')) {
    const date = validDate(body.expense_date);
    if (!date) return 'expense_date must be a date like 2026-11-12';
    out.expense_date = date;
  }
  if (!partial || has('amount')) {
    const text = String(body.amount ?? '').trim();
    if (!/^\d+(\.\d{1,2})?$/.test(text) || Number(text) <= 0 || Number(text) > MAX_AMOUNT) {
      return 'amount must be more than 0 (up to 2 decimals)';
    }
    out.amount = Number(text);
  }
  for (const [key, max] of [['paid_to', 150], ['note', 255]]) {
    if (partial && !has(key)) continue;
    const text = String(body[key] ?? '').trim();
    if (text.length > max) return `${key} must be ${max} characters or less`;
    out[key] = text || null;
  }
  return out;
}

/** The uploaded "bill" file: checked like the backend's uploader (PDF / JPG / PNG / WEBP, 10 MB). */
function readBillFile(files) {
  const file = files?.bill?.[0];
  if (!file) return null;
  const okTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  if (!okTypes.includes(file.type)) throw bad('Unsupported file type. Allowed: PDF, JPG, PNG, WEBP.');
  if (file.size > 10 * 1024 * 1024) throw bad('File too large');
  return file;
}

// A tiny one-page PDF for the sample bills (built on request, never stored).
function samplePdf(lines) {
  const esc = (t) => String(t).replace(/[^\x20-\x7E]/g, '-').replace(/([\\()])/g, '\\$1');
  const text = lines
    .map((t, i) => `BT /${i === 0 ? 'F2 16' : 'F1 11'} Tf 40 ${i === 0 ? 540 : 520 - i * 22} Td (${esc(t)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((o, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([pdf], { type: 'application/pdf' });
}

const BILL_TITLE = { utility: 'UTILITY BILL', shop_rent: 'RENT RECEIPT', room_rent: 'RENT RECEIPT', salary: 'SALARY SLIP', other: 'INVOICE' };

// ── expenses: sample data ───────────────────────────────────
const WORKERS = [['Ramesh', 1900], ['Suresh', 1900], ['Bikash', 1800], ['Joseph', 2100], ['Anil', 2000], ['Imran (supervisor)', 4200], ['Maria (cashier)', 3200]];

seeder(30, (d, h) => {
  d.expenses = [];
  const today = dateOnly(0);
  const now = new Date();
  const r = rng(31);
  const rows = [];
  const monthName = (y, m) => new Date(y, m, 1).toLocaleString('en-US', { month: 'long' });

  // The last three months (this month only up to today)
  for (let back = 2; back >= 0; back--) {
    const y = new Date(now.getFullYear(), now.getMonth() - back, 1).getFullYear();
    const m = new Date(now.getFullYear(), now.getMonth() - back, 1).getMonth();
    const on = (day) => `${y}-${pad(m + 1)}-${pad(day)}`;
    const thisMonth = monthName(y, m);
    const lastMonth = monthName(y, m - 1);
    const slug = `${y}-${pad(m + 1)}`;

    rows.push(['shop_rent', on(1), 22000, 'Al Waab building owner', `${thisMonth} rent`, back === 1 ? `rent-receipt-${slug}.pdf` : null]);
    rows.push(['room_rent', on(2), 5500, "Workers' accommodation landlord", `${thisMonth} rent, 2 rooms`]);
    WORKERS.forEach(([name, pay], i) => rows.push(['salary', on(3), pay + (i === 3 && back === 0 ? 150 : 0), name, `${lastMonth} salary${i === 3 && back === 0 ? ' + overtime' : ''}`]));
    rows.push(['utility', on(8), round2(3200 + r.int(0, 900) + r.int(0, 99) / 100), 'Electricity & water authority', `Electricity & water, ${lastMonth}`, `electricity-water-${slug}.pdf`]);
    rows.push(['utility', on(10), 449, 'Internet provider', `Internet & phone line, ${thisMonth}`]);
    rows.push(['other', on(r.int(5, 9)), 120 + r.int(0, 60), 'Water tanker', 'Extra water delivery']);
    rows.push(['other', on(r.int(12, 14)), 85, 'Stationery shop', 'Receipt rolls and printer paper']);
  }
  // One-off costs
  rows.push(['other', dateOnly(44), 650, 'Bayline Cleaning Chemicals', 'Pressure washer pump repair', 'repair-invoice-pressure-washer.pdf']);
  rows.push(['other', dateOnly(27), 960, 'Uniform tailor', '8 staff uniforms']);
  rows.push(['other', dateOnly(19), 300, 'Pest control service', 'Quarterly pest control']);
  rows.push(['other', dateOnly(6), 1250, 'Sign maker', 'New price board at the entrance']);
  rows.push(['utility', dateOnly(4), 180, 'Gas cylinder supplier', 'Gas for the staff kitchen']);

  rows
    .filter(([, date]) => date <= today)
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .forEach(([type, date, amount, paidTo, note, billName]) => {
      const [yy, mm, dd] = date.split('-').map(Number);
      const created = new Date(yy, mm - 1, dd, 11, r.int(0, 59)).toISOString();
      d.expenses.push({
        id: h.nextId(d, 'expenses'),
        type, expense_date: date, amount, paid_to: paidTo, note,
        bill_file: billName ? 'sample' : null,
        bill_name: billName || null,
        bill_type: billName ? 'application/pdf' : null,
        created_by: 'owner', updated_by: 'owner', is_deleted: 0, created_at: created, updated_at: created,
      });
    });
});

// ── expenses: routes ────────────────────────────────────────
route('GET', '/api/v1/expenses', ({ db, query: q }) => {
  const filters = {};
  if (q.type) {
    if (!EXPENSE_TYPES.includes(q.type)) throw bad(`type must be one of: ${EXPENSE_TYPES.join(', ')}`);
    filters.type = q.type;
  }
  for (const k of ['from', 'to']) {
    if (!q[k]) continue;
    filters[k] = validDate(q[k]);
    if (!filters[k]) throw bad(`${k} must be a date like 2026-11-12`);
  }
  if (q.search) filters.search = String(q.search).trim().slice(0, 100);
  const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
  const limit = Math.min(500, Math.max(1, Number.parseInt(q.limit, 10) || 50));

  const list = filterExpenses(db, filters).sort((a, b) =>
    (a.expense_date < b.expense_date ? 1 : a.expense_date > b.expense_date ? -1 : b.id - a.id));
  const p = paginate(list, page, limit);
  return {
    success: true,
    message: 'Expenses',
    data: p.results.map(formatExpense),
    total: list.length,
    amount: round2(list.reduce((s, e) => s + Number(e.amount), 0)),
    page,
    limit,
  };
});

route('GET', '/api/v1/expenses/summary', ({ db, query }) => {
  const { from, to } = query;
  const f = from ? validDate(from) : null;
  const t = to ? validDate(to) : null;
  if ((from && !f) || (to && !t)) throw bad('from / to must be dates like 2026-11-12');
  const list = filterExpenses(db, { from: f, to: t });
  const byType = Object.fromEntries(EXPENSE_TYPES.map((k) => [k, { count: 0, amount: 0 }]));
  for (const e of list) {
    byType[e.type].count += 1;
    byType[e.type].amount = round2(byType[e.type].amount + Number(e.amount));
  }
  return {
    success: true,
    message: 'Expense totals',
    data: {
      from: f,
      to: t,
      by_type: byType,
      total: round2(list.reduce((s, e) => s + Number(e.amount), 0)),
      count: list.length,
    },
  };
});

route('GET', '/api/v1/expenses/bill/:id', ({ db, params }) => {
  const id = validId(params.id);
  const e = id && findExpense(db, id);
  if (!e || !e.bill_file) throw httpError(404, 'No bill saved for this expense');
  if (e.bill_file === 'upload') {
    const file = uploadedBills.get(e.id);
    if (!file) {
      throw httpError(404, 'The bill file is missing: in the demo, uploaded files are kept only until the page is reloaded. Upload it again to view it.');
    }
    return { status: 200, data: file };
  }
  // A sample bill, generated now
  return {
    status: 200,
    data: samplePdf([
      BILL_TITLE[e.type] || 'INVOICE',
      'Sample document - demo data',
      `Ref no.: EXP-${String(e.id).padStart(5, '0')}`,
      `Date: ${e.expense_date}`,
      `Paid to: ${e.paid_to || '-'}`,
      `For: ${e.note || '-'}`,
      `Amount: QAR ${Number(e.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      'Status: Paid',
    ]),
  };
});

route('POST', '/api/v1/expenses/add', ({ db, body, files, user }) => {
  const fields = readExpense(body);
  if (typeof fields === 'string') throw bad(fields);
  const file = readBillFile(files);
  const actor = actorName(user);
  const now = nowIso();
  const row = {
    id: nextId('expenses'),
    type: null, expense_date: null, amount: null, paid_to: null, note: null,
    ...fields,
    bill_file: file ? 'upload' : null,
    bill_name: file ? String(file.name || 'bill').slice(0, 255) : null,
    bill_type: file ? file.type || 'application/octet-stream' : null,
    created_by: actor, updated_by: actor, is_deleted: 0, created_at: now, updated_at: now,
  };
  db.expenses.push(row);
  if (file) uploadedBills.set(row.id, file);
  return { status: 201, data: { success: true, message: 'Expense saved', data: formatExpense(row) } };
});

route('PUT', '/api/v1/expenses/update/:id', ({ db, params, body, files, user }) => {
  const id = validId(params.id);
  const row = id && findExpense(db, id);
  if (!row) throw httpError(404, 'Expense not found');
  const fields = readExpense(body, true);
  if (typeof fields === 'string') throw bad(fields);
  const file = readBillFile(files);
  const removeBill = String(body?.remove_bill) === 'true';
  if (file) Object.assign(fields, { bill_file: 'upload', bill_name: String(file.name || 'bill').slice(0, 255), bill_type: file.type || 'application/octet-stream' });
  else if (removeBill) Object.assign(fields, { bill_file: null, bill_name: null, bill_type: null });
  if (!Object.keys(fields).length) throw bad('No fields provided to update');

  Object.assign(row, fields, { updated_by: actorName(user), updated_at: nowIso() });
  if (file) uploadedBills.set(row.id, file);
  else if (removeBill) uploadedBills.delete(row.id);
  return { success: true, message: 'Expense updated', data: formatExpense(row) };
});

route('PUT', '/api/v1/expenses/delete/:id', ({ db, params, body, user }) => {
  const id = validId(params.id);
  const row = id && findExpense(db, id);
  if (!row) throw httpError(404, 'Expense not found');
  readReason(body);
  Object.assign(row, { is_deleted: 1, updated_by: actorName(user), updated_at: nowIso() });
  return { success: true, message: 'Expense deleted' };
});
