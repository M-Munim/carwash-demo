// Demo: WhatsApp Broadcast. Settings, message templates, broadcasts, their
// recipients and the opt-out list. Mirrors broadcastController /
// whatsappTemplateController of the real backend (same shapes, statuses and
// messages). Nothing here talks to Meta or the network: "Meta" answers are
// simulated, and sending only changes rows in the demo data.

import { route, seeder, httpError, nextId, nowIso, save, helpers } from './core';
import { SAMPLE_CUSTOMERS } from './bookings';

// ── constants from the real backend ─────────────────────────
const AUDIENCE_TYPES = ['all', 'recent', 'inactive'];
const META_ID = /^\d{5,30}$/;
const APP_SECRET = /^[A-Za-z0-9]{16,64}$/;
const EDITABLE = ['draft', 'scheduled'];
const REVIEWED = ['approved', 'rejected', 'paused', 'disabled'];
const NAME_TAG = '{{name}}';
const DEFAULT_SAMPLE_NAME = 'Ahmed';
const CATEGORIES = ['MARKETING', 'UTILITY'];
const LANGUAGES = ['en', 'en_US', 'ar'];
const TEMPLATE_NAME = /^[a-z0-9_]{1,150}$/;
const MAX_BODY = 1024;
const MAX_FOOTER = 60;
const MAX_BUTTON_TEXT = 25;
const MAX_BUTTON_URL = 2000;
const DAILY_LIMIT = 250; // Meta's limit for a new (unverified) business number
const MISSED_AFTER_MS = 6 * 60 * 60 * 1000;
const NEEDS_APPROVAL = 'Only a message Meta has approved can be scheduled. Save it as a draft for now.';
const limitNote = () => `Daily limit reached (${DAILY_LIMIT} messages in 24 hours). The rest go out by themselves as the limit frees up.`;

// Demo timing: how long "Meta" takes for each step.
const SEND_AFTER_MS = 2500; // a broadcast stays "sending" this long
const READ_AFTER_MS = 25 * 1000; // then read receipts come in
const SYNC_APPROVES_AFTER_MS = 10 * 1000; // "Check Meta status" approves a submitted template after this
const AUTO_APPROVE_AFTER_MS = 60 * 1000; // any reload approves it after this

const DEMO_BUTTON_URL = 'https://washdesk.example/chat';
const ACTOR = 'owner';

// ── phone numbers (same rules as the backend) ──────────────
function toWhatsAppNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '').replace(/^00/, '');
  if (/^[3567]\d{7}$/.test(digits)) return `974${digits}`;
  if (digits.startsWith('974')) return /^974[3567]\d{7}$/.test(digits) ? digits : null;
  return /^[1-9]\d{9,14}$/.test(digits) ? digits : null;
}

/** The company number may be a Qatar landline (4xxx xxxx). */
function toCompanyNumber(raw) {
  const digits = String(raw || '').replace(/\D/g, '').replace(/^00/, '');
  if (/^4\d{7}$/.test(digits)) return `974${digits}`;
  if (/^9744\d{7}$/.test(digits)) return digits;
  return toWhatsAppNumber(raw);
}

const maskPhone = (phone) => (phone.length > 6 ? `${phone.slice(0, 3)}${'•'.repeat(phone.length - 6)}${phone.slice(-3)}` : phone);

/** A stable 0..1 number per text, so the simulated delivery results don't jump around. */
function hash01(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  // mix the bits so similar texts still spread evenly
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const bad = (message) => httpError(400, message);
const conflict = (message, extra) => httpError(409, message, extra);
const actorName = (user) => user?.username || null;

// Hidden demo fields (start with _demo) never go to the dashboard.
const clean = (row) => (row ? Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('_demo'))) : row);

// ── settings ────────────────────────────────────────────────
function settingsOut(d) {
  const s = d.whatsapp_settings;
  const details_saved = Boolean(s.business_account_id && s.phone_number_id && s.token_saved);
  return {
    business_account_id: s.business_account_id || null,
    phone_number_id: s.phone_number_id || null,
    display_number: s.display_number || null,
    token_saved: Boolean(s.token_saved),
    token_last4: s.token_saved ? s.token_last4 : null,
    token_unreadable: false,
    details_saved,
    sending_enabled: details_saved,
    sending_switched_off: false,
    webhook_url: 'https://washdesk.example/api/v1/whatsapp/webhook',
    webhook_verify_token: s.webhook_verify_token,
    app_secret_saved: Boolean(s.app_secret_saved),
    updated_by: s.updated_by || null,
    updated_at: s.updated_at || null,
  };
}

const connected = (d) => settingsOut(d).details_saved;

