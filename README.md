# Pomegranate

A study planner and Pomodoro timer web app. The timer runs in the app itself, on computers and phones. It also plans tasks, keeps a daily journal, habits and sleep log, and tracks study time with a productivity score. On a computer it can also drive my custom USB desk board, which shows the task list and Claude Code status.

## Features
- **Today tab:** one page for the day: focus time against your goal, score, tasks due (tick them off here), last night's sleep, and the past 7 days of focus, sleep, habits and day ratings
- **Timer tab:** the built-in timer runs sessions in the app (also on phones), with focus time, tracking, scores, and notifications. Pick a task to work on and focus time is credited to it
- **Synced sessions:** start a session on one device and it runs on all your signed-in devices; pause, resume or exit from any of them
- **Timer alerts:** a notification on every device when a focus block, break, or session ends, even when the app is closed (via a small cloud function), plus an option to keep the screen awake during sessions
- **Tasks tab:** a Todoist-style task list with natural-language quick add (`Lab report fri !high d3 #ECE140`, `Gym every mon`), priorities, easy / medium / hard difficulty, projects, repeating tasks, and subtasks you can tick off on the Tasks tab, in the Calendar, or under the timer while you focus
- **Calendar tab:** month view of tasks due, each day's productivity score, hours slept, and your day rating (show both, productivity, or day rating)
- **Journal tab:** write about your day and rate it out of 10 (a single number or a range such as 4–7; the rating is optional, so a day can be just notes). Ratings color the calendar (1–3 red, 4–5 orange, 6–8 yellow, 9–10 green); a range counts as its midpoint in the averages and unrated days are left out. Kept separate from the productivity score. **Important days:** press **☆ Mark as important** (in the journal, or on a day in the calendar) to star a day you want to come back to: it gets a gold ring and ★ on the calendar, a gold card in the entry list, and **★ Important only** filters the list down to starred days. **Moods:** tag a day with any of Happy, Fun, Excited, Grateful, Calm, Studious, Productive, Reflective, Tired, Stressed, Anxious, Sad, Angry or Sick; they show as chips in the entry list and the calendar's day panel, and as icons in the calendar cells on wider screens. A star or a mood on its own is enough to keep an entry. **Video journal:** press **Record video** under Notes, talk to the camera, press **Stop** and the clip is saved to that day (no file picker, no upload). Several clips a day; each one plays in the entry, can be downloaded (`journal-2026-11-16-1.mp4`) and deleted with Undo. No camera, or camera blocked? It offers audio only. Clips are stored only on the device that recorded them (IndexedDB), MP4 where the browser can record it (Safari, recent Chrome) and WebM otherwise, at about 8 MB a minute, up to 15 minutes each. A recording stops and saves itself when you leave the Journal, change the date or the app goes into the background, and one cut off by a crash or reload is recovered on the next start. Only each clip's date, length and size sync with the entry; other devices show it as recorded on another device
- **Habits tab:** a monthly grid, one row per habit; click a box to cycle empty → ✓ → ✕
- **Sleep tab:** bedtime, wake time and quality (1–5) for each night, filed under the morning you woke up
- **Desk board** (Chrome or Edge on a computer): press **Connect board** to link the USB board over Web Serial. It is a display only: it shows your top dated tasks and the status of Claude Code jobs and plan usage. The timer always runs in the app
- **Keyboard shortcuts:** `Ctrl+Space` adds a task and `Ctrl+0` starts a 25/5 session from any tab (`Space` pauses / resumes); the installed app's taskbar menu has "Start 25/5 session" and "Add a task" too. Page zoom is left to the browser, so you can make the text bigger
- **Installable app** that works offline
- **Themes:** a playful robot-lab look matching my website (chunky type, outlined cards, robot mascots), in system / light / dark, plus 8 accent colors or any custom color
- **Cloud sync:** sign in with Google to sync tasks, journal, habits, sleep, study history and settings between computer and phone (Firebase)

