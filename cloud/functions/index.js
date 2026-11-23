// Pomegranate cloud functions: send "focus done" / "break over" / "session complete"
// alerts to every signed-in device, even when the app is closed, and serve a calendar feed
// of your tasks (calendarFeed, near the end).
//
// How it works
// 1. Whenever a session is started, paused, resumed, exited or continued, the app
//    writes the session to users/{uid}/live/timer (see livesync.js).
// 2. scheduleTimerAlerts works out every upcoming focus/break ending from that
//    state (the same rules as the app's built-in timer) and schedules one Cloud
//    Task per alert, at the exact time.
// 3. When a task runs, sendTimerAlert checks the session hasn't changed since
//    (paused, exited...) and sends a Web Push alert to each device in users/{uid}/push.
//
// Writing users/{uid}/live/test sends a test alert straight away.
//
// Abuse guards (sign-in is open to any Google account, and tasks cost money past the free
// allowance): a timer write is only used if its state looks like one the app makes
// (validState), and each user may schedule alerts / send test alerts only so often
// (LIMITS, counted in users/{uid}/limits/{timer|test}).

const { setGlobalOptions, logger } = require('firebase-functions/v2');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getFunctions } = require('firebase-admin/functions');
const webpush = require('web-push');

// Must be the location of your Firestore database (Firebase console → Firestore → the
// location shown at the top). "nam5" (United States) → us-central1; "eur3" → europe-west1;
// a single region like northamerica-northeast1 → that same name.
const REGION = 'us-central1';

// The public half matches VAPID_PUBLIC in push.js. The private half is a secret:
//   firebase functions:secrets:set VAPID_PRIVATE_KEY
const VAPID_PUBLIC = 'BIdsimzWVAM035hZfFhbcLFL66kWxrr54FMr1Cwmj2jUKFckx61Pd55DSURrK5KkTrN1JPRnrBvqCmqPlRUllLM';
const VAPID_PRIVATE = defineSecret('VAPID_PRIVATE_KEY');
const VAPID_SUBJECT = 'https://github.com/matthewtang29';

setGlobalOptions({ region: REGION, maxInstances: 5 });
initializeApp();
const db = getFirestore();

// Timer constants: keep in step with localtimer.js
const GET_READY_MS = 6000;
const FOCUS_DONE_MS = 2000;
const CHECKPOINT_MS = 1500;