// ── audience: customers from car wash orders ────────────────
function resolveAudience(d, audience = {}) {
  const service = String(audience.service || '').trim().toLowerCase();
  const byPhone = new Map();
  let invalid = 0;
  const seenRaw = new Set();
  (d.bookings || [])
    .filter((b) => !b.is_deleted && String(b.Service || '').trim().toLowerCase() === 'car wash' && b.contact_number)
    .forEach((b) => {
      const phone = toWhatsAppNumber(b.contact_number);
      if (!phone) {
        // the backend counts each unusable saved number once
        if (!seenRaw.has(b.contact_number)) invalid += 1;
        seenRaw.add(b.contact_number);
        return;
      }
      const usedService = !service
        || String(b.sub_Service || '').toLowerCase().includes(service)
        || String(b.package || '').toLowerCase().includes(service);
      const visit = new Date(b.created_at);
      const seen = byPhone.get(phone);
      if (!seen) {
        byPhone.set(phone, { phone, name: b.passenger_name || '', last_visit: visit, used_service: usedService });
      } else {
        if (visit > seen.last_visit) {
          seen.last_visit = visit;
          if (b.passenger_name) seen.name = b.passenger_name;
        }
        seen.used_service = seen.used_service || usedService;
      }
    });

  const days = Number(audience.days) || 0;
  const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
  const matches = [...byPhone.values()].filter((c) => {
    if (service && !c.used_service) return false;
    const visited = c.last_visit ? c.last_visit.getTime() : 0;
    if (audience.type === 'recent') return visited >= cutoff;
    if (audience.type === 'inactive') return visited < cutoff;
    return true;
  });
  const optedOut = new Set((d.whatsapp_opt_outs || []).map((o) => o.phone));
  const recipients = matches.filter((c) => !optedOut.has(c.phone));
  return { recipients, count: recipients.length, opted_out: matches.length - recipients.length, invalid_numbers: invalid };
}

function readAudience(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const type = a.type || 'all';
  if (!AUDIENCE_TYPES.includes(type)) return 'audience.type must be all, recent or inactive';
  const days = parseInt(a.days, 10);
  if (type !== 'all' && !(days >= 1 && days <= 3650)) return 'audience.days must be a number from 1 to 3650';
  const service = String(a.service || '').trim();
  if (service.length > 100) return 'audience.service must be 100 characters or less';
  return { type, days: type === 'all' ? null : days, service: service || null };
}

function readBroadcast(body = {}, partial = false) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('title')) {
    const title = String(body.title ?? '').trim();
    if (!title) return 'title is required';
    if (title.length > 150) return 'title must be 150 characters or less';
    out.title = title;
  }
  if (!partial || has('template_id')) {
    const id = Number(body.template_id);
    if (!Number.isInteger(id) || id < 1) return 'template_id is required: pick a message template';
    out.template_id = id;
  }
  if (!partial || has('audience')) {
    const audience = readAudience(body.audience);
    if (typeof audience === 'string') return audience;
    out.audience = audience;
  }
  if (has('scheduled_at')) {
    if (body.scheduled_at === null || body.scheduled_at === '') {
      out.scheduled_at = null;
    } else {
      const when = new Date(body.scheduled_at);
      if (Number.isNaN(when.getTime())) return 'scheduled_at must be a date and time';
      if (when.getTime() < Date.now()) return 'scheduled_at must be in the future';
      out.scheduled_at = when.toISOString();
    }
  }
  return out;
}

// ── templates ───────────────────────────────────────────────
function templateTextProblem({ body, footer, button_text: buttonText, button_url: buttonUrl }) {
  const text = String(body || '').trim();
  if (!text) return 'body is required';
  if (text.length > MAX_BODY) return `body must be ${MAX_BODY} characters or less`;
  const tags = text.match(/\{\{[^}]*\}\}/g) || [];
  if (tags.some((t) => t !== NAME_TAG)) return "body can only use {{name}} for the customer's name";
  if (tags.length > 1) return 'use {{name}} only once in the body';
  if (text.startsWith(NAME_TAG) || text.endsWith(NAME_TAG)) return 'Meta does not allow {{name}} at the very start or end of the message';
  const foot = String(footer || '').trim();
  if (foot.length > MAX_FOOTER) return `footer must be ${MAX_FOOTER} characters or less`;
  if (/\{\{|\}\}/.test(foot)) return "footer can't have {{name}} or other variables";

  const bText = String(buttonText || '').trim();
  const url = String(buttonUrl || '').trim();
  if (!bText && !url) return '';
  if (!bText || !url) return 'a button needs both its text and its link';
  if (bText.length > MAX_BUTTON_TEXT) return `button text must be ${MAX_BUTTON_TEXT} characters or less`;
  if (/\{\{|\}\}/.test(bText) || /\{\{|\}\}/.test(url)) return "the button can't have {{name}} or other variables";
  if (url.length > MAX_BUTTON_URL) return 'the button link is too long';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'the button link must be a full web address, like https://wa.me/97451701605';
  }
  if (parsed.protocol !== 'https:') return 'the button link must start with https://';
  return '';
}

