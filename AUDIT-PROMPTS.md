# Pomegranate audit and fix prompts

Audit date: 2026-11-15. Scope: every file in this folder (app JS, service worker, Firestore rules, cloud function). Nothing was changed; this file is the only thing added. Delete it before you deploy, or it gets published with the site.

**How to use:** open a fresh session in this folder, paste the **Rules** block, then one prompt. Run them in order: 1 is a safety net, 2 must land before 8 (video). Each prompt is one commit-sized change.

| # | Prompt | Model | Why it matters |
|---|---|---|---|
| 1 | Put the project under git | Sonnet | No version control; backups are folder copies |
| 2 | Journal loses text with no rating | Opus | Data loss today; also unblocks video |
| 3 | Sync can delete or mix cloud data | Opus | Restore wipes the cloud; account switch merges accounts |
| 4 | Saves fail silently | Sonnet | Full storage = lost data with no warning |
| 5 | Firebase is open to abuse | Opus | Any Google account can fill your database and trigger your functions |
| 6 | Offline cache and zoom | Sonnet | Mixed app versions offline; zoom is blocked |
| 7 | Tests and README | Sonnet | Timer logic is duplicated with no parity test; README is stale |
| 8 | Video journal, on this device | Opus | The new feature |
| 9 | Video journal, synced | Opus | Optional follow-up to 8; costs money at scale |

Not problems, leave alone: the Firebase `apiKey` in `sync.js` (public by design), the VAPID public key, and `innerHTML` in `tasks.js` (a constant SVG only; all user text goes through `textContent`).

---

## Rules (paste before every prompt)

```text
You are working on Pomegranate, a static PWA in this folder (GitHub Pages, no build step, no framework, no npm in the app itself).

Conventions you must keep:
- Plain script tags loaded in order from index.html; files share globals ($, el, toast, dayKey, shiftKey, journal, tasks, store, Sync...). No modules, no bundler, no new dependencies.
- Data lives in localStorage first (keys pomodoro-*-v1). Every save function calls Sync.stamp(kind) before writing; sync.js mirrors to Firestore with last-write-wins on a "u" timestamp and tombstones for deletes.
- User text is always inserted with textContent or el(tag, cls, text). Never innerHTML with data.
- Match the existing style: short comments that explain why, same naming, same CSS tokens and classes in style.css (.box, .small, .primary, .danger, .section).
- When you add or change a shipped file: add it to ASSETS in sw.js, bump CACHE in sw.js, and bump every ?v= in index.html to one new value.
- Do not deploy, push, or run firebase commands. Do not touch cloud/ unless the prompt says so.

Before editing, read the files the prompt names. When done, list what you changed, what you verified by actually running it (open index.html through a local static server), and what you could not verify.
```

---

## 1. Put the project under git (Sonnet)

```text
This folder is not a git repository and the parent folder holds a manual backup named "pomegranate-app - Copy". The live site is https://matthewtang29.github.io/pomodoro-timer/, so a GitHub repo exists but this folder is not a clone of it.

Do this:
1. Check for anything that must never be committed (cloud/functions/node_modules, .firebase, *.local, vapid-private-key.txt, service-account JSON). cloud/.gitignore already covers the cloud folder; add a root .gitignore for OS junk and anything else you find.
2. git init, then one initial commit of the folder as it is.
3. Stop and ask me how this folder relates to the GitHub repo (is the app at the repo root or in a subfolder, and how do I currently upload). Do not add a remote, pull, or push until I answer.

Change no app code.
```

## 2. Journal loses text when the day has no rating (Opus)

