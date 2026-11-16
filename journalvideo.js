// ================================================================= VIDEO JOURNAL
// Press Record in the Journal, talk, press Stop: the clip is saved to that day's entry.
// - The video stays on this device, in IndexedDB ('pomegranate-media'). It is never put in
//   localStorage, the service worker cache or the cloud.
// - Only the clip's details ({ id, at, dur, size, mime, device, devName }) go on the journal
//   entry, so they sync with it and show on other devices as "recorded on another device".
// - Crash safety: every second of recording is written to the 'chunks' store as it arrives.
//   A clip that never got its Stop (reload, crash, battery) is put back together on the next start.

const JournalVideo = (() => {
  const DB_NAME = 'pomegranate-media';
  const MAX_MS = 15 * 60 * 1000;           // hard cap per clip (~120 MB at the bit rates below)
  const MIN_FREE = 200 * 1048576;          // refuse to start with less room than this
  const HIDDEN_STOP_MS = 4000;             // app in the background this long: stop and save
  const MAX_PER_DAY = 50;                  // the cloud rules accept up to 50 clips on an entry
  const UNDO_MS = 6500;                    // a little longer than the Undo toast
  const VIDEO_TYPES = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const AUDIO_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];

  // stored clips play wherever IndexedDB works; recording also needs the camera APIs
  const canStore = !!window.indexedDB;
  const supported = canStore && !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  // ---------------------------------------------------------------- IndexedDB
  // videos: clip id -> { blob, id, date, at, dur, size, mime, trash? }
  //   (the Blob plus its date, so a clip whose details were lost, e.g. by a restore, can be
  //   put back on its day; trash = deleted, waiting out the Undo)
  // chunks: auto key -> { rec, date, at, t, mime, data: Blob }, indexed by rec (the clip id)
  let dbP = null;
  function db() {
    if (!dbP) {
      dbP = new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('videos')) d.createObjectStore('videos');
          if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { autoIncrement: true }).createIndex('rec', 'rec');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      dbP.catch(() => { dbP = null; });
    }
    return dbP;
  }
  // runs fn(stores...) in one transaction; resolves with fn's result once it has committed
  async function tx(names, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(names, mode);
      let out;
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('storage write cancelled'));
      out = fn(...names.map(n => t.objectStore(n)));
    });
  }
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const getRec = id => tx(['videos'], 'readonly', s => reqP(s.get(id)));

  // clip id -> size, for clips whose video is on this device (not counting deleted ones)
  const held = new Map();
  let heldLoaded = false;
  async function loadHeld() {
    held.clear();
    await tx(['videos'], 'readonly', s => {
      s.openCursor().onsuccess = e => {
        const c = e.target.result;
        if (!c) return;
        if (!c.value.trash) held.set(c.key, c.value.size || (c.value.blob && c.value.blob.size) || 0);
        c.continue();
      };
    });
    heldLoaded = true;
  }
  // true / false, or null while not known yet (used by sync.js before trusting a missing clip)
  function holds(id) { return heldLoaded ? held.has(id) : null; }

  // ---------------------------------------------------------------- clip details on the entry
  function clipsOf(k) { const e = journalEntry(k); return e && Array.isArray(e.videos) ? e.videos.filter(v => v && v.id) : []; }
  function totalDur(k) { return clipsOf(k).reduce((a, v) => a + (v.dur || 0), 0); }
  function fmtLen(ms) {
    const s = Math.round((ms || 0) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }
  function fmtSize(b) { return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((b || 0) / 1024))} KB`; }
  const isAudio = v => /^audio\//.test(v.mime || '');
  function ext(mime) { return /mp4/.test(mime) ? (/^audio/.test(mime) ? 'm4a' : 'mp4') : 'webm'; }

  // Adds a clip to its day through the normal journal save, so it syncs like any edit.
  // A clip on its own is a full entry (no rating or text needed).
  function attach(date, meta) {
    let e = journalEntry(date);
    if (!e) e = journal.entries[date] = { rating: null, text: '', updated: Date.now() };
    const list = Array.isArray(e.videos) ? e.videos.filter(v => v && v.id !== meta.id) : [];
    list.push(meta);
    list.sort((a, b) => (a.at || 0) - (b.at || 0));
    e.videos = list;
    e.updated = Date.now();
    saveJournal();
  }
  function detach(date, id) {
    const e = journalEntry(date);
    if (!e || !Array.isArray(e.videos)) return null;
    const meta = e.videos.find(v => v && v.id === id);
    if (!meta) return null;
    e.videos = e.videos.filter(v => v && v.id !== id);
    if (!e.videos.length) delete e.videos;
    if (!entryHasContent(e)) delete journal.entries[date];
    else e.updated = Date.now();
    saveJournal();
    return meta;
  }
  const metaOf = r => ({ id: r.id, at: r.at, dur: r.dur, size: r.size, mime: r.mime,
    device: typeof Sync !== 'undefined' ? Sync.deviceId : '', devName: typeof Sync !== 'undefined' ? Sync.deviceName : '' });

  // Clips held here whose details are missing from every entry (a restore replaced the journal,
  // or the app closed between saving the video and saving the entry) go back on their day.
  function reattach() {
    if (!canStore) return Promise.resolve(0);
    const known = new Set();
    Object.values(journal.entries).forEach(e => (Array.isArray(e.videos) ? e.videos : []).forEach(v => v && known.add(v.id)));
    let n = 0;
    return tx(['videos'], 'readonly', s => {
      const lost = [];
      s.openCursor().onsuccess = e => {
        const c = e.target.result;
        if (!c) return;
        const r = c.value;
        if (!r.trash && !known.has(r.id) && r.date) lost.push(r);
        c.continue();
      };
      return lost;
    }).then(lost => {
      lost.forEach(r => { attach(r.date, metaOf(r)); n++; });
      if (n) refresh();
      return n;
    }).catch(() => 0);
  }

  // ---------------------------------------------------------------- recording
  let rec = null;   // the recording in progress
  let pending = null;   // a stream waiting on "Record audio only?"

  const canType = t => { try { return MediaRecorder.isTypeSupported(t); } catch (e) { return false; } };
  // MP4 plays everywhere (iPhone included). Chrome and Edge only hand over MP4 at keyframes, so
  // a keyframe is asked for every second (videoKeyFrameIntervalDuration; other browsers ignore
  // it); without that the whole clip arrives at Stop and a crash would lose it. If MP4 still
  // arrives in one piece here, this browser records WebM from then on (remembered).
  const MP4_OFF = 'pomodoro-video-no-mp4';
  let noMp4 = false;
  try { noMp4 = localStorage.getItem(MP4_OFF) === navigator.userAgent; } catch (e) {}
  function pickType(audioOnly) {
    const list = audioOnly ? AUDIO_TYPES : noMp4 ? VIDEO_TYPES.slice(2).concat(VIDEO_TYPES.slice(0, 2)) : VIDEO_TYPES;
    return list.find(canType) || '';
  }

  async function freeSpace() {
    try {
      const est = await navigator.storage.estimate();
      if (est && est.quota > 0 && typeof est.usage === 'number') return est.quota - est.usage;
    } catch (e) {}
    return Infinity;   // unknown: let it try (a failed write still stops the recording cleanly)
  }

  async function start() {
    if (rec || !supported) return;
    clearNote();
    flushJournal();   // notes typed so far are saved first; the editor is locked while recording
    const date = jDate;
    if (clipsOf(date).length >= MAX_PER_DAY) { showNote(`A day can hold up to ${MAX_PER_DAY} clips.`); return; }
    if (await freeSpace() < MIN_FREE) {
      showNote('Not enough free storage to record (less than 200 MB left). Delete or download some clips, or free up space on this device.');
      return;
    }
    $('jvRecord').disabled = true;
    let stream = null, videoErr = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
    } catch (e) { videoErr = e; }
    if (stream) { $('jvRecord').disabled = false; begin(stream, false, date); return; }
    // no camera, or the camera is blocked: the microphone alone may still work
    let audio = null, audioErr = null;
    try { audio = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { audioErr = e; }
    $('jvRecord').disabled = false;
    if (audio) { offerAudio(audio, videoErr, date); return; }
    explainBlocked(videoErr, audioErr);
  }

  const denied = e => e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'PermissionDeniedError');
  function offerAudio(stream, videoErr, date) {
    pending = stream;
    const why = denied(videoErr) ? 'Camera access is blocked.' : videoErr && videoErr.name === 'NotReadableError' ? 'The camera is in use by another app.' : 'No camera was found.';
    const box = showNote(`${why} You can record audio only.`);
    const go = el('button', 'primary small', 'Record audio only');
    go.type = 'button';
    go.addEventListener('click', () => { pending = null; clearNote(); begin(stream, true, date); });
    const no = el('button', 'small', 'Cancel');
    no.type = 'button';
    no.addEventListener('click', () => { dropPending(); clearNote(); });
    const row = el('div', 'jv-note-btns');
    row.append(go, no);
    box.append(row);
    go.focus();
  }
  function dropPending() { if (pending) { pending.getTracks().forEach(t => t.stop()); pending = null; } }

  function explainBlocked(videoErr, audioErr) {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (denied(videoErr) || denied(audioErr)) {
      showNote(ios
        ? 'Camera and microphone are blocked. Open the iPhone Settings app, find Safari (or Pomegranate), and allow Camera and Microphone, then try again.'
        : 'Camera and microphone are blocked. Click the icon on the left of the address bar (on a phone: the site or app settings) and allow Camera and Microphone, then try again.');
    } else if (videoErr && videoErr.name === 'NotFoundError' && (!audioErr || audioErr.name === 'NotFoundError')) {
      showNote('No camera or microphone was found on this device.');
    } else {
      const e = audioErr || videoErr;
      showNote(`Couldn't start the camera or microphone${e && e.message ? ` (${e.message})` : ''}. Close other apps that may be using them and try again.`);
    }
  }

  function begin(stream, audioOnly, date) {
    const mime = pickType(audioOnly);
    let recorder;
    const opts = { audioBitsPerSecond: 64000 };
    if (!audioOnly) { opts.videoBitsPerSecond = 1000000; opts.videoKeyFrameIntervalDuration = 1000; }
    try { recorder = new MediaRecorder(stream, mime ? { ...opts, mimeType: mime } : opts); }
    catch (e) {
      try { recorder = new MediaRecorder(stream); }
      catch (e2) { stream.getTracks().forEach(t => t.stop()); showNote("This browser can't record here."); return; }
    }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const r = rec = {
      id, date, stream, recorder, audioOnly, at: Date.now(), lastT: Date.now(),
      mime: (recorder.mimeType || mime || (audioOnly ? 'audio/webm' : 'video/webm')),
      queue: Promise.resolve(), failed: null, stopping: null, saved: 0, timers: [], unlock: null,
    };
    // one recording at a time across windows; the app's start-up recovery waits for it
    try { navigator.locks.request('pomegranate-recording', {}, () => new Promise(res => { r.unlock = res; })).catch(() => {}); } catch (e) {}

    recorder.ondataavailable = e => {
      if (!e.data || !e.data.size) return;
      const t = Date.now();
      const chunk = { rec: id, date, at: r.at, t, mime: r.mime, data: e.data };
      r.queue = r.queue.then(() => r.failed ? null : tx(['chunks'], 'readwrite', s => { s.add(chunk); })
        .then(() => { r.saved = t; })
        .catch(err => {
          // stop without waiting here: stop() itself waits for this queue
          r.failed = err || new Error('write failed');
          setTimeout(() => stop('storage'), 0);
        }));
    };
    recorder.onerror = () => stop('error');
    stream.getTracks().forEach(t => t.addEventListener('ended', () => stop('ended')));
    try { recorder.start(1000); }
    catch (e) { stream.getTracks().forEach(t => t.stop()); rec = null; if (r.unlock) r.unlock(); showNote("Couldn't start recording."); return; }
    r.at = Date.now();
    r.timers.push(setTimeout(() => stop('limit'), MAX_MS));
    r.timers.push(setInterval(tick, 500));
    if (/mp4/.test(r.mime) && !audioOnly && VIDEO_TYPES.slice(2).some(canType)) {
      r.timers.push(setTimeout(() => { if (rec === r && !r.saved) { noMp4 = true; safeSetItem(MP4_OFF, navigator.userAgent); } }, 5000));
    }
    showRecording(r);
    syncWake();
  }

  // Stops and saves. Safe to call more than once; resolves when the clip is stored.
  function stop(reason) {
    const r = rec;
    if (!r) return Promise.resolve();
    if (r.stopping) return r.stopping;
    r.stopAt = Date.now();
    r.timers.forEach(t => { clearTimeout(t); clearInterval(t); });
    r.stopping = (async () => {
      await new Promise(res => {
        if (r.recorder.state === 'inactive') return res();
        r.recorder.addEventListener('stop', res, { once: true });
        try { r.recorder.stop(); } catch (e) { res(); }
        setTimeout(res, 3000);   // a recorder that never says it stopped
      });
      r.stream.getTracks().forEach(t => t.stop());   // camera light off
      rec = null;
      hideRecording();
      syncWake();
      await r.queue;
      let meta = null;
      try { meta = await finish(r.id); } catch (e) { r.failed = r.failed || e; }
      if (r.unlock) r.unlock();
      if (meta) {
        attach(r.date, meta);
        held.set(meta.id, meta.size);
      }
      if (r.failed) toast(meta ? `Storage is full or blocked, so recording stopped. The first ${fmtLen(meta.dur)} was saved.` : "Couldn't save the recording: storage is full or blocked.");
      else if (reason === 'limit') toast(`Clips stop at ${MAX_MS / 60000} minutes. Saved; press Record to keep going.`);
      else if (meta && reason !== 'user') toast('Recording stopped and saved');
      refresh();
      return meta;
    })();
    return r.stopping;
  }

  // Puts a clip's chunks together into one video and removes the chunks, in one transaction so
  // a crash leaves either the chunks or the finished clip, never both or neither.
  async function finish(id) {
    const chunks = await tx(['chunks'], 'readonly', s => {
      const out = [];
      s.index('rec').openCursor(IDBKeyRange.only(id)).onsuccess = e => {
        const c = e.target.result;
        if (!c) return;
        out.push({ key: c.primaryKey, v: c.value });
        c.continue();
      };
      return out;
    });
    if (!chunks.length) {
      const done = await getRec(id);   // finished already (by another stop, or recovery)
      return done ? metaOf(done) : null;
    }
    chunks.sort((a, b) => a.key - b.key);
    const first = chunks[0].v, last = chunks[chunks.length - 1].v;
    const type = (first.mime || '').split(';')[0] || 'video/webm';
    const blob = new Blob(chunks.map(c => c.v.data), { type });
    // the length is measured here, not read from the file: WebM from MediaRecorder has no duration
    const dur = Math.max(0, (finishing[id] || last.t) - first.at);
    const r = { blob, id, date: first.date, at: first.at, dur, size: blob.size, mime: type };
    await tx(['videos', 'chunks'], 'readwrite', (v, c) => {
      v.put(r, id);
      chunks.forEach(x => c.delete(x.key));
    });
    delete finishing[id];
    return metaOf(r);
  }
  const finishing = {};   // clip id -> the time Stop was pressed (more exact than the last chunk)

  // A clip that was recording when the app closed: put it back together and attach it.
  async function recover() {
    const chunks = await tx(['chunks'], 'readonly', s => reqP(s.getAll()));
    const ids = [...new Set(chunks.map(c => c.rec))];
    let n = 0;
    for (const id of ids) {
      try {
        const meta = await finish(id);
        if (meta) { attach(chunks.find(c => c.rec === id).date, meta); held.set(meta.id, meta.size); n++; }
      } catch (e) {}
    }
    return n;
  }

  // ---------------------------------------------------------------- deleting (with Undo)
  async function setTrash(ids, on) {
    await tx(['videos'], 'readwrite', s => {
      ids.forEach(id => {
        s.get(id).onsuccess = e => {
          const r = e.target.result;
          if (!r) return;
          if (on) r.trash = Date.now(); else delete r.trash;
          s.put(r, id);
        };
      });
    });
    ids.forEach(id => { if (on) held.delete(id); });
    if (!on) await loadHeld();
  }
  function removeForGood(ids) {
    return tx(['videos'], 'readwrite', s => {
      ids.forEach(id => { s.get(id).onsuccess = e => { const r = e.target.result; if (r && r.trash) s.delete(id); }; });
    }).catch(() => {});
  }
  // Marks clips deleted now and removes their video once the Undo has run out.
  // Returns undo(). Used for one clip and for a whole entry (journal.js deleteEntry).
  function trash(videos) {
    const ids = (Array.isArray(videos) ? videos : []).map(v => v && v.id).filter(id => id && held.has(id));
    if (!canStore || !ids.length) return () => {};
    let undone = false;
    ids.forEach(id => held.delete(id));
    setTrash(ids, true).catch(() => {});
    const timer = setTimeout(() => { if (!undone) removeForGood(ids).then(refreshTotals); }, UNDO_MS);
    return () => { undone = true; clearTimeout(timer); setTrash(ids, false).then(refresh).catch(() => {}); };
  }
  function deleteClip(date, id) {
    const meta = detach(date, id);
    if (!meta) return;
    const undo = trash([meta]);
    revokeAll();
    refresh();
    toast('Clip deleted', 'Undo', () => { attach(date, meta); undo(); refresh(); });
  }

  // ---------------------------------------------------------------- UI
  let urls = [];
  function revokeAll() { urls.forEach(u => URL.revokeObjectURL(u)); urls = []; }

  function showNote(text) {
    const n = $('jvNote');
    n.textContent = '';
    n.append(el('p', null, text));
    n.hidden = false;
    return n;
  }
  function clearNote() { dropPending(); const n = $('jvNote'); n.textContent = ''; n.hidden = true; }

  let disabledBefore = [];
  function showRecording(r) {
    const v = $('jvPreview');
    v.hidden = r.audioOnly;
    if (!r.audioOnly) { v.srcObject = r.stream; v.play().catch(() => {}); }
    $('jvRecIdle').hidden = true;
    $('jvRec').hidden = false;
    $('jvRecLabel').textContent = r.audioOnly ? 'Recording audio' : 'Recording';
    tick();
    // the rest of the editor waits until Stop
    disabledBefore = [...$('jForm').querySelectorAll('input, textarea, button, select')].filter(x => !$('jvRec').contains(x) && !x.disabled);
    disabledBefore.forEach(x => { x.disabled = true; });
    $('jvStop').focus();
  }
  function hideRecording() {
    const v = $('jvPreview');
    v.pause();
    v.srcObject = null;
    $('jvRec').hidden = true;
    $('jvRecIdle').hidden = false;
    disabledBefore.forEach(x => { x.disabled = false; });
    disabledBefore = [];
  }
  function tick() {
    if (!rec) return;
    const ms = Date.now() - rec.at;
    $('jvTime').textContent = `${fmtLen(ms)} / ${fmtLen(MAX_MS)}`;
  }

  // the clips of the day open in the editor; players (and their object URLs) only for that day
  function renderClips() {
    if (!supported && !clipsOf(jDate).length) { $('jVideo').hidden = true; revokeAll(); return; }
    $('jVideo').hidden = false;
    $('jvRecord').hidden = !supported;
    revokeAll();
    const list = $('jvClips');
    list.textContent = '';
    const clips = clipsOf(jDate);
    clips.forEach((v, i) => list.append(clipRow(v, i + 1)));
    refreshTotals();
  }

  function clipRow(v, n) {
    const row = el('div', 'jv-clip');
    const head = el('div', 'jv-head');
    const when = v.at ? new Date(v.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    head.append(el('b', null, `${isAudio(v) ? '🎙' : '🎥'} ${fmtLen(v.dur)}`), el('span', 'jv-meta', [fmtSize(v.size), when].filter(Boolean).join(' · ')));
    row.append(head);
    if (!held.has(v.id)) {
      const where = v.device === (typeof Sync !== 'undefined' && Sync.deviceId) ? 'This clip is no longer stored on this device.'
        : `Recorded on another device${v.devName ? ` (${v.devName})` : ''}, not on this one. Play, download or delete it there.`;
      row.classList.add('away');
      row.append(el('p', 'jv-away', where));
      return row;
    }
    const btns = el('div', 'jv-btns');
    const dl = el('button', 'small', 'Download');
    dl.type = 'button';
    dl.addEventListener('click', () => download(v, n));
    const del = el('button', 'small danger', 'Delete');
    del.type = 'button';
    del.addEventListener('click', () => deleteClip(jDate, v.id));
    btns.append(dl, del);
    head.append(btns);
    const player = el(isAudio(v) ? 'audio' : 'video', 'jv-player');
    player.controls = true;
    player.preload = 'metadata';
    player.playsInline = true;
    row.append(player);
    getRec(v.id).then(r => {
      if (!r || !r.blob || !row.isConnected) return;
      const u = URL.createObjectURL(r.blob);
      urls.push(u);
      makeSeekable(player, v.dur);
      player.src = u;
    }).catch(() => {});
    return row;
  }

  // WebM from MediaRecorder has no length in its header, so browsers report Infinity and can't
  // seek. Asking for a far-off time makes the browser scan the file and find the real length.
  function makeSeekable(m, durMs) {
    m.addEventListener('loadedmetadata', function fix() {
      m.removeEventListener('loadedmetadata', fix);
      if (Number.isFinite(m.duration)) return;
      const back = () => { m.removeEventListener('durationchange', back); m.currentTime = 0; };
      m.addEventListener('durationchange', back);
      m.currentTime = Math.max(1e7, (durMs || 0) / 1000 + 10);
    });
  }

  async function download(v, n) {
    const r = await getRec(v.id).catch(() => null);
    if (!r || !r.blob) { toast("That clip isn't on this device"); return; }
    const u = URL.createObjectURL(r.blob);
    const a = el('a');
    a.href = u;
    a.download = `journal-${r.date || jDate}-${n}.${ext(r.mime || v.mime || '')}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  }

  // "3 clips on this device · 24.1 MB"
  function refreshTotals() {
    const p = $('jvTotal');
    if (!p) return;
    let size = 0;
    held.forEach(s => { size += s; });
    p.textContent = held.size ? `${held.size} clip${held.size === 1 ? '' : 's'} on this device · ${fmtSize(size)}` : '';
  }

  function refresh() {
    if (!$('journalView').hidden) {
      if (!jDirty) loadEditor(jDate); else renderClips();
      renderJournalLists();
    }
    if (typeof showStorageUsed === 'function') showStorageUsed();
  }

  // ---------------------------------------------------------------- keep the screen on
  let wake = null;
  async function syncWake() {
    const want = !!rec && !document.hidden && 'wakeLock' in navigator;
    try {
      if (want && !wake) {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      } else if (!want && wake) {
        await wake.release();
        wake = null;
      }
    } catch (e) { wake = null; }
  }

  // ---------------------------------------------------------------- stop on leaving
  let hiddenTimer = null;
  document.addEventListener('visibilitychange', () => {
    clearTimeout(hiddenTimer);
    if (document.hidden && rec) hiddenTimer = setTimeout(() => stop('hidden'), HIDDEN_STOP_MS);
    syncWake();
  });
  // the page is going away: stop now; whatever doesn't finish is recovered on the next start
  window.addEventListener('pagehide', () => { if (rec) { finishing[rec.id] = Date.now(); stop('closed'); } dropPending(); });

  // ---------------------------------------------------------------- start-up
  async function init() {
    if (!canStore) { renderClipsSafe(); return; }
    $('jvRecord').addEventListener('click', start);
    $('jvStop').addEventListener('click', () => { if (rec) finishing[rec.id] = Date.now(); stop('user'); });
    try {
      // purge clips whose Undo ran out while the app was closed
      await tx(['videos'], 'readwrite', s => {
        s.openCursor().onsuccess = e => { const c = e.target.result; if (!c) return; if (c.value.trash) c.delete(); c.continue(); };
      });
      await loadHeld();
      // skip recovery while another window is still recording
      const run = async () => {
        const n = await recover();
        if (n) toast(n === 1 ? 'Recovered an unfinished recording' : `Recovered ${n} unfinished recordings`);
        await reattach();
      };
      let ran = false;
      try { if (navigator.locks) await navigator.locks.request('pomegranate-recording', { ifAvailable: true }, l => { ran = true; return l ? run() : null; }); } catch (e) {}
      if (!ran) await run();   // no locks (or a stand-in that doesn't call back)
    } catch (e) {}
    refresh();
  }
  function renderClipsSafe() { try { renderClips(); } catch (e) {} }

  return {
    supported, init, start, stop, trash, reattach, holds, renderClips: renderClipsSafe, totalDur, clipsOf, fmtLen,
    get recording() { return !!rec; },
  };
})();
JournalVideo.init();