function readTemplate(body = {}, partial = false) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('name')) {
    const name = String(body.name ?? '').trim();
    if (!TEMPLATE_NAME.test(name)) return 'name must be lowercase letters, numbers and _ only (up to 150)';
    out.name = name;
  }
  if (!partial || has('language')) {
    const language = String(body.language ?? 'en').trim() || 'en';
    if (!LANGUAGES.includes(language)) return `language must be one of ${LANGUAGES.join(', ')}`;
    out.language = language;
  }
  if (!partial || has('category')) {
    const category = String(body.category ?? 'MARKETING').trim().toUpperCase() || 'MARKETING';
    if (!CATEGORIES.includes(category)) return 'category must be MARKETING or UTILITY';
    out.category = category;
  }
  if (!partial || has('body')) out.body = String(body.body ?? '').trim();
  if (!partial || has('footer')) out.footer = String(body.footer ?? '').trim() || null;
  if (!partial || has('sample_name')) {
    const sample = String(body.sample_name ?? '').trim();
    if (sample.length > 60) return 'sample_name must be 60 characters or less';
    out.sample_name = sample || null;
  }
  if (!partial || has('button_text')) out.button_text = String(body.button_text ?? '').trim() || null;
  if (!partial || has('button_url')) out.button_url = String(body.button_url ?? '').trim() || null;
  return out;
}

const liveTemplates = (d) => d.whatsapp_templates.filter((t) => !t.is_deleted);
const findTemplate = (d, id) => liveTemplates(d).find((t) => String(t.id) === String(id)) || null;
const nameTaken = (d, name, language, exceptId = 0) =>
  liveTemplates(d).some((t) => t.name === name && t.language === language && t.id !== exceptId);
const usedBy = (d, id) => liveBroadcasts(d).filter((b) => b.template_id === id && EDITABLE.includes(b.status));
const usedByMessage = (list, doing) => `"${list[0].title}" (${list[0].status}) uses this message. ${doing}`;
const sortTemplates = (list) =>
  [...list].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id);

/** Drafts keep a copy of the template text; keep it current (like templateService.update). */
function updateTemplate(d, tpl, fields) {
  Object.assign(tpl, fields, { updated_at: nowIso() });
  liveBroadcasts(d)
    .filter((b) => b.template_id === tpl.id && b.status === 'draft')
    .forEach((b) => Object.assign(b, { template_name: tpl.name, template_language: tpl.language, message_body: tpl.body }));
  return tpl;
}

/**
 * Simulated Meta review: a submitted template is approved once enough time
 * has passed (`afterMs`). Returns how many changed. The sample template that
 * is "in review" (_demo_hold) stays there, so the status is always on show.
 */
function approveReviewed(d, afterMs) {
  let changed = 0;
  liveTemplates(d).forEach((t) => {
    if (t.status !== 'pending' || t._demo_hold || !t.submitted_at) return;
    if (Date.now() - new Date(t.submitted_at).getTime() < afterMs) return;
    t.status = 'approved';
    t.rejection_reason = null;
    changed += 1;
  });
  return changed;
}

// ── broadcasts and sending ──────────────────────────────────
const liveBroadcasts = (d) => d.broadcasts.filter((b) => !b.is_deleted);
const findBroadcast = (d, id) => liveBroadcasts(d).find((b) => String(b.id) === String(id)) || null;
const recipientsOf = (d, id) => d.broadcast_recipients.filter((r) => r.broadcast_id === id);

/** Sent / delivered / read / failed totals from the recipient rows. */
function recount(d, b) {
  const rows = recipientsOf(d, b.id);
  b.sent_count = rows.filter((r) => ['sent', 'delivered', 'read'].includes(r.status)).length;
  b.delivered_count = rows.filter((r) => ['delivered', 'read'].includes(r.status)).length;
  b.read_count = rows.filter((r) => r.status === 'read').length;
  b.failed_count = rows.filter((r) => r.status === 'failed').length;
}

/** Customers messaged in the last 24 hours, across all broadcasts. */
function sentLast24h(d) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  return new Set(d.broadcast_recipients.filter((r) => r.sent_at && new Date(r.sent_at).getTime() >= since).map((r) => r.phone)).size;
}

function addRecipient(d, broadcastId, c, fields = {}) {
  const row = {
    id: helpers.nextId(d, 'broadcast_recipients'),
    broadcast_id: broadcastId,
    phone: c.phone,
    name: c.name || null,
    status: 'pending',
    message_id: null,
    error: null,
    sent_at: null,
    updated_at: nowIso(),
    ...fields,
  };
  d.broadcast_recipients.push(row);
  return row;
}

/** Checks, claims and starts a broadcast, like broadcastSender.startBroadcast. */
function startBroadcast(d, b) {
  if (!connected(d)) throw conflict('WhatsApp is not connected. Save the Meta details under WhatsApp settings first.', { code: 'whatsapp_not_connected' });
  if (!EDITABLE.includes(b.status)) throw conflict(`This broadcast is already ${b.status}`);
  const tpl = b.template_id ? findTemplate(d, b.template_id) : null;
  if (!tpl) throw bad("This broadcast's message template no longer exists. Pick another one.");
  if (tpl.status !== 'approved') throw bad("Meta has not approved this message, so it can't be sent yet.");
  const { recipients } = resolveAudience(d, b.audience || {});
  if (!recipients.length) throw bad('No customers match this audience, so there is no one to send to.');

  const now = nowIso();
  Object.assign(b, {
    status: 'sending', sent_at: now, last_error: null, updated_at: now,
    template_name: tpl.name, template_language: tpl.language, message_body: tpl.body,
    recipient_count: recipients.length, _demo_reads_done: false,
  });
  recipients.forEach((c) => addRecipient(d, b.id, c));
  recount(d, b);
  return b;
}

