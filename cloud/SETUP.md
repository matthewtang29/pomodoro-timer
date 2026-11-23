# Cloud alerts setup

This folder holds a small Firebase cloud function that sends "focus done", "break over" and "session complete" alerts to your devices at the exact time, even when the app is closed. Timer sync between devices works without it; only the closed-app alerts need it.

You only do this once. It takes about 15 minutes.

## 1. Switch Firebase to the pay-as-you-go plan
Cloud functions need Firebase's **Blaze** plan, which requires a card on file. At this app's usage everything stays inside the free monthly allowances (Cloud Functions, Cloud Tasks and Secret Manager), so it should cost **$0**.

1. Open the [Firebase console](https://console.firebase.google.com/), pick **pomodoro-timer-8d10f**.
2. Click **Upgrade** (bottom of the left sidebar) and choose **Blaze**.
3. When it offers a budget alert, set one at **$1** so you're emailed if anything ever costs money.
   (Later: [Google Cloud console → Billing → Budgets & alerts](https://console.cloud.google.com/billing/budgets)
   → **Create budget** → scope: project pomodoro-timer-8d10f, all services → amount → alert thresholds →
   email billing admins. A budget only emails you; it doesn't stop charges.)

## 2. Install the tools on your computer
1. Install **Node.js** (the LTS version) from [nodejs.org](https://nodejs.org).
2. In a terminal:
   ```
   npm install -g firebase-tools
   firebase login
   ```
   Sign in with the Google account that owns the Firebase project.

## 3. Check your database location
In the Firebase console, open **Firestore Database** and note the location (shown at the top or under ⚙ settings).
- `nam5 (United States)`: nothing to change.
- Anything else: open `cloud/functions/index.js` and set `REGION` to match (for example `northamerica-northeast1`, or `europe-west1` for `eur3`).

## 4. Add the secret key
The app signs its alerts with a key pair. The public half is already in `push.js` and `functions/index.js`. The private half is in `vapid-private-key.txt` (sent separately; **don't put it in the repo**).

From the `cloud` folder in a terminal:
```
cd functions
npm install
cd ..
firebase functions:secrets:set VAPID_PRIVATE_KEY
```
Paste the private key when asked and press Enter.

## 5. Deploy
Still in the `cloud` folder:
```
firebase deploy --only functions
```
The first deploy turns on a few Google Cloud services and takes several minutes. If it fails with a permissions or "Eventarc" error the first time, wait 5 minutes and run it again; that's normal for a brand-new setup.

## 6. Turn alerts on, on each device
On every device (laptop, iPhone, iPad):
1. Open Pomegranate (**on iPhone/iPad, open it from the Home Screen icon**, not Safari).
2. ⚙ Settings → **Sign in with Google**.
3. Turn on **Notify me when a timer ends** and allow notifications.
4. You should see "✓ Alerts reach this device even when the app is closed." Tap **Send a test alert**; every device with alerts on should get one within a few seconds.

## Troubleshooting
- **No test alert:** Firebase console → **Functions** → **Logs** shows what went wrong.
- **"could not schedule alert" with PERMISSION_DENIED in the logs:** the function needs permission to schedule tasks. In the [Google Cloud console](https://console.cloud.google.com/iam-admin/iam?project=pomodoro-timer-8d10f), edit the **Default compute service account** and add the roles **Cloud Tasks Enqueuer** and **Service Account User**. Or, if you have the `gcloud` tool (replace PROJECT_NUMBER with the number under ⚙ Project settings):
  ```
  gcloud projects add-iam-policy-binding pomodoro-timer-8d10f --member=serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com --role=roles/cloudtasks.enqueuer
  gcloud projects add-iam-policy-binding pomodoro-timer-8d10f --member=serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com --role=roles/iam.serviceAccountUser
  ```
- **iPhone gets nothing:** alerts only work in the Home Screen version of the app, and only after you've allowed notifications from inside it. Check iPhone Settings → Notifications → Pomegranate.
- **Changing the key pair:** run `npx web-push generate-vapid-keys`, put the public key in both `push.js` and `functions/index.js`, set the new private key with step 4, deploy, and turn alerts off and on again on each device.

## Abuse protection
Anyone with a Google account can sign in, so the project is guarded in three layers:
- **Rules** (`firestore.rules`): each user only touches their own folder, and every write is checked for
  doc id, field types and sizes. Deploy with `firebase deploy --only firestore:rules`. To undo: Firebase
  console → **Firestore Database** → **Rules** → pick the previous version in the history list → **Publish**.
- **Cloud function limits** (`functions/index.js`): a timer write is only used if it looks like one the
  app makes, and each user can schedule alerts at most 30 times a minute / 300 an hour (test alerts
  5 / 30). The counters live in `users/{uid}/limits/{timer|test}`. Check with `node test.js` in `functions`.
- **App Check** (`APP_CHECK_SITE_KEY` in `sync.js`): off until a key is filled in. Turn it on in this order,
  so signed-in devices aren't locked out:
  1. [Google Cloud console → Security → reCAPTCHA](https://console.cloud.google.com/security/recaptcha?project=pomodoro-timer-8d10f)
     → enable the API if asked → **Create key**: type **Website**, domain `matthewtang29.github.io`
     (add `localhost` too to test locally), leave the checkbox challenge off → copy the **key ID**.
  2. Firebase console → **App Check** → **Apps** → the web app → **reCAPTCHA Enterprise** → paste the key ID
     → **Save**. Don't press Enforce anywhere yet.
  3. Paste the key ID into `APP_CHECK_SITE_KEY` in `sync.js`, bump `CACHE` in `sw.js` and the `?v=` values
     in `index.html`, and publish the site.
  4. Open the app once on every device you use (from the Home Screen icon on iPhone/iPad), and reload it
     so the new version runs.
  5. Wait at least 7 days (longer if a device is rarely used), checking Firebase console → **App Check** →
     **APIs** → **Cloud Firestore** → the request metrics. **Verified** requests come from the updated
     app; **Outdated client** requests come from copies still on the old version, which enforcement
     would block; **Unknown origin** / **Invalid** ones are scripts or other sites. It's safe to go on
     once verified requests are nearly all of the app's traffic and outdated client requests have
     been at zero for a few days.
  6. Same page → **Enforce** → confirm. It takes up to 15 minutes to apply. Then use the app on each
     device to check sync still works. To undo: same page → **Unenforce**.

## Desk robot: Claude Code status
A script on the laptop (run by Claude Code hooks and the status line) writes one doc with the Admin SDK:
`users/{uid}/robot/claude`. The app reads it while the desk robot is connected and you're signed in, and
shows running jobs, DONE! alerts and plan usage on the OLED (see `claudestatus.js`).

- **Values for the laptop's config.json:** in the app, ⚙ Settings → Sync → **Desk robot: Claude Code status**
  shows the project id (`pomodoro-timer-8d10f`), the full doc path with your user id, and copy buttons.
- **Rules:** the owner can read and delete that doc; no client can create or change it. Deploy the rules after
  any change to `firestore.rules`, from this `cloud` folder:
  ```
  firebase deploy --only firestore:rules
  ```
  or paste `firestore.rules` into Firebase console → **Firestore Database** → **Rules** → **Publish**.
- **Testing by hand:** Firebase console → Firestore → `users/<uid>/robot/claude` → set a `jobs` map with one
  entry (`state: "running"`, `name`, `updatedAt` = now in epoch ms, `startedAt` = a minute ago). The board shows it
  within a second or two. Then change `state` to `"done"` and add `finishedAt` = now: DONE! and a chime.

## Calendar feed (Apple Calendar)
The `calendarFeed` function serves a read-only calendar of your open tasks (all-day, on their due
date) and your Plan your day blocks (at their times). Apple Calendar, Google Calendar and Outlook can
subscribe to it. The link carries a random key saved in `users/{uid}/calfeed/key`; the function checks it
and answers 404 to anything else. Each feed is limited to 10 fetches a minute and 120 an hour.

1. From this `cloud` folder, deploy the rules and the function:
   ```
   firebase deploy --only firestore:rules,functions
   ```
2. In the app: ⚙ Settings → Sync → **Calendar feed (Apple Calendar)** → **Make my calendar link**.
3. On iPhone/iPad/Mac tap **Add to Apple Calendar** (or Calendar → File → New Calendar Subscription and paste
   the link). On iPhone, Settings → Calendar → Accounts → Subscribed Calendars → Fetch sets how often it updates.
4. Anyone with the link can read the calendar. **Reset link** makes a new key (the old link stops working);
   **Turn off** deletes the key.