```text
Bug: in journal.js an entry is only saved once the day has a rating. markDirty() (line 147) only starts the autosave timer if jRating is set, switchDate() (191) and the pagehide handler (284) only save "if (jDirty && jRating)", and saveEntry() (155) refuses without a rating. So if I write a long entry and switch date, switch tab, or close the app before picking a number, the text is silently gone.

Second bug in the same function: saveEntry() rebuilds the entry as { rating, text, updated } (line 162), which drops any other field on the entry. That will destroy fields added later (a video journal feature is coming that stores a "videos" array on the entry).

Fix:
- Make the rating optional. An entry is saved if it has a rating OR non-empty text (later: OR videos). Store rating as null when unset. Autosave, switchDate, pagehide and Ctrl+Enter all save under that rule. An entry with no rating, no text and nothing else is deleted rather than saved empty.
- saveEntry must update the existing entry object's fields and keep every field it does not own.
- Every reader must cope with rating == null: ratingLo/ratingHi/ratingMid, paintMood, moodBadge, the 14-day strip and averages and entries list in journal.js; the calendar cell and day panel in calendar.js (lines 44-51, 78, 115-129); the CSV export in analytics.js (line 230); dashboard.js (line 149 on, already checks e.rating). Unrated entries show as written-but-unrated (neutral color, no "/10" badge) and are left out of averages.
- loadJournal and restoreJournal should drop entries that are not objects, so a bad backup cannot crash rendering.

Keep the sync shape unchanged (one Firestore doc per date); a null rating must survive Sync's clean() round trip.

Verify by hand: type text with no rating then switch tabs, reload, and switch dates (text survives each time); rate then clear; delete with Undo; calendar and Today tabs render a month containing rated, range-rated and unrated entries.
```

## 3. Sync can delete or mix cloud data (Opus)

```text
Read sync.js fully, plus the restore handler in analytics.js (lines 245-265). Fix these, in this order, each as its own small change:

A. Restore wipes the cloud. Restoring a backup while signed in replaces local data, then Sync.stamp() tombstones every item that is not in the backup and re-stamps every changed item as newest. An old backup therefore deletes newer tasks/journal/habits/sleep on all devices, with no confirmation. Fix: confirm before any restore, saying plainly what will happen. When signed in, restore must merge instead of replace: add items missing locally, and for items present in both keep whichever has the newer "u" (or "updated"); never create tombstones from a restore. Signed out, a full replace after the confirm is fine.

B. Switching accounts merges them. signOut() (183) leaves all local data and the remoteDays cache in place. Signing in with a different Google account then uploads everything via queueLocalNewer() (310), and shows the first account's other-device study time. Fix: remember the last signed-in uid in localStorage. On sign-in with a different uid, ask before doing anything: "merge this device's data into this account" or "replace this device's data with this account's". Clear remoteDays and remoteU when the uid changes.

C. Changes made during an upload can sit unsynced. flush() (342) clears flushTimer and then returns early if "flushing" is true, so an edit stamped while a batch is in flight has its scheduled flush cancelled and is not sent until some later edit. Fix: if dirty is non-empty when a flush finishes, schedule another.

D. Snapshot listener errors are terminal. The onSnapshot error callback (197) shows "will retry" but nothing re-subscribes. Fix: re-attach listeners with backoff, and on "online".

E. Local edits can be swallowed while applying remote changes. onSnap() sets applying = true and calls saveTasks() etc.; stamp() then records the current JSON of every item into prev without marking it dirty, so a local change not yet saved (for example focusSec ticking on the linked task, saved every 10 s) is recorded as already-seen and never uploaded until the item changes again. Fix: while applying, only update prev for the ids that came from the snapshot.

F. Tombstones never expire (local "pomodoro-sync-tombstones" and the {deleted:true} cloud docs). Prune ones older than 90 days, locally and in the cloud.

Do not change the cloud layout or the last-write-wins model. Clock skew between devices is a known limitation; note it in a comment, do not try to solve it.

Verify with two browser profiles signed into one test account: restore an old backup on one and confirm the other loses nothing; edit during a slow flush (DevTools throttling) and confirm it arrives; sign out and into a second account and confirm the prompt appears and nothing uploads before I choose.
```

## 4. Saves fail silently (Sonnet)