/**
 * The simulated sender and scheduler, run on every read. Due scheduled
 * broadcasts start; a "sending" one goes out after a moment (most messages
 * delivered at once); read receipts follow a little later. The daily limit
 * holds the rest back with a note, like the real sender.
 */
function advance(d) {
  let changed = approveReviewed(d, AUTO_APPROVE_AFTER_MS) > 0;
  const now = Date.now();
  if (!connected(d)) return changed; // the real scheduler waits too

  liveBroadcasts(d).forEach((b) => {
    if (b.status === 'scheduled' && b.scheduled_at && new Date(b.scheduled_at).getTime() <= now) {
      changed = true;
      if (now - new Date(b.scheduled_at).getTime() > MISSED_AFTER_MS) {
        Object.assign(b, { status: 'draft', scheduled_at: null, last_error: "Not sent: its scheduled time passed while sending wasn't possible. Schedule it again." });
        return;
      }
      try {
        startBroadcast(d, b);
      } catch (err) {
        Object.assign(b, { status: 'draft', scheduled_at: null, last_error: `Not sent at the scheduled time: ${err.body?.message || err.message}` });
      }
    }

    if (b.status === 'sending' && now - new Date(b.sent_at).getTime() >= SEND_AFTER_MS) {
      changed = true;
      const left = DAILY_LIMIT - sentLast24h(d);
      const pending = recipientsOf(d, b.id).filter((r) => r.status === 'pending');
      const take = Math.max(0, Math.min(pending.length, left));
      pending.slice(0, take).forEach((r) => {
        r.status = hash01(`${b.id}:${r.phone}:d`) < 0.88 ? 'delivered' : 'sent';
        r.message_id = `wamid.DEMO${b.id}x${r.id}`;
        r.sent_at = nowIso();
        r.updated_at = nowIso();
      });
      recount(d, b);
      if (take < pending.length) {
        b.last_error = limitNote(); // stays "sending" until the limit frees up
      } else {
        b.status = b.sent_count > 0 ? 'sent' : 'failed';
        b.last_error = b.sent_count > 0 ? null : 'No message could be sent. Open the broadcast to see why.';
      }
    }

    if (b.status === 'sent' && b._demo_reads_done === false && now - new Date(b.sent_at).getTime() >= READ_AFTER_MS) {
      changed = true;
      recipientsOf(d, b.id).forEach((r) => {
        const x = hash01(`${b.id}:${r.phone}:r`);
        if (r.status === 'delivered' && x < 0.62) r.status = 'read';
        else if (r.status === 'sent' && x < 0.5) r.status = 'delivered';
        r.updated_at = nowIso();
      });
      b._demo_reads_done = true;
      recount(d, b);
    }
  });
  return changed;
}

/** GET handlers change data too (the simulation), so save after. */
function ready(d) {
  ensureSeeded(d);
  if (advance(d)) save();
}

