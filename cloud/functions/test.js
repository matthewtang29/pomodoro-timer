// Tests for the cloud functions. Run from this folder:   node test.js
// No test framework and no npm install needed: the Firebase and web-push modules are
// replaced with small fakes, so nothing here talks to the network or the real project.
// Not deployed (cloud/firebase.json ignores this file).

const Module = require('module');

// ---------------------------------------------------------------- fakes
const fake = {
  docs: new Map(),   // path -> data (the fake Firestore)
  enqueued: [],      // Cloud Tasks scheduled
  pushes: [],        // Web Push messages sent
  reset() { this.docs.clear(); this.enqueued = []; this.pushes = []; },
};
const docRef = path => ({
  path,
  delete: async () => { fake.docs.delete(path); },
  get: async () => ({ exists: fake.docs.has(path), data: () => fake.docs.get(path) }),
});
const db = {
  doc: docRef,
  collection: prefix => ({
    get: async () => ({
      docs: [...fake.docs].filter(([p]) => p.startsWith(prefix + '/')).map(([p, d]) => ({ id: p.split('/').pop(), ref: docRef(p), data: () => d })),
    }),
  }),
  runTransaction: async fn => fn({
    get: async ref => ({ exists: fake.docs.has(ref.path), data: () => fake.docs.get(ref.path) }),
    set: (ref, data) => { fake.docs.set(ref.path, data); },
  }),
};
const stubs = {
  'firebase-functions/v2': { setGlobalOptions() {}, logger: { warn() {}, error() {}, info() {} } },
  'firebase-functions/v2/firestore': { onDocumentWritten: (opts, fn) => fn },
  'firebase-functions/v2/tasks': { onTaskDispatched: (opts, fn) => fn },
  'firebase-functions/v2/https': { onRequest: (opts, fn) => fn },
  'firebase-functions/params': { defineSecret: () => ({ value: () => 'test-secret' }) },
  'firebase-admin/app': { initializeApp() {} },
  'firebase-admin/firestore': { getFirestore: () => db },
  'firebase-admin/functions': { getFunctions: () => ({ taskQueue: () => ({ enqueue: async (data, opts) => { fake.enqueued.push({ data, opts }); } }) }) },
  'web-push': { setVapidDetails() {}, sendNotification: async (sub, payload) => { fake.pushes.push(JSON.parse(payload)); } },
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  return Object.prototype.hasOwnProperty.call(stubs, request) ? stubs[request] : realLoad.call(this, request, ...rest);
};

process.env.POMEGRANATE_TEST = '1';
const fns = require('./index.js');
const { _buildCalendar: buildCalendar, _upcomingAlerts: upcomingAlerts, _validState: validState, _checkLimit: checkLimit, _LIMITS: LIMITS } = fns;

// ---------------------------------------------------------------- tiny runner
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
}
const MIN = 60000;
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
// a custom session as localtimer.js start() writes it, 25/5 x 4, in focus with 10 min left
const session = over => ({
  st: 'FOCUS', pausedFrom: 'FOCUS', auto: false, focus: 25, brk: 5, cycles: 4, cycle: 1, done: 0, total: 0,
  phaseEnd: NOW + 10 * MIN, pausedLeft: 0, screenEnd: 0, sessionStart: NOW - 15 * MIN, owner: 'dev1', kind: 'local', changed: NOW,
  ...over,
});
const writeEvent = (docId, after, uid = 'u1') => ({ params: { uid, docId }, data: { after: { data: () => after } } });

