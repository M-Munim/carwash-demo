// Demo: staff logins and the queue screen ads.

import { route, seeder, httpError, nextId, nowIso, changeMade, onDemoReset } from './core';

/** The demo accounts, also shown on the login page. */
export const DEMO_ACCOUNTS = [
  { username: 'owner', password: 'demo1234', role: 'super_admin', label: 'Owner (Super Admin)' },
  { username: 'staff', password: 'demo1234', role: 'admin', label: 'Reception staff (Admin)' },
];

seeder(1, (d) => {
  d.users = DEMO_ACCOUNTS.map((a, i) => ({
    id: i + 1,
    username: a.username,
    email: `${a.username}@washdesk.demo`,
    password: a.password,
    role: a.role,
  }));
});

route('POST', '/api/v1/identity/login', ({ db, body }) => {
  const id = String(body?.identifier || '').trim().toLowerCase();
  const user = db.users.find((u) => u.username === id || u.email === id);
  if (!user || user.password !== body?.password) {
    throw httpError(401, 'Invalid username or password');
  }
  const token = `demo-token-${user.id}`;
  return {
    success: true,
    message: 'Login successful',
    token,
    accessToken: token,
    refreshToken: token,
    expiresIn: 3600,
    user: { id: user.id, username: user.username, email: user.email, role: user.role },
  };
});

// ── queue screen ads ────────────────────────────────────────
// Uploaded files stay in this browser tab only (no file server in the demo),
// so they are kept in memory, not in the saved demo data.
const ads = [];
let queueSeconds = 45;
// The 20-second demo reset clears uploaded ads too.
onDemoReset(() => { ads.length = 0; queueSeconds = 45; });

const adRow = (a) => ({ ...a });

route('GET', '/api/v1/screen-ads/all', () => ({ success: true, data: ads.map(adRow) }));
route('GET', '/api/v1/screen-ads/active', () => ({ success: true, data: ads.filter((a) => a.is_active).map(adRow) }));
route('GET', '/api/v1/screen-ads/settings', () => ({ success: true, data: { queue_seconds: queueSeconds } }));
route('PUT', '/api/v1/screen-ads/settings', ({ body }) => {
  queueSeconds = Number(body?.queue_seconds) || queueSeconds;
  changeMade();
  return { success: true, message: 'Settings saved', data: { queue_seconds: queueSeconds } };
});

route('POST', '/api/v1/screen-ads/add', ({ body, files }) => {
  const file = files.file?.[0];
  if (!file) throw httpError(400, 'Please choose a picture or video.');
  const isVideo = String(file.type || '').startsWith('video/');
  const ad = {
    id: nextId('screen_ads'),
    title: body.title || file.name,
    type: isVideo ? 'video' : 'image',
    file_url: URL.createObjectURL(file),
    seconds: Number(body.seconds) || 10,
    sort_order: Number(body.sort_order) || ads.length + 1,
    is_active: body.is_active === undefined ? 1 : Number(body.is_active === 'true' || body.is_active === '1' || body.is_active === true),
    created_at: nowIso(),
  };
  ads.push(ad);
  return { status: 201, data: { success: true, message: 'Ad added. In the demo it stays for 20 seconds.', data: adRow(ad) } };
});

route('PUT', '/api/v1/screen-ads/update/:id', ({ params, body }) => {
  const ad = ads.find((a) => String(a.id) === params.id);
  if (!ad) throw httpError(404, 'Ad not found');
  ['title', 'seconds', 'sort_order', 'is_active'].forEach((k) => {
    if (body?.[k] !== undefined) ad[k] = k === 'title' ? body[k] : Number(body[k] === true ? 1 : body[k] === false ? 0 : body[k]);
  });
  changeMade();
  return { success: true, message: 'Ad updated', data: adRow(ad) };
});

route('PUT', '/api/v1/screen-ads/delete/:id', ({ params }) => {
  const i = ads.findIndex((a) => String(a.id) === params.id);
  if (i < 0) throw httpError(404, 'Ad not found');
  ads.splice(i, 1);
  changeMade();
  return { success: true, message: 'Ad deleted' };
});