```text
Every save in the app is "try { localStorage.setItem(...) } catch (e) {}": saveTasks (tasks.js:23), saveJournal (journal.js:24), saveStore (analytics.js:28), saveHabits, saveSleep, LocalTimer.save, and write() in sync.js. If storage is full or blocked, the app keeps running on in-memory data and loses it on reload with no warning. The analytics store (pomodoro-analytics-v1) grows forever: every session ever, with per-task maps.

Fix:
- Add one shared helper (in app.js, next to toast) that writes to localStorage and, on failure, shows a single persistent warning: "Couldn't save. Storage is full or blocked. Back up now from Settings." Do not spam it; show it once until a later save succeeds. Route all the save sites through it.
- Call navigator.storage.persist() once after the first successful save, where supported, so the browser is less likely to evict the data.
- In Settings under "Your data", show storage used (navigator.storage.estimate()).
- Validate on load and restore: loadTasks/loadJournal/loadHabits/loadSleep/loadStore and the restore handler in analytics.js should drop malformed items (wrong type, missing id or title) instead of trusting the JSON. Keep it small: a few type checks, no schema library.

Do not change any data format.
```

## 5. Firebase is open to abuse (Opus)

```text
Context: sign-in is open to any Google account. cloud/firestore.rules lets a signed-in user write any document of any shape and size (up to Firestore's 1 MiB) to users/{uid}/{tasks,journal,habits,sleep,days,meta,devices,live,relay,push}, unlimited in number. cloud/functions/index.js runs scheduleTimerAlerts on every write to users/{uid}/live/{docId} and enqueues up to 60 Cloud Tasks per write. The project is on the pay-as-you-go plan. So a stranger with a script can run up storage, function and task costs.

Do this (you may edit cloud/, but do not deploy; give me the deploy commands at the end):
1. firestore.rules: per-collection validation. Cap document size by checking the fields that can grow (string lengths, list sizes), require the expected field types, restrict doc ids to a sane pattern and length, and reject unknown top-level keys where practical. Read sync.js, livesync.js and push.js to get the exact shapes that are written, including tombstones {deleted:true,u} and the days docs {…, date, device, u}. The app must keep working unchanged.
2. functions/index.js: validate after.s before using it (st is one of the known states; focus, brk in 1..99; cycles 0..20; cycle and timestamps finite and within a day of now) and return early otherwise. Throttle per uid: skip scheduling if that user's live/timer changed more than N times in the last minute. Rate-limit live/test the same way.
3. App Check: add it to the web app (reCAPTCHA Enterprise or v3 provider, loaded lazily with the other compat SDK files in sync.js loadSdk()) and tell me exactly which console steps and enforcement switches I need to flip, in what order, so existing signed-in devices are not locked out.
4. Tell me how to set a billing budget alert for the project.
5. README.md shows an older, broader rules snippet than cloud/firestore.rules. Replace it with a pointer to the file.

There is a firebase.json ignore entry for test.js but no such file. Add cloud/functions/test.js that runs with plain node (no test framework) and checks upcomingAlerts() via the existing POMEGRANATE_TEST export, including the new validation.
```

## 6. Offline cache and zoom (Sonnet)

```text
Two unrelated polish items. Keep them as two commits.

A. Service worker cache (sw.js). index.html loads every file as name?v=VERSION, but ASSETS precaches the bare names and the fetch handler uses the full request (with ?v=) as the cache key. Results: (1) precached copies only ever match through the offline fallback's ignoreSearch lookup; (2) every release leaves the previous ?v= copies in the cache until CACHE is bumped by hand; (3) offline right after an update, a new index.html can be served with an older script picked by ignoreSearch, which mixes versions. Fix by normalising the cache key for same-origin assets (strip the v parameter) so there is exactly one entry per file, replaced in place, and make the offline fallback use the same key. Keep the current behaviour: cached copy first, background refresh, and the "new version ready, Reload" toast when index.html changes. Also: fonts/bungee.woff2, nunito.woff2 and figtree.woff2 are not referenced anywhere in style.css (only Inter is). Confirm with a search, then delete them and fix the README line that mentions them.

B. Zoom is blocked. index.html line 6 sets maximum-scale=1, user-scalable=no, and shortcuts.js lines 78-87 cancel Ctrl +/-, Ctrl+wheel, pinch and multi-touch move. That fails WCAG 1.4.4 for low-vision users. Remove the viewport restriction and the wheel/gesture/touchmove blockers. Keep Ctrl+0 as "start 25/5" only if you also keep a way to reset zoom; otherwise move that shortcut and update the hint text in index.html, the README and the autoBtn title. Check that the layout still works at 200% zoom on the Timer, Tasks and Journal tabs and fix anything that overflows.
```