## Using the app
Open the GitHub Pages link. Sessions run on the built-in timer, so nothing needs to be plugged in. To use the desk board, open the app in Chrome or Edge on a computer, plug the board in, and press **Connect board**. The app uses the Web Serial API to talk to it over USB, with no drivers needed.

**Install it as an app:** on the GitHub Pages site, click the install icon at the right end of the address bar (or **⬇ Install as an app** under the timer). It then opens in its own window with a Start menu / taskbar icon and works offline.

**Global hotkeys (Windows):** with the app installed from Chrome or Edge, run `powershell -ExecutionPolicy Bypass -File hotkeys\install-hotkeys.ps1`. It adds Start Menu shortcuts so `Ctrl+Alt+Space` (add a task) and `Ctrl+Alt+0` (start a 25/5 session) work even when the app is closed. Add `-Uninstall` to remove them.

**Your data:** tasks, journal, habits, sleep, study history and settings are stored in the browser first, so the app works offline. Sign in from ⚙ Settings to sync them across devices, or use **Back up** / **Restore** there to move them by hand (**Export CSV** gives a per-day summary). If the browser can't save (storage full or blocked), a warning banner appears and Settings shows how much storage is used. Backups include journal clip details but not the videos: download clips you want to keep. Restoring a backup never deletes clips on the device; they go back on their day.
- **Restore** while signed out replaces what is on this device with the backup. While signed in it merges instead: items missing here are added back, the newer version of anything in both is kept, nothing is deleted here or on your other devices, and your focus goal is left alone. It asks first and says which will happen.
- **Switching accounts:** if you sign in as a different Google account than the one this device last synced with, you are asked whether to **merge** this device's data into the new account, **replace** this device's data with the new account's (the other account keeps its cloud copy), or sign out (Esc also signs out). Nothing is uploaded until you choose.

## Productivity score

**Session score (0–100)**, for each timer session:
| Part | Weight | Measures |
|---|---|---|
| Completion | 45% | Finished all cycles or checked off a task during the session; otherwise the share of planned focus done |
| Efficiency | 35% | Focus share of desk time, relative to what the focus/break plan allows (long pauses lower it) |
| Intensity | 20% | Focus-time-weighted difficulty of the linked task(s) ÷ 5 |

Sessions with under a minute of focus aren't scored.

**Daily score (0–100):**
| Part | Weight | Measures |
|---|---|---|
| Focus time | 40% | Focus minutes vs. a daily goal (adjustable in Settings) |
| Tasks done | 30% | Difficulty-weighted share of tasks due that day that got done |
| Session quality | 30% | Focus-weighted average of that day's session scores |

Parts with nothing to measure are left out and the rest are rescaled.

## How it works
The built-in timer (`localtimer.js`) is a software copy of the original Arduino timer: it understands the same commands (`START`, `AUTO`, `PAUSE`, `RESUME`, `EXIT`, ...) and sends the same `STATE` / `EVENT` lines, and the rest of the app records time from those once-a-second `STATE` messages. The Arduino sketch (`Pomodoro_Timer_Code.ino`) has the USB protocol in its header comment. The app still contains the code for a board that runs the timer itself, but `BOARD_RUNS_TIMER` in `app.js` is `false`, so a connected board is only a display and never gets timer commands.

The desk board gets the top 4 dated, unfinished tasks (`boardsync.js`) and, when you're signed in, Claude Code job status and usage (`claudestatus.js`). The Claude Code status is read from one Firestore document that a script on my laptop writes; the app only reads it.

## Cloud sync
Sync uses Firebase Authentication (Google sign-in) and Cloud Firestore. Tasks, journal entries, habits and sleep nights are stored one per document and the newest change wins; deletions sync as markers. A journal entry's video clips are the exception: the device that holds a clip keeps it on the entry when a newer copy without it arrives, and sends the merged entry back up. Study history is stored per device and added together for display, so two devices studying on the same day never overwrite each other (an identical copy, such as the same backup restored on two devices, is counted once).

**Synced sessions:** the running session is one shared document holding the timer's state as absolute times (when this phase ends), so every device counts down on its own clock without constant updates. Devices only write when you start, pause, resume, exit or continue, and the newest change wins. Only the device that started a session records it.