function fmtDuration(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

// Every alert still to come for a session state, as [{ at, title, body }].
// Follows the built-in timer's rules exactly (localtimer.js → advance).
function upcomingAlerts(state) {
  const s = { ...state };
  const out = [];
  let st = s.st;
  for (let guard = 0; guard < 200; guard++) {
    if (st === 'GETREADY') {
      const at = s.phaseEnd;
      s.phaseEnd = at + s.focus * 60000;
      st = 'FOCUS';
    } else if (st === 'FOCUS') {
      const at = s.phaseEnd;
      s.done = (s.done || 0) + 1;
      s.total = (s.total || 0) + s.focus;
      if (!s.auto && s.cycle >= s.cycles) {
        out.push({ at, title: 'Session complete ✅',
          body: `${s.done} focus block${s.done === 1 ? '' : 's'}, ${fmtDuration(s.total)} of focus. Well done!` });
        break;
      }
      out.push({ at, title: 'Focus block done 🎉', body: `Time for a ${s.brk}-minute break.` });
      s.screenEnd = at + FOCUS_DONE_MS;
      st = 'FOCUS_DONE';
    } else if (st === 'FOCUS_DONE') {
      const at = s.screenEnd;
      s.phaseEnd = at + s.brk * 60000;
      st = 'REST';
    } else if (st === 'REST') {
      const at = s.phaseEnd;
      out.push(s.auto
        ? { at, title: 'Break over', body: 'Start another cycle?' }
        : { at, title: 'Break over', body: `Back to focus (cycle ${Math.min(s.cycle + 1, s.cycles)} of ${s.cycles}).` });
      s.screenEnd = at + CHECKPOINT_MS;
      st = 'CHECKPOINT';
    } else if (st === 'CHECKPOINT') {
      if (s.auto) break;   // waits for you to answer "start another cycle?"
      const at = s.screenEnd;
      s.cycle++;
      s.phaseEnd = at + GET_READY_MS;
      st = 'GETREADY';
    } else {
      break;   // paused, waiting, or finished: nothing scheduled
    }
  }
  return out;
}

// ---------------------------------------------------------------- checks
// Every state the app can write to live/timer (localtimer.js, and livesync.js physical()
// for a physical timer). Only the first five have alerts still to come; the rest
// (paused, waiting at "continue?", finished) schedule nothing.
const SCHEDULING_STATES = ['GETREADY', 'FOCUS', 'FOCUS_DONE', 'REST', 'CHECKPOINT'];
const KNOWN_STATES = [...SCHEDULING_STATES, 'PAUSED', 'CONTINUE', 'ENDED', 'EXITED', 'SUMMARY', 'MENU'];
const DAY_MS = 864e5;

// Is s a session state the app could have written, close enough to now to act on?
// Limits match the app: focus and break 1–99 minutes, 0–20 cycles (0 = auto mode).
function validState(s, now) {
  if (!s || typeof s !== 'object' || !KNOWN_STATES.includes(s.st)) return false;
  const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  const near = v => Number.isFinite(v) && Math.abs(v - now) <= DAY_MS;
  const optCount = v => v == null || inRange(v, 0, 1e6);
  if (!inRange(s.focus, 1, 99) || !inRange(s.brk, 1, 99) || !inRange(s.cycles, 0, 20)) return false;
  if (!inRange(s.cycle, 0, 1000)) return false;   // auto mode counts cycles up with no set end
  if (!optCount(s.done) || !optCount(s.total)) return false;
  // the end of the current phase (or of the short screen between phases)
  if (['GETREADY', 'FOCUS', 'REST'].includes(s.st) && !near(s.phaseEnd)) return false;
  if (['FOCUS_DONE', 'CHECKPOINT'].includes(s.st) && !near(s.screenEnd)) return false;
  return true;
}
// rev becomes part of each Cloud Task id (livesync.js newId(): base36)
const validRev = rev => typeof rev === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(rev);

// ---------------------------------------------------------------- rate limits
// Per user and kind, at most perMinute uses in any 60 s and perHour in any hour. Only
// writes that would schedule alerts count (pause, exit... schedule nothing, so they're free).
// timer: normal use is a handful of writes a minute at most (start, pause, resume, exit;
// a physical timer also writes each phase change), so 30 can't be reached by hand. A
// blocked write isn't scheduled; the next allowed one schedules from the newest state.
// Every attempt is recorded, blocked ones too, so a script that keeps writing stays blocked.
const LIMITS = {
  timer: { perMinute: 30, perHour: 300 },
  test: { perMinute: 5, perHour: 30 },
};

// times: when it was used before (ms). Returns whether this use is allowed, and the
// times to store (the last hour only, at most perHour + 1 of them).
function checkLimit(times, now, limit) {
  const recent = (Array.isArray(times) ? times : [])
    .filter(t => Number.isFinite(t) && t > now - 3600e3 && t <= now + 60000);
  const lastMinute = recent.filter(t => t > now - 60000).length;
  const ok = lastMinute < limit.perMinute && recent.length < limit.perHour;
  recent.push(now);
  return { ok, times: recent.slice(-(limit.perHour + 1)) };
}

// Counts one use in users/{uid}/limits/{name}. If the count can't be updated (e.g. many
// writes at once keep colliding), it throws and nothing is sent: blocked rather than let through.
async function allowed(uid, name) {
  const ref = db.doc(`users/${uid}/limits/${name}`);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const { ok, times } = checkLimit(snap.exists ? snap.data().times : [], Date.now(), LIMITS[name]);
    tx.set(ref, { times });
    return ok;
  });
}

