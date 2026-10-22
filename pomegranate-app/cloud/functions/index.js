// Pomegranate cloud functions: send "focus done" / "break over" / "session complete"
// alerts to every signed-in device, even when the app is closed.
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
      if (Date.now() - (after.at || 0) > 60000) return;
      await sendToAllDevices(uid, {
        title: 'Test alert ✅', body: 'Pomegranate alerts are working on this device.', tag: 'pomegranate-test', test: true,
      });
      return;
    }
    if (docId !== 'timer' || !after.s || !after.rev) return;

    const now = Date.now();
    const alerts = upcomingAlerts(after.s).filter(a => a.at > now - 5000).slice(0, 60);
    if (!alerts.length) return;
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

if (process.env.POMEGRANATE_TEST) exports._upcomingAlerts = upcomingAlerts;   // for tests