async function main() {
  // ---------------------------------------------------------------- upcomingAlerts
  {
    const a = upcomingAlerts(session());
    // 4 focus ends (the last is "session complete") + 3 breaks
    check('custom 4 cycles: 7 alerts', a.length === 7, a.length);
    check('first alert is focus done at phaseEnd', a[0].title.startsWith('Focus block done') && a[0].at === NOW + 10 * MIN, a[0]);
    check('last alert is session complete', a[a.length - 1].title.startsWith('Session complete'), a[a.length - 1]);
    check('alerts in time order', a.every((x, i) => i === 0 || x.at > a[i - 1].at));
    const b = a[1];
    check('break over after 2 s screen + 5 min break', b.title === 'Break over' && b.at === NOW + 10 * MIN + 2000 + 5 * MIN, b);
  }
  {
    const a = upcomingAlerts(session({ auto: true, cycles: 0 }));
    check('auto: focus done + break over, then waits', a.length === 2 && a[1].body === 'Start another cycle?', a);
  }
  {
    const a = upcomingAlerts(session({ cycle: 4, done: 3, total: 75 }));
    check('last cycle: only session complete', a.length === 1 && /4 focus blocks, 1h 40m/.test(a[0].body), a);
  }
  check('paused: nothing', upcomingAlerts(session({ st: 'PAUSED', pausedLeft: 5 * MIN })).length === 0);
  check('exited: nothing', upcomingAlerts({ st: 'EXITED', screenEnd: NOW }).length === 0);
  {
    const a = upcomingAlerts(session({ st: 'GETREADY', phaseEnd: NOW + 6000, cycle: 2, cycles: 2 }));
    check('get ready: focus starts at phaseEnd', a.length === 1 && a[0].at === NOW + 6000 + 25 * MIN, a);
  }
  {
    const a = upcomingAlerts(session({ focus: 99, brk: 99, cycles: 20 }));
    check('largest custom session stays under the 60-task cap', a.length === 39 && a.length <= 60, a.length);
  }


  // ---------------------------------------------------------------- calendar feed
  {
    const ics = buildCalendar([
      { id: 't1', title: 'Lab report, part 2; draft', due: '2026-11-25', project: 'ECE140', subtasks: [{ title: 'graphs', done: true }] },
      { id: 't2', title: 'Done one', due: '2026-11-25', done: NOW },
      { id: 't3', title: 'No date' },
      { id: 't4', deleted: true, u: NOW },
      { id: 't5', title: 'x'.repeat(200), due: '2026-12-31' },
    ], [
      { id: 'p1', day: '2026-11-16', title: 'Study', start: '09:00', end: '10:30', done: true },
      { id: 'p2', day: '2026-11-16', title: 'Late', start: '23:00', end: '00:30' },
      { id: 'p3', day: '2026-01-01', title: 'Too old', start: '09:00', end: '10:00' },
      { id: 'p4', day: '2026-11-16', title: 'Bad time', start: '9', end: '10:00' },
    ], NOW);
    const lines = ics.split('\r\n');
    check('feed: starts and ends as a calendar', lines[0] === 'BEGIN:VCALENDAR' && lines[lines.length - 2] === 'END:VCALENDAR' && lines[lines.length - 1] === '', lines.slice(-2));
    check('feed: CRLF line ends only', !/[^\r]\n/.test(ics));
    check('feed: lines at most 75 bytes', lines.every(l => Buffer.byteLength(l) <= 75), lines.find(l => Buffer.byteLength(l) > 75));
    const events = ics.match(/BEGIN:VEVENT/g) || [];
    check('feed: open dated tasks + recent valid blocks only (t1, t5, p1, p2)', events.length === 4, events.length);
    check('feed: task is all-day on its due date', ics.includes('DTSTART;VALUE=DATE:20261125\r\nDTEND;VALUE=DATE:20261126'));
    check('feed: text escaped', ics.includes('SUMMARY:Lab report\\, part 2\\; draft'));
    check('feed: project and subtasks in notes', ics.includes('DESCRIPTION:#ECE140\\n☑ graphs'));
    check('feed: year-end due rolls over', ics.includes('DTEND;VALUE=DATE:20270101'));
    check('feed: block at its local time', ics.includes('DTSTART:20261116T090000\r\nDTEND:20261116T103000\r\nSUMMARY:✓ Study'));
    check('feed: block past midnight ends next day', ics.includes('DTEND:20261117T003000'));
    const unfolded = ics.replace(/\r\n /g, '');
    check('feed: long title survives folding', unfolded.includes('SUMMARY:' + 'x'.repeat(200)));
  }
  {
    fake.reset();
    const KEY = 'a'.repeat(40);
    fake.docs.set('users/u1/calfeed/key', { key: KEY, created: NOW });
    fake.docs.set('users/u1/tasks/t1', { title: 'Essay', due: '2026-11-20' });
    const call = async query => {
      const res = { code: 0, body: '', headers: {} };
      res.status = c => { res.code = c; return res; };
      res.set = (h, v) => { res.headers[h] = v; return res; };
      res.send = b => { res.body = b; return res; };
      await fns.calendarFeed({ method: 'GET', query }, res);
      return res;
    };
    let r = await call({ u: 'u1', k: KEY });
    check('feed endpoint: right key gets the calendar', r.code === 200 && r.headers['Content-Type'].startsWith('text/calendar') && r.body.includes('SUMMARY:Essay'), r.code);
    r = await call({ u: 'u1', k: 'b'.repeat(40) });
    check('feed endpoint: wrong key is 404', r.code === 404 && !r.body.includes('Essay'), r.code);
    r = await call({ u: 'u2', k: KEY });
    check('feed endpoint: no feed set up is 404', r.code === 404, r.code);
    r = await call({ u: 'u1', k: 'short' });
    check('feed endpoint: malformed key is 404', r.code === 404, r.code);
    r = await call({ u: 'u1/../x', k: KEY });
    check('feed endpoint: malformed uid is 404', r.code === 404, r.code);
    for (let i = 0; i < LIMITS.feed.perMinute; i++) r = await call({ u: 'u1', k: KEY });
    check('feed endpoint: rate-limited after ' + LIMITS.feed.perMinute + ' a minute', r.code === 429, r.code);
  }

  // ---------------------------------------------------------------- validState
  check('valid: local session', validState(session(), NOW));
  check('valid: auto session', validState(session({ auto: true, cycles: 0, cycle: 7 }), NOW));
  check('valid: break', validState(session({ st: 'REST', phaseEnd: NOW + 3 * MIN }), NOW));
  check('valid: focus-done screen uses screenEnd', validState(session({ st: 'FOCUS_DONE', phaseEnd: 0, screenEnd: NOW + 2000 }), NOW));
  check('valid: paused (no phaseEnd needed)', validState(session({ st: 'PAUSED', phaseEnd: 0, pausedLeft: MIN }), NOW));
  // physical timer state, as livesync.js physical() builds it
  check('valid: physical timer', validState({
    kind: 'device', owner: 'dev1', changed: NOW, auto: false, focus: 30, brk: 10, cycles: 6, cycle: 2, done: 1, total: 30,
    sessionStart: NOW - 40 * MIN, st: 'REST', pausedFrom: 'FOCUS', phaseEnd: NOW + 8 * MIN, pausedLeft: 0, screenEnd: NOW + 2000,
  }, NOW));
  const bad = {
    'unknown state': session({ st: 'HACKED' }),
    'missing state': session({ st: undefined }),
    'focus 0': session({ focus: 0 }),
    'focus 100': session({ focus: 100 }),
    'focus as text': session({ focus: '25' }),
    'break 0': session({ brk: 0 }),
    'break 1000': session({ brk: 1000 }),
    'cycles 21': session({ cycles: 21 }),
    'cycles -1': session({ cycles: -1 }),
    'cycle NaN': session({ cycle: NaN }),
    'cycle missing': session({ cycle: undefined }),
    'cycle huge': session({ cycle: 1e9 }),
    'phaseEnd far future': session({ phaseEnd: NOW + 2 * 864e5 }),
    'phaseEnd far past': session({ phaseEnd: NOW - 2 * 864e5 }),
    'phaseEnd Infinity': session({ phaseEnd: Infinity }),
    'phaseEnd as text': session({ phaseEnd: String(NOW) }),
    'screenEnd missing in checkpoint': session({ st: 'CHECKPOINT', screenEnd: undefined }),
    'done negative': session({ done: -1 }),
    'not an object': 'FOCUS',
    'null': null,
  };
  for (const [name, s] of Object.entries(bad)) check('invalid: ' + name, !validState(s, NOW), s);

  // ---------------------------------------------------------------- checkLimit
  {
    const L = { perMinute: 3, perHour: 5 };
    let times = [], oks = [];
    for (let i = 0; i < 4; i++) { const r = checkLimit(times, NOW + i * 1000, L); oks.push(r.ok); times = r.times; }
    check('per minute: 3 allowed, 4th blocked', oks.join() === 'true,true,true,false', oks);
    check('a minute later: allowed again', checkLimit(times, NOW + 62000, L).ok);
    let t2 = [];
    const okHour = [];
    for (let i = 0; i < 6; i++) { const r = checkLimit(t2, NOW + i * 2 * MIN, L); okHour.push(r.ok); t2 = r.times; }
    check('per hour: 5 allowed, 6th blocked', okHour.join() === 'true,true,true,true,true,false', okHour);
    check('stored times capped', t2.length <= L.perHour + 1, t2.length);
    check('an hour later: allowed again', checkLimit(t2, NOW + 12 * MIN + 3600e3, L).ok);
    check('junk times ignored', checkLimit(['x', null, NaN, NOW + 864e5], NOW, L).ok);
    check('not a list: treated as empty', checkLimit('junk', NOW, L).ok);
    // normal use never comes close: start, pause, resume x5, exit in one minute
    let t3 = [], allOk = true;
    for (let i = 0; i < 12; i++) { const r = checkLimit(t3, NOW + i * 5000, LIMITS.timer); allOk = allOk && r.ok; t3 = r.times; }
    check('12 timer changes in a minute: all allowed', allOk);
  }

  // ---------------------------------------------------------------- scheduleTimerAlerts (with the fakes)
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    fake.reset();
    await fns.scheduleTimerAlerts(writeEvent('timer', { s: session(), rev: 'abc123', by: 'dev1', updated: NOW }));
    check('valid write schedules 7 tasks', fake.enqueued.length === 7, fake.enqueued.length);
    check('task ids use rev', fake.enqueued[0] && fake.enqueued[0].opts.id === 'abc123-0', fake.enqueued[0]);
    check('counter written', Array.isArray((fake.docs.get('users/u1/limits/timer') || {}).times));

    fake.reset();
    await fns.scheduleTimerAlerts(writeEvent('timer', { s: session({ focus: 5000 }), rev: 'abc123' }));
    check('invalid state: nothing scheduled, no counter', fake.enqueued.length === 0 && !fake.docs.has('users/u1/limits/timer'));

    fake.reset();
    await fns.scheduleTimerAlerts(writeEvent('timer', { s: session(), rev: 'bad rev/../x' }));
    check('bad rev: nothing scheduled', fake.enqueued.length === 0);

    fake.reset();
    await fns.scheduleTimerAlerts(writeEvent('timer', { s: session({ st: 'PAUSED', pausedLeft: MIN }), rev: 'p1' }));
    check('paused: nothing scheduled, not counted', fake.enqueued.length === 0 && !fake.docs.has('users/u1/limits/timer'));

    fake.reset();
    for (let i = 0; i < LIMITS.timer.perMinute + 5; i++) {
      await fns.scheduleTimerAlerts(writeEvent('timer', { s: session(), rev: 'r' + i }));
    }
    const revs = new Set(fake.enqueued.map(e => e.data.rev));
    check(`rate limit: only ${LIMITS.timer.perMinute} writes a minute scheduled`, revs.size === LIMITS.timer.perMinute, revs.size);
    await fns.scheduleTimerAlerts(writeEvent('timer', { s: session(), rev: 'other' }, 'u2'));
    check('rate limit is per user', fake.enqueued.some(e => e.data.uid === 'u2'));

    fake.reset();
    fake.docs.set('users/u1/push/dev1', { sub: { endpoint: 'https://push.example/1' } });
    for (let i = 0; i < LIMITS.test.perMinute + 3; i++) await fns.scheduleTimerAlerts(writeEvent('test', { at: NOW, by: 'dev1' }));
    check(`test alerts: ${LIMITS.test.perMinute} a minute`, fake.pushes.length === LIMITS.test.perMinute, fake.pushes.length);

    fake.reset();
    fake.docs.set('users/u1/push/dev1', { sub: { endpoint: 'https://push.example/1' } });
    await fns.scheduleTimerAlerts(writeEvent('test', { at: NOW - 5 * MIN }));
    await fns.scheduleTimerAlerts(writeEvent('test', { at: 'now' }));
    await fns.scheduleTimerAlerts(writeEvent('test', { at: NOW + 5 * MIN }));
    check('old, future or malformed test writes: nothing sent', fake.pushes.length === 0, fake.pushes.length);
  } finally {
    Date.now = realNow;
  }

  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.log('ERROR', e && e.stack || e); process.exitCode = 1; });