// ── sample data ─────────────────────────────────────────────
function seedBroadcastData(d, h) {
  const at = h.isoAt;
  const hoursAgo = (n) => new Date(Date.now() - n * 3600 * 1000).toISOString();

  d.whatsapp_settings = {
    business_account_id: '100000000000001', // clearly fake Meta IDs
    phone_number_id: '200000000000002',
    display_number: '97440000000',
    token_saved: true,
    token_last4: 'DEMO',
    app_secret_saved: true,
    webhook_verify_token: 'demo0verify0token0000000000000000',
    updated_by: ACTOR,
    updated_at: at(40, 11, 5),
  };

  const tpl = (id, fields) => ({
    id, language: 'en', category: 'MARKETING', footer: 'Reply STOP to opt out', sample_name: DEFAULT_SAMPLE_NAME,
    button_text: null, button_url: null, status: 'approved', meta_template_id: `9000000000000${id}`,
    rejection_reason: null, created_by: ACTOR, updated_by: ACTOR, is_deleted: 0, ...fields,
  });
  d.whatsapp_templates = [
    tpl(1, {
      name: 'weekend_wash_offer',
      body: 'Hi {{name}}, this weekend only: 20% off any Body Wash at WashDesk Demo. Friday and Saturday, 8 am to 9 pm. Show this message at the counter.',
      button_text: 'Chat with us', button_url: DEMO_BUTTON_URL,
      submitted_at: at(35, 10), created_at: at(35, 9, 40), updated_at: at(35, 10),
    }),
    tpl(2, {
      name: 'polishing_offer',
      body: 'Hi {{name}}, give your car a showroom shine. Body Polishing is 25% off until the end of the month at WashDesk Demo. Book your slot today.',
      submitted_at: at(16, 15), created_at: at(16, 14, 30), updated_at: at(16, 15),
    }),
    tpl(3, {
      name: 'eid_offer',
      body: 'Eid Mubarak, {{name}}! Celebrate with a spotless car: a free interior vacuum with every Body Wash during the Eid holidays at WashDesk Demo.',
      button_text: 'Chat with us', button_url: DEMO_BUTTON_URL,
      submitted_at: at(6, 12), created_at: at(6, 11, 20), updated_at: at(6, 12),
    }),
    tpl(4, {
      name: 'ceramic_coating_offer',
      body: 'Hi {{name}}, protect your paint for years. Nano Ceramic Coating is 15% off this month at WashDesk Demo, with a free wash after 30 days.',
      submitted_at: at(4, 16), created_at: at(4, 15, 45), updated_at: at(4, 16),
    }),
    tpl(5, {
      name: 'interior_cleaning_offer',
      body: 'Hi {{name}}, sand and dust inside the car? Full Interior Cleaning is at a special price this week at WashDesk Demo. Drop in any day from 8 am.',
      status: 'pending', submitted_at: hoursAgo(3), created_at: hoursAgo(3.2), updated_at: hoursAgo(3),
      _demo_hold: true, // stays "in review" so the status is always on show
    }),
    tpl(6, {
      name: 'free_wash_reminder',
      category: 'UTILITY',
      body: 'Hi {{name}}, your car is due for a wash. Come in this week and get a FREE wash with any polishing service!',
      footer: null,
      status: 'rejected',
      rejection_reason: 'This is an offer, so Meta needs the Marketing category. Change the category and send it again.',
      submitted_at: at(2, 10), created_at: at(2, 9, 50), updated_at: at(2, 10, 20),
    }),
  ];

  // Opt-outs: one sample customer and one number that never visited
  const optOut = (i, fields) => ({ phone: SAMPLE_CUSTOMERS[i][1], name: SAMPLE_CUSTOMERS[i][0], created_by: null, ...fields });
  d.whatsapp_opt_outs = [
    optOut(4, { reason: 'Replied STOP', source: 'customer', created_at: at(18, 19, 12) }),
    { phone: '97433998877', name: 'Former fleet manager', reason: 'Company number, no longer used', source: 'staff', created_by: ACTOR, created_at: at(50, 10) },
  ];

  // Broadcasts
  d.broadcasts = [];
  d.broadcast_recipients = [];
  const t = (id) => d.whatsapp_templates.find((x) => x.id === id);
  const base = (id, tplId, title, audience, fields) => ({
    id, title, template_id: tplId, template_name: t(tplId).name, template_language: 'en', message_body: t(tplId).body,
    audience, recipient_count: 0, status: 'draft', scheduled_at: null, sent_at: null,
    sent_count: 0, delivered_count: 0, read_count: 0, failed_count: 0, created_by: ACTOR, last_error: null,
    is_deleted: 0, ...fields,
  });

  // Past broadcasts with per-customer results
  const FAIL_REASONS = [
    "Not on WhatsApp, or can't receive this message",
    "Meta held it back so the customer doesn't get too many marketing messages",
  ];
  const sent = [
    [1, 1, 'Weekend wash offer', { type: 'all', days: null, service: null }, at(26, 9, 30)],
    [2, 2, 'Polishing offer', { type: 'all', days: null, service: null }, at(12, 10)],
    [3, 1, 'Weekend wash: regular customers', { type: 'recent', days: 3, service: 'Body Wash – In & Out' }, hoursAgo(20)],
  ];
  sent.forEach(([id, tplId, title, audience, when]) => {
    const b = base(id, tplId, title, audience, { status: 'sent', sent_at: when, created_at: when, updated_at: when, _demo_reads_done: true });
    const { recipients } = resolveAudience(d, audience);
    recipients.forEach((c) => {
      const x = hash01(`seed${id}:${c.phone}`);
      const status = x < 0.05 ? 'failed' : x < 0.62 ? 'read' : x < 0.9 ? 'delivered' : 'sent';
      addRecipient(d, id, c, {
        status,
        message_id: status === 'failed' ? null : `wamid.DEMO${id}x${d.broadcast_recipients.length + 1}`,
        error: status === 'failed' ? FAIL_REASONS[Math.floor(x * 40) % 2] : null,
        sent_at: status === 'failed' ? null : when,
        updated_at: when,
      });
    });
    b.recipient_count = recipients.length;
    recount(d, b);
    d.broadcasts.push(b);
  });

  // One scheduled for the future, one draft
  const future = new Date();
  future.setDate(future.getDate() + 2);
  future.setHours(10, 0, 0, 0);
  const scheduled = base(4, 4, 'Ceramic coating offer', { type: 'all', days: null, service: null }, {
    status: 'scheduled', scheduled_at: future.toISOString(), created_at: at(1, 17, 15), updated_at: at(1, 17, 15),
  });
  scheduled.recipient_count = resolveAudience(d, scheduled.audience).count;
  const draft = base(5, 3, 'Eid offer', { type: 'all', days: null, service: null }, { created_at: hoursAgo(5), updated_at: hoursAgo(5) });
  draft.recipient_count = resolveAudience(d, draft.audience).count;
  d.broadcasts.push(scheduled, draft);
}

seeder(40, seedBroadcastData);

/** Saved demo data from before this module existed: add the broadcast tables. */
function ensureSeeded(d) {
  if (d.whatsapp_settings && d.whatsapp_templates && d.broadcasts && d.broadcast_recipients && d.whatsapp_opt_outs) return;
  seedBroadcastData(d, helpers);
  save();
}

// Like requireRole(["super_admin"]): staff (admin) get the backend's 403.
function superOnly(user) {
  if (user && String(user.role || '').trim().toLowerCase() !== 'super_admin') {
    throw httpError(403, 'This endpoint requires one of: super_admin', { error: 'forbidden' });
  }
}