**Closed-app alerts:** each device registers for Web Push. When the shared session changes, a Firebase cloud function (`cloud/functions`) works out every upcoming focus/break ending and schedules a Cloud Task for each one, which sends the alert at that exact time unless the session has changed since. The function checks that a write looks like one the app makes and limits how often each user can schedule alerts. Setup steps are in [cloud/SETUP.md](cloud/SETUP.md). This part needs Firebase's pay-as-you-go plan, but stays within the free allowances.

Firestore security rules: see [cloud/firestore.rules](cloud/firestore.rules). Each signed-in user can read and write only their own `users/{uid}/...` folders, and every write is checked for shape and size; the file maps each rule to the code that writes that data.

## Tests
No dependencies and no build: open a page from a local server (for example `python -m http.server`) or GitHub Pages and read the results. None of these pages is part of the installed app.
- `tests.html`: the desk-board logic (`boardsync.js`, `claudestatus.js`).
- `logic-tests.html`: the quick-add parser and repeats (`tasks.js`), session and daily scores (`score.js`), merged study days (`sync.js`), journal averages, important days and moods (`journal.js`), and a check that the built-in timer and the cloud function's alert scheduler follow the same phase rules. It runs the real app in a hidden frame with its own in-memory storage and a pinned clock.
- `sync-tests.html`: cloud sync, backup restore, the account-switch prompt and keeping journal video clips when a newer copy of an entry arrives, in a hidden frame against an in-memory fake of Firebase (nothing is sent anywhere). Takes about a minute and a half.
- `video-tests.html`: the video journal (`journalvideo.js`): really records from the camera and microphone (allow them when asked, or run Chromium with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required` for a synthetic camera), then checks saving, playback and seeking, recovery after a crash or reload, stopping on leaving the tab, delete and Undo, restore, audio only, blocked permissions, full storage and browsers without MediaRecorder. Uses its own test database, never the app's clips. About a minute and a half.
- `cloud/functions/test.js`: plain Node checks of the cloud function (`node test.js` from `cloud/functions`; not deployed). `logic-tests.html` also loads that file's `upcomingAlerts` in the browser for the timer check.

## Project structure
```
index.html, style.css           App layout and styles
app.js                          Desk board connection (Web Serial) and timer controls
localtimer.js                   Built-in timer (same protocol as the Arduino)
notify.js                       Timer-finished notifications and keep-awake
analytics.js                    Study time tracking, backup / restore / export, shared helpers
score.js                        Session and daily productivity scores
dashboard.js                    Today tab
tasks.js                        Tasks tab and quick-add parser
calendar.js                     Calendar tab
journal.js                      Journal tab (day ratings, moods, important days)
journalvideo.js                 Journal video and audio clips (recording, IndexedDB storage, recovery)
habits.js                       Habits tab
sleep.js                        Sleep tab
boardsync.js                    Task list for the desk board
claudestatus.js                 Claude Code status and usage for the desk board
sync.js                         Google sign-in and cloud sync
livesync.js                     Shared timer sessions across devices
push.js                         Alerts while the app is closed (Web Push)
theme.js                        Theme settings
shortcuts.js                    Keyboard shortcuts and the quick-add box
main.js                         Tabs, install-as-app, start-up
manifest.webmanifest, sw.js     Installable app (PWA) setup
tests.html, logic-tests.html,
sync-tests.html,
video-tests.html                Test pages (see Tests)
hotkeys/                        Windows global hotkeys (install-hotkeys.ps1)
icons/                          App icons and robot mascots (icons/bots/)
fonts/                          Inter (SIL Open Font License), stored locally so the app works offline
cloud/                          Firebase rules and cloud function that sends timer alerts (see cloud/SETUP.md)
Pomodoro_Timer_Code.ino         Arduino timer sketch (USB protocol in its header comment)
privacy.html, terms.html        Privacy policy and terms
pomodoro-timer.zip              An older copy of the app files, not used by the app
```