async function sendToAllDevices(uid, payload) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE.value());
  const devices = await db.collection(`users/${uid}/push`).get();
  await Promise.all(devices.docs.map(async d => {
    try {
      await webpush.sendNotification(d.data().sub, JSON.stringify(payload), { TTL: 600, urgency: 'high' });
    } catch (e) {
      // 404/410: that device unsubscribed or the app was removed; forget it
      if (e.statusCode === 404 || e.statusCode === 410) await d.ref.delete();
      else logger.warn('push failed', { device: d.id, status: e.statusCode, body: e.body });
    }
  }));
}

exports.scheduleTimerAlerts = onDocumentWritten(
  { document: 'users/{uid}/live/{docId}', secrets: [VAPID_PRIVATE] },
  async event => {
    const after = event.data && event.data.after && event.data.after.data();
    if (!after) return;
    const { uid, docId } = event.params;

    if (docId === 'test') {
      if (!Number.isFinite(after.at) || Math.abs(Date.now() - after.at) > 60000) return;
      if (!await allowed(uid, 'test')) { logger.warn('test alert rate-limited', { uid }); return; }
      await sendToAllDevices(uid, {
        title: 'Test alert ✅', body: 'Pomegranate alerts are working on this device.', tag: 'pomegranate-test', test: true,
      });
      return;
    }
    if (docId !== 'timer' || !after.s || !after.rev) return;

    const now = Date.now();
    if (!validRev(after.rev) || !validState(after.s, now)) return;
    const alerts = upcomingAlerts(after.s).filter(a => a.at > now - 5000).slice(0, 60);
    if (!alerts.length) return;
    if (!await allowed(uid, 'timer')) { logger.warn('timer alerts rate-limited', { uid }); return; }
    const queue = getFunctions().taskQueue(`locations/${REGION}/functions/sendTimerAlert`);
    await Promise.all(alerts.map((a, i) => queue.enqueue(
      { uid, rev: after.rev, title: a.title, body: a.body },
      { scheduleTime: new Date(Math.max(a.at, now + 1000)), id: `${after.rev}-${i}` },
    ).catch(e => {
      if (!/already-exists/.test(e.code || '')) logger.error('could not schedule alert', e);
    })));
  },
);

exports.sendTimerAlert = onTaskDispatched(
  { secrets: [VAPID_PRIVATE], retryConfig: { maxAttempts: 3, minBackoffSeconds: 5 }, rateLimits: { maxConcurrentDispatches: 20 } },
  async req => {
    const { uid, rev, title, body } = req.data || {};
    if (!uid || !rev) return;
    // the session changed since this was scheduled (paused, exited, restarted): skip it
    const live = await db.doc(`users/${uid}/live/timer`).get();
    if (!live.exists || live.data().rev !== rev) return;
    await sendToAllDevices(uid, { title, body, tag: 'pomodoro-timer' });
  },
);

// ---------------------------------------------------------------- calendar feed
// A read-only calendar of your open tasks (all-day, on their due date) and your Plan your day
// blocks (at their times), for Apple Calendar or any app that can subscribe to a calendar.
//
// The link is  .../calendarFeed?u={uid}&k={key}. The key is a long random string the app makes
// and saves in users/{uid}/calfeed/key (⚙ Settings → Sync → Calendar feed). Anyone with the link
// can read the calendar, so Reset there makes a new key and the old link stops working.
// Calendar apps fetch the link every 5 minutes to an hour; LIMITS.feed caps how often.
//
// Times are "floating" (no time zone): a block at 09:00 shows at 09:00 wherever you are, the same
// way the app shows it.

const { onRequest } = require('firebase-functions/v2/https');
const crypto = require('crypto');
LIMITS.feed = { perMinute: 10, perHour: 120 };
const FEED_PAST_DAYS = 60;   // Plan your day blocks older than this are left out