/** route() with the role check and the simulation step in front. */
function r(method, pattern, handler) {
  route(method, pattern, (req) => {
    superOnly(req.user);
    ready(req.db);
    return handler(req);
  });
}

// ── routes: settings ────────────────────────────────────────
r('GET', '/api/v1/broadcast/settings', ({ db }) => ({
  success: true,
  message: 'WhatsApp settings',
  data: { ...settingsOut(db), daily_limit: DAILY_LIMIT, sent_last_24h: sentLast24h(db) },
}));

r('PUT', '/api/v1/broadcast/settings', ({ db, body = {}, user }) => {
  const fields = {};
  for (const key of ['business_account_id', 'phone_number_id']) {
    if (body[key] === undefined) continue;
    const value = String(body[key] ?? '').trim();
    if (value && !META_ID.test(value)) throw bad(`${key} must be the number from Meta (digits only)`);
    fields[key] = value || null;
  }
  if (body.display_number !== undefined) {
    const raw = String(body.display_number ?? '').trim();
    const number = raw ? toCompanyNumber(raw) : null;
    if (raw && !number) throw bad('display_number is not a valid WhatsApp number');
    fields.display_number = number;
  }
  // A blank token keeps the saved one; remove_token clears it. Only the last 4 are kept.
  if (body.remove_token === true) {
    Object.assign(fields, { token_saved: false, token_last4: null });
  } else if (body.access_token !== undefined && String(body.access_token).trim()) {
    const token = String(body.access_token).trim();
    if (token.length < 20 || /\s/.test(token)) throw bad('access_token does not look like a Meta access token');
    Object.assign(fields, { token_saved: true, token_last4: token.slice(-4) });
  }
  if (body.remove_app_secret === true) {
    fields.app_secret_saved = false;
  } else if (body.app_secret !== undefined && String(body.app_secret).trim()) {
    if (!APP_SECRET.test(String(body.app_secret).trim())) throw bad('app_secret does not look like a Meta app secret (App settings > Basic)');
    fields.app_secret_saved = true;
  }
  if (!Object.keys(fields).length) throw bad('No fields provided to update');

  Object.assign(db.whatsapp_settings, fields, { updated_by: actorName(user), updated_at: nowIso() });
  return { success: true, message: 'WhatsApp settings saved', data: settingsOut(db) };
});

// "Check with Meta": simulated, always the demo business when connected
r('POST', '/api/v1/broadcast/settings/check', ({ db }) => {
  if (!connected(db)) {
    throw conflict('Save the Business Account ID, Phone Number ID and token first.', { code: 'whatsapp_not_connected' });
  }
  return {
    success: true,
    message: 'Connected to Meta',
    data: {
      display_phone_number: '+974 4000 0000',
      verified_name: 'WashDesk Demo',
      quality_rating: 'GREEN',
      business_account_name: 'WashDesk Demo',
      test_account: false,
    },
  };
});

// ── routes: audience and broadcasts ─────────────────────────
r('POST', '/api/v1/broadcast/audience-preview', ({ db, body }) => {
  const audience = readAudience(body?.audience ?? body);
  if (typeof audience === 'string') throw bad(audience);
  const { recipients, ...counts } = resolveAudience(db, audience);
  return {
    success: true,
    message: 'Audience counted',
    data: {
      ...counts,
      sample: recipients.slice(0, 10).map((c) => ({ name: c.name, phone: maskPhone(c.phone), last_visit: c.last_visit.toISOString() })),
    },
  };
});

r('GET', '/api/v1/broadcast/all', ({ db }) => {
  const data = [...liveBroadcasts(db)].sort((a, b) => b.id - a.id).map(clean);
  return { success: true, message: 'Broadcasts fetched', total_records: data.length, data };
});

r('GET', '/api/v1/broadcast/one/:id', ({ db, params }) => {
  const b = findBroadcast(db, params.id);
  if (!b) throw httpError(404, 'Broadcast not found');
  return { success: true, message: 'Broadcast fetched', data: clean(b) };
});

r('POST', '/api/v1/broadcast/add', ({ db, body, user }) => {
  const fields = readBroadcast(body || {});
  if (typeof fields === 'string') throw bad(fields);
  const tpl = findTemplate(db, fields.template_id);
  if (!tpl) throw bad('That message template no longer exists');
  if (fields.scheduled_at && tpl.status !== 'approved') throw bad(NEEDS_APPROVAL);
  const now = nowIso();
  const row = {
    id: nextId('broadcasts'),
    title: fields.title,
    template_id: fields.template_id,
    template_name: tpl.name,
    template_language: tpl.language,
    message_body: tpl.body,
    audience: fields.audience,
    recipient_count: resolveAudience(db, fields.audience).count,
    status: fields.scheduled_at ? 'scheduled' : 'draft',
    scheduled_at: fields.scheduled_at || null,
    sent_at: null,
    sent_count: 0,
    delivered_count: 0,
    read_count: 0,
    failed_count: 0,
    created_by: actorName(user),
    last_error: null,
    is_deleted: 0,
    created_at: now,
    updated_at: now,
  };
  db.broadcasts.push(row);
  return { status: 201, data: { success: true, message: 'Broadcast saved', data: clean(row) } };
});

