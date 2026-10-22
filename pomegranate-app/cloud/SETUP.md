# Cloud alerts setup

This folder holds a small Firebase cloud function that sends "focus done", "break over" and "session complete" alerts to your devices at the exact time, even when the app is closed. Timer sync between devices works without it; only the closed-app alerts need it.

You only do this once. It takes about 15 minutes.

## 1. Switch Firebase to the pay-as-you-go plan
Cloud functions need Firebase's **Blaze** plan, which requires a card on file. At this app's usage everything stays inside the free monthly allowances (Cloud Functions, Cloud Tasks and Secret Manager), so it should cost **$0**.

1. Open the [Firebase console](https://console.firebase.google.com/), pick **pomodoro-timer-8d10f**.
2. Click **Upgrade** (bottom of the left sidebar) and choose **Blaze**.
3. When it offers a budget alert, set one at **$1** so you're emailed if anything ever costs money.

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
