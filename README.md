# Pomegranate

A study planner and Pomodoro timer web app. It controls my custom Arduino Pomodoro timer over USB, but also works on its own with a built-in timer, on computers and phones. It also plans tasks, keeps a daily journal, and tracks study habits with a productivity score. For the physical timer, see the [hardware README](firmware/README.md).

## Features
- **Timer tab:** set up and control sessions over USB, with a live countdown synced to the device
- **Built-in timer:** no device plugged in? Sessions run in the app itself (also on phones), with the same tracking, scores, and notifications
- **Synced sessions:** start a session on one device and it runs on all your signed-in devices; pause, resume or exit from any of them (also works for the physical timer)
- **Timer alerts:** a notification on every device when a focus block, break, or session ends, even when the app is closed (via a small cloud function), plus an option to keep the screen awake during sessions
- **Tasks tab:** a Todoist-style task list with natural-language quick add (`Lab report fri p1 d4 #ECE140`), priorities, difficulty ratings (1–5), projects, and Today / Upcoming / All / Done views
- **Subtasks:** break any task into a checklist; tick items off on the Tasks tab, in the Calendar, or right under the timer while you focus
- **Link tasks to sessions:** pick what you're working on and focus time is credited to that task
- **Calendar tab:** month view of tasks due, each day's productivity score, and your day rating (switch between showing both, productivity, or day rating)
- **Journal tab:** write about your day and rate it out of 10 (1–3 red, 4–5 orange, 6–8 yellow, 9–10 green), with a 14-day overview; ratings color the calendar and are kept separate from the productivity score
- **Analytics tab:** daily productivity score, desk / focus / break time compared with yesterday and last week, and up to 30 days of history
- **Keyboard shortcuts:** `Ctrl+Space` adds a task and `Ctrl+0` starts a 25/5 session from any tab (`Space` pauses / resumes); the installed app's taskbar menu has "Start 25/5 session" and "Add a task" too
- **Installable app** that works offline and reconnects to the timer automatically
- **Themes:** a playful robot-lab look matching my website (chunky type, outlined cards, robot mascots), in system / light / dark, plus 8 accent colors or any custom color
- **Cloud sync:** sign in with Google to sync tasks, journal, study history and settings between computer and phone (Firebase)

## Using the app
Open the GitHub Pages link. To use the physical timer, open it in Chrome or Edge on a computer, plug in the timer, and press **Connect**. The app uses the Web Serial API to talk to the Arduino over its USB cable, with no drivers needed. Without the timer (or on a phone), sessions run on the built-in timer.

**Install it as an app:** on the GitHub Pages site, click the install icon at the right end of the address bar (or **⬇ Install as an app** under the timer). It then opens in its own window with a Start menu / taskbar icon, works offline, and reconnects to the timer on launch.

All data (tasks, journal, study history, settings) is stored in the browser first, so the app works offline. Sign in from ⚙ Settings to sync it across devices, or use **Back up** / **Restore** on the Analytics tab to move it manually.

## Productivity score

**Session score (0–100)**, for each timer session:
| Part | Weight | Measures |
|---|---|---|
| Completion | 45% | Finished all cycles or checked off a task during the session; otherwise the share of planned focus done |
| Efficiency | 35% | Focus share of desk time, relative to what the focus/break plan allows (long pauses lower it) |
| Intensity | 20% | Focus-time-weighted difficulty of the linked task(s) ÷ 5 |

**Daily score (0–100):**
| Part | Weight | Measures |
|---|---|---|
| Focus time | 40% | Focus minutes vs. a daily goal (adjustable) |
| Tasks done | 30% | Difficulty-weighted share of tasks due that day that got done |
| Session quality | 30% | Focus-weighted average of that day's session scores |

Parts with nothing to measure are left out and the rest are rescaled.

## How it works
The app talks to the timer with the text protocol described in the [hardware README](firmware/README.md#serial-protocol-115200-baud-one-line-per-message) and records time from the timer's once-a-second `STATE` messages. The built-in timer (`localtimer.js`) is a software copy of the Arduino timer that speaks the same protocol, so the rest of the app works the same with or without the device.

## Cloud sync
Sync uses Firebase Authentication (Google sign-in) and Cloud Firestore. Tasks and journal entries are stored one per document and the newest change wins; deletions sync as markers. Study history is stored per device and added together for display, so two devices studying on the same day never overwrite each other.

**Synced sessions:** the running session is one shared document holding the timer's state as absolute times (when this phase ends), so every device counts down on its own clock without constant updates. Devices only write when you start, pause, resume, exit or continue, and the newest change wins. Only the device that started a session records it in Analytics. For the physical timer, the computer it's plugged into shares every state change, and pause/exit from other devices is passed to that computer.

**Closed-app alerts:** each device registers for Web Push. When the shared session changes, a Firebase cloud function (`cloud/functions`) works out every upcoming focus/break ending and schedules a Cloud Task for each one, which sends the alert at that exact time unless the session has changed since. Setup steps are in [cloud/SETUP.md](cloud/SETUP.md). This part needs Firebase's pay-as-you-go plan, but stays within the free allowances.

Firestore security rules (only the signed-in user can read or write their own data):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

## Project structure
```
index.html, style.css           App layout and styles
app.js                          USB connection and timer controls
localtimer.js                   Built-in timer (same protocol as the Arduino)
notify.js                       Timer-finished notifications and keep-awake
analytics.js                    Study time tracking and Analytics tab
score.js                        Session and daily productivity scores
tasks.js                        Tasks tab and quick-add parser
calendar.js                     Calendar tab
journal.js                      Journal tab (day ratings)
sync.js                         Google sign-in and cloud sync
livesync.js                     Shared timer sessions across devices
push.js                         Alerts while the app is closed (Web Push)
theme.js                        Theme settings
shortcuts.js                    Keyboard shortcuts and the quick-add box
main.js                         Tabs, install-as-app, start-up
manifest.webmanifest, sw.js     Installable app (PWA) setup
icons/                          App icons and robot mascots (icons/bots/)
fonts/                          Bungee and Nunito (SIL Open Font License), stored locally so the app works offline
cloud/                          Firebase cloud function that sends timer alerts (see cloud/SETUP.md)
firmware/                       Arduino timer code (see firmware/README.md)
```