## 7. Tests and README (Sonnet)

```text
tests.html only covers boardsync.js and claudestatus.js. Extend it, same zero-dependency style (the eq/group helpers already there), to cover the pure logic most likely to break:
- tasks.js: parseQuickAdd (dates, "every mon", !high, d1-d3, #project, last date wins), stepRepeat (Jan 31 monthly, weekdays over a weekend), nextDue for an overdue task.
- score.js: sessionScore and dayScore, including "parts with nothing to measure are left out".
- sync.js: mergedDay de-duplication.
- Timer parity: the phase rules exist twice, in localtimer.js advance() and in cloud/functions/index.js upcomingAlerts(), kept in step by hand (GET_READY_MS, the 2000 ms and 1500 ms screens). Add a test that drives both from the same starting state and asserts the same end times for a custom 2-cycle session and an auto session. If a function needs to be exposed to test it, expose it the way BoardSync does (a few extra names on the returned object), nothing more.

These files touch the DOM at load, so load them in tests.html with the minimum stub markup they need, or refactor only as far as needed to make the pure functions loadable. Do not restructure the app.

Then bring README.md up to date with the code: it describes an Analytics tab that no longer exists, omits the Today, Habits and Sleep tabs, dashboard.js, habits.js, sleep.js, boardsync.js, claudestatus.js and hotkeys/, still describes the board as running the timer (BOARD_RUNS_TIMER is false in app.js), and links to firmware/README.md, which is not in this folder.
```

## 8. Video journal, saved on this device (Opus)