const validUid = u => typeof u === 'string' && /^[A-Za-z0-9]{1,128}$/.test(u);
const validKey = k => typeof k === 'string' && /^[A-Za-z0-9]{32,64}$/.test(k);
function sameKey(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Text value: escape \ ; , and new lines (RFC 5545 3.3.11)
const icsText = s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Lines longer than 75 bytes continue on the next line after a space (RFC 5545 3.1)
function fold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const isDay = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const isTime = t => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t);
const icsDate = d => d.replace(/-/g, '');
function addDays(d, n) {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
const icsStamp = ms => new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

// tasks, plan: the docs' data with their ids as { id, ...data }. now: ms (for DTSTAMP and the cut-off).
function buildCalendar(tasks, plan, now) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pomegranate//Calendar feed//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'X-WR-CALNAME:Pomegranate', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M'];
  const stamp = icsStamp(now);
  for (const t of tasks) {
    if (t.deleted || t.done || typeof t.title !== 'string' || !isDay(t.due)) continue;
    const notes = [];
    if (t.project) notes.push('#' + t.project);
    const subs = Array.isArray(t.subtasks) ? t.subtasks.filter(s => s && typeof s.title === 'string') : [];
    subs.forEach(s => notes.push((s.done ? '☑ ' : '☐ ') + s.title));
    L.push('BEGIN:VEVENT', `UID:task-${t.id}@pomegranate`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(t.due)}`, `DTEND;VALUE=DATE:${icsDate(addDays(t.due, 1))}`,
      `SUMMARY:${icsText(t.title)}`, 'TRANSP:TRANSPARENT');   // all-day tasks don't make you look busy
    if (notes.length) L.push(`DESCRIPTION:${icsText(notes.join('\n'))}`);
    L.push('END:VEVENT');
  }
  const cutoff = new Date(now - FEED_PAST_DAYS * DAY_MS).toISOString().slice(0, 10);
  for (const b of plan) {
    if (b.deleted || typeof b.title !== 'string' || !isDay(b.day) || b.day < cutoff || !isTime(b.start) || !isTime(b.end)) continue;
    const endDay = b.end <= b.start ? addDays(b.day, 1) : b.day;   // runs past midnight
    L.push('BEGIN:VEVENT', `UID:plan-${b.id}@pomegranate`, `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(b.day)}T${b.start.replace(':', '')}00`, `DTEND:${icsDate(endDay)}T${b.end.replace(':', '')}00`,
      `SUMMARY:${icsText((b.done ? '✓ ' : '') + b.title)}`, 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

exports.calendarFeed = onRequest({ cors: false, memory: '256MiB', maxInstances: 3 }, async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(405).send('Method not allowed'); return; }
  const { u, k } = req.query || {};
  if (!validUid(u) || !validKey(k)) { res.status(404).send('Not found'); return; }
  const keyDoc = await db.doc(`users/${u}/calfeed/key`).get();
  if (!keyDoc.exists || !sameKey(keyDoc.data().key, k)) { res.status(404).send('Not found'); return; }
  if (!await allowed(u, 'feed')) { res.set('Retry-After', '600').status(429).send('Too many requests'); return; }
  // Each doc read is billed (50,000 a day free), and calendar apps fetch often, so only read what
  // can appear: tasks with a due date (not undated ones or deletion markers) and recent blocks.
  // Both are single-field queries, which Firestore indexes by itself.
  const cutoff = new Date(Date.now() - FEED_PAST_DAYS * DAY_MS).toISOString().slice(0, 10);
  const docs = async q => (await q.get()).docs.map(d => ({ ...d.data(), id: d.id }));
  const [tasks, plan] = await Promise.all([
    docs(db.collection(`users/${u}/tasks`).where('due', '!=', null)),
    docs(db.collection(`users/${u}/plan`).where('day', '>=', cutoff)),
  ]);
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="pomegranate.ics"');
  res.set('Cache-Control', 'private, max-age=300');
  res.status(200).send(buildCalendar(tasks, plan, Date.now()));
});

if (process.env.POMEGRANATE_TEST) {   // for tests (test.js)
  exports._buildCalendar = buildCalendar;
  exports._upcomingAlerts = upcomingAlerts;
  exports._validState = validState;
  exports._checkLimit = checkLimit;
  exports._LIMITS = LIMITS;
}