r('PUT', '/api/v1/broadcast/update/:id', ({ db, params, body }) => {
  const existing = findBroadcast(db, params.id);
  if (!existing) throw httpError(404, 'Broadcast not found');
  if (!EDITABLE.includes(existing.status)) throw conflict(`A ${existing.status} broadcast can't be changed`);
  const fields = readBroadcast(body || {}, true);
  if (typeof fields === 'string') throw bad(fields);
  if (!Object.keys(fields).length) throw bad('No fields provided to update');

  if (fields.scheduled_at !== undefined) fields.status = fields.scheduled_at ? 'scheduled' : 'draft';
  fields.last_error = null;
  const templateId = fields.template_id ?? existing.template_id;
  const tpl = templateId ? findTemplate(db, templateId) : null;
  if (fields.template_id) {
    if (!tpl) throw bad('That message template no longer exists');
    Object.assign(fields, { template_name: tpl.name, template_language: tpl.language, message_body: tpl.body });
  }
  if ((fields.status ?? existing.status) === 'scheduled' && tpl?.status !== 'approved') throw bad(NEEDS_APPROVAL);
  if (fields.audience) fields.recipient_count = resolveAudience(db, fields.audience).count;

  Object.assign(existing, fields, { updated_at: nowIso() });
  return { success: true, message: 'Broadcast updated', data: clean(existing) };
});

r('PUT', '/api/v1/broadcast/delete/:id', ({ db, params }) => {
  const existing = findBroadcast(db, params.id);
  if (!existing) throw httpError(404, 'Broadcast not found');
  if (existing.status === 'sending') throw conflict("A broadcast that is sending can't be deleted");
  existing.is_deleted = 1;
  return { success: true, message: 'Broadcast deleted' };
});

// Send now: answers 202 at once; the simulation sends it on the next reads.
r('POST', '/api/v1/broadcast/send/:id', ({ db, params }) => {
  const existing = findBroadcast(db, params.id);
  if (!existing) throw httpError(404, 'Broadcast not found');
  const b = startBroadcast(db, existing);
  return { status: 202, data: { success: true, message: `Sending to ${b.recipient_count} customers`, data: clean(b) } };
});

r('GET', '/api/v1/broadcast/recipients/:id', ({ db, params }) => {
  const existing = findBroadcast(db, params.id);
  if (!existing) throw httpError(404, 'Broadcast not found');
  const data = recipientsOf(db, existing.id)
    .sort((a, b) => a.id - b.id)
    .map(({ phone, name, status, error, updated_at }) => ({ phone, name, status, error, updated_at }));
  return { success: true, message: 'Recipients fetched', total_records: data.length, data };
});