```text
Add a video journal to the Journal tab: I press Record in the app, rant at the camera, press Stop, and the clip is saved to that day's entry. No file picker and no upload step.

Prerequisite: journal entries can exist without a rating and saveEntry keeps unknown fields (if journal.js still requires a rating to save, stop and tell me).

Design (follow it unless you find a concrete reason not to, and say so if you deviate):

Recording
- New file journalvideo.js, loaded after journal.js. navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true }) plus MediaRecorder.
- Pick the container at runtime with MediaRecorder.isTypeSupported, preferring MP4 (plays everywhere, including iPhone) and falling back to WebM: 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'. Set videoBitsPerSecond around 1,000,000 and audioBitsPerSecond around 64,000 (about 8 MB per minute).
- Crash safety: start the recorder with a 1-second timeslice and append each chunk to IndexedDB as it arrives. On stop, assemble the chunks into one Blob, store it, delete the chunks. On app start, if orphan chunks exist, assemble them and attach the clip to its day with a "Recovered an unfinished recording" toast.
- Stop and save automatically on pagehide, when the tab is hidden for more than a few seconds, when I leave the Journal tab (showTab in main.js), and at a hard cap of 15 minutes. Always stop every track on the stream so the camera light goes off, and revoke object URLs.
- Hold a screen wake lock while recording (see syncWakeLock in notify.js for the pattern).
- If there is no camera, or camera permission is denied but the microphone works, offer audio-only with the same flow. If both are denied, explain how to allow them; do not fail silently. Hide the Record button where MediaRecorder is missing.

Storage
- IndexedDB database "pomegranate-media" (do not reuse Firebase's databases), stores "videos" (key: clip id, value: Blob) and "chunks". Not localStorage, and nothing in the service worker cache.
- Metadata on the entry: journal.entries[date].videos = [{ id, at, dur, size, mime, device: Sync.deviceId }]. It rides the existing journal sync as plain JSON, so other devices know a clip exists. On a device that does not have the Blob, show the clip as "Recorded on <device name>, not on this device".
- Measure duration yourself (timestamps at start and stop) and store it; WebM from MediaRecorder has no duration header, so do not trust video.duration, and make the player seekable anyway.
- Call navigator.storage.persist() the first time a clip is saved. Before recording, check navigator.storage.estimate() and refuse with a clear message if less than about 200 MB is free. Show total clip storage in the Journal tab.

UI (journal section of index.html, styles in style.css using existing tokens and classes)
- Under Notes: a "Record video" button. While recording: mirrored live preview with muted playback, a running timer, and one large Stop button; everything else in the editor is disabled.
- After Stop: the clip appears in a list for that day with a native <video controls> player, its length and size, Download (so I can get the file out) and Delete with the app's existing Undo toast (keep the Blob until the toast expires).
- Multiple clips per day are allowed. In the Entries list and the calendar day panel, show a small camera marker and total length for days that have clips.
- Deleting a journal entry deletes its clips, with the same Undo behaviour.

Must not break
- Back up / Restore (analytics.js): the JSON backup includes the metadata but not the video data; say so in the Settings text next to the buttons.
- The timer keeps running and can chime during a recording; that is fine.
- sw.js: add journalvideo.js to ASSETS, bump CACHE, bump ?v= in index.html.
- privacy.html: add a short section saying videos are recorded with the camera and microphone only when I press Record, are stored only on this device, and are not uploaded; update the "Last updated" date.

Verify by actually recording: on desktop Chrome and, if you can, a narrow mobile viewport. Record 10 seconds and play it back and seek; reload mid-recording and confirm recovery; deny camera permission and confirm the message; delete with Undo; confirm the camera light is off after Stop. Tell me which of these you could not run.
```

## 9. Video journal, synced across devices (Opus, optional)

```text
The video journal (journalvideo.js) stores clips in IndexedDB on the recording device and syncs only metadata. Add optional cloud sync of the video data with Firebase Storage, so a rant recorded on my phone plays on my laptop.

Decide nothing silently about cost: Firebase Storage on the pay-as-you-go plan bills for stored GB and downloads. At roughly 8 MB per minute, tell me what a year of 5-minute daily rants costs before you build, and what the current no-cost allowance is for this bucket's region (look it up, do not guess).

Build:
- Off by default. A switch in Settings: "Sync journal videos (uses cloud storage)". Only available when signed in.
- Lazy-load firebase-storage-compat.js next to the other compat files in sync.js loadSdk(), only when the switch is on. Bucket is already in FIREBASE_CONFIG.
- Upload each finished clip to users/{uid}/journal-videos/{clipId} with a resumable upload, progress shown on the clip, retried on reconnect, and by default only on an unmetered connection (navigator.connection where available) with a "upload anyway" action. Mark the clip metadata with uploaded: true once done.
- On another device, a clip that is uploaded but not local streams from Storage on Play, with an explicit "Keep on this device" action to store it in IndexedDB. Never auto-download every clip.
- Delete: removing a clip or its journal entry deletes the Storage object too. Sync.deleteCloudData() in sync.js must delete everything under users/{uid}/journal-videos/ before deleting the account.
- New cloud/storage.rules: only the owner can read or write users/{uid}/journal-videos/*, contentType must start with video/ or audio/, size under 250 MB. Reference it from cloud/firebase.json. Do not deploy; give me the commands and the one-time console step to enable Storage.
- privacy.html: update the video section and the "What gets synced" list to say videos are uploaded to Google Cloud Storage only when this switch is on, are not end-to-end encrypted, and how to delete them.

Verify with two browser profiles on one test account, using the Firebase emulator for Storage if I have not enabled it yet.
```