// ── routes: opt-outs ────────────────────────────────────────
r('GET', '/api/v1/broadcast/opt-outs', ({ db }) => {
  const data = [...db.whatsapp_opt_outs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { success: true, message: 'Opt-out list fetched', total_records: data.length, data };
});

r('POST', '/api/v1/broadcast/opt-outs', ({ db, body, user }) => {
  const phone = toWhatsAppNumber(body?.phone);
  if (!phone) throw bad('phone is not a valid WhatsApp number');
  const name = String(body?.name ?? '').trim().slice(0, 255);
  const reason = String(body?.reason ?? '').trim();
  if (reason.length > 255) throw bad('reason must be 255 characters or less');

  let row = db.whatsapp_opt_outs.find((o) => o.phone === phone);
  if (row) {
    // ON DUPLICATE KEY: a new name / reason replaces the old one
    if (name) row.name = name;
    if (reason) row.reason = reason;
  } else {
    row = { phone, name: name || null, reason: reason || null, source: 'staff', created_by: actorName(user), created_at: nowIso() };
    db.whatsapp_opt_outs.push(row);
  }
  return { status: 201, data: { success: true, message: 'Customer will not get broadcasts', data: row } };
});

r('PUT', '/api/v1/broadcast/opt-outs/delete/:phone', ({ db, params }) => {
  const phone = toWhatsAppNumber(params.phone);
  if (!phone) throw bad('phone is not a valid WhatsApp number');
  const before = db.whatsapp_opt_outs.length;
  db.whatsapp_opt_outs = db.whatsapp_opt_outs.filter((o) => o.phone !== phone);
  if (db.whatsapp_opt_outs.length === before) throw httpError(404, 'Number is not on the opt-out list');
  return { success: true, message: 'Customer will get broadcasts again' };
});

// ── routes: message templates ───────────────────────────────
const templateNotFound = () => httpError(404, 'Template not found');
const notConnected = () => conflict('Connect the Meta WhatsApp Business account first (WhatsApp settings).', { code: 'whatsapp_not_connected' });

r('GET', '/api/v1/broadcast/templates', ({ db }) => {
  const data = sortTemplates(liveTemplates(db)).map(clean);
  return { success: true, message: 'Templates fetched', total_records: data.length, data };
});

r('POST', '/api/v1/broadcast/templates/add', ({ db, body, user }) => {
  const fields = readTemplate(body || {});
  if (typeof fields === 'string') throw bad(fields);
  const problem = templateTextProblem(fields);
  if (problem) throw bad(problem);
  if (fields.body.includes(NAME_TAG) && !fields.sample_name) fields.sample_name = DEFAULT_SAMPLE_NAME;
  if (nameTaken(db, fields.name, fields.language)) throw conflict(`A template called ${fields.name} (${fields.language}) already exists`);

  const now = nowIso();
  const row = {
    id: nextId('whatsapp_templates'),
    ...fields,
    status: 'draft',
    meta_template_id: null,
    rejection_reason: null,
    submitted_at: null,
    created_by: actorName(user),
    updated_by: actorName(user),
    is_deleted: 0,
    created_at: now,
    updated_at: now,
  };
  db.whatsapp_templates.push(row);
  return { status: 201, data: { success: true, message: 'Template saved', data: clean(row) } };
});

r('PUT', '/api/v1/broadcast/templates/update/:id', ({ db, params, body, user }) => {
  const existing = findTemplate(db, params.id);
  if (!existing) throw templateNotFound();
  if (existing.status === 'pending') throw conflict('This message is in review at Meta. Wait for the answer before changing it.');

  const fields = readTemplate(body || {}, true);
  if (typeof fields === 'string') throw bad(fields);
  for (const key of Object.keys(fields)) if (fields[key] === existing[key]) delete fields[key];
  if (!Object.keys(fields).length) throw bad('Nothing changed');
  if (existing.submitted_at && (fields.name || fields.language)) {
    throw bad("The name and language can't change after sending to Meta. Create a new template instead.");
  }
  const next = { ...existing, ...fields };
  const problem = templateTextProblem(next);
  if (problem) throw bad(problem);
  if (next.body.includes(NAME_TAG) && !next.sample_name) fields.sample_name = DEFAULT_SAMPLE_NAME;
  if ((fields.name || fields.language) && nameTaken(db, next.name, next.language, existing.id)) {
    throw conflict(`A template called ${next.name} (${next.language}) already exists`);
  }
  const scheduled = usedBy(db, existing.id).filter((b) => b.status === 'scheduled');
  if (scheduled.length) throw conflict(usedByMessage(scheduled, 'Change that broadcast back to a draft first.'));

  const wasReviewed = REVIEWED.includes(existing.status);
  if (wasReviewed) Object.assign(fields, { status: 'draft', rejection_reason: null });
  fields.updated_by = actorName(user);
  updateTemplate(db, existing, fields);
  return {
    success: true,
    message: wasReviewed ? 'Template updated. It needs Meta approval again.' : 'Template updated',
    data: clean(existing),
  };
});

r('PUT', '/api/v1/broadcast/templates/delete/:id', ({ db, params }) => {
  const existing = findTemplate(db, params.id);
  if (!existing) throw templateNotFound();
  const used = usedBy(db, existing.id);
  if (used.length) throw conflict(usedByMessage(used, 'Delete that broadcast or pick another message for it first.'));
  existing.is_deleted = 1;
  return { success: true, message: 'Template deleted' };
});

// "Send to Meta": simulated, it goes into review and is approved a little later
r('POST', '/api/v1/broadcast/templates/submit/:id', ({ db, params, user }) => {
  const existing = findTemplate(db, params.id);
  if (!existing) throw templateNotFound();
  if (!['draft', 'rejected'].includes(existing.status)) {
    throw conflict(`This template is already ${existing.status === 'pending' ? 'in review' : existing.status}`);
  }
  const problem = templateTextProblem(existing);
  if (problem) throw bad(problem);
  if (!connected(db)) throw notConnected();

  updateTemplate(db, existing, {
    status: 'pending',
    meta_template_id: existing.meta_template_id || `90000000000${String(existing.id).padStart(4, '0')}`,
    submitted_at: nowIso(),
    rejection_reason: null,
    updated_by: actorName(user),
    _demo_hold: false,
  });
  return { success: true, message: 'Sent to Meta for review', data: clean(existing) };
});

// "Check Meta status": approves templates submitted a few seconds ago or more
r('POST', '/api/v1/broadcast/templates/sync', ({ db }) => {
  if (!connected(db)) throw notConnected();
  const changed = approveReviewed(db, SYNC_APPROVES_AFTER_MS);
  const data = sortTemplates(liveTemplates(db)).map(clean);
  return {
    success: true,
    message: changed ? `${changed} template${changed === 1 ? '' : 's'} updated from Meta` : 'Everything is up to date',
    total_records: data.length,
    data,
  };
});

// Test send: checks like the real one, but nothing is sent anywhere
r('POST', '/api/v1/broadcast/templates/test/:id', ({ db, params, body }) => {
  const existing = findTemplate(db, params.id);
  if (!existing) throw templateNotFound();
  if (existing.status !== 'approved') throw bad('Only a message Meta has approved can be sent');
  const phone = toWhatsAppNumber(body?.phone);
  if (!phone) throw bad('phone is not a valid WhatsApp number');
  if (!connected(db)) throw notConnected();
  return { success: true, message: `Test sent to +${phone}`, data: { message_id: `wamid.DEMOTEST${Date.now()}`, phone } };
});
