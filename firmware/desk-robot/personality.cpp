#include "personality.h"
#include "config.h"
#include "face.h"
#include "head.h"
#include "sound.h"
#include "power.h"
#include "links.h"

static uint32_t lastInteract = 0, nextGlance = 0, nextHeadIdle = 0;
static uint32_t sleepNowAt = 0;        // B long at the menu: sleep on purpose
static bool sleepy = false, lowBatWarned = false;

static bool due(uint32_t t) { return (int32_t)(millis() - t) >= 0; }
static void touched() { lastInteract = millis(); faceDim(false); }

static bool quietState() {   // focus: don't move, don't beep
  TState s = timerState();
  return s == T_FOCUS || s == T_GETREADY;
}

void personalityBegin() {
  lastInteract = millis();
  nextGlance = millis() + 4000;
  nextHeadIdle = millis() + 30000;
  faceSetBase(E_NEUTRAL);
  if (wokeFromSleep()) {
    faceFlash(E_SURPRISED, 600);
    soundPlay(Tune::SURPRISE);
    headGesture(G_PERK);
  } else {
    faceFlash(E_HAPPY, 1500);
    soundPlay(Tune::HELLO);
    headGesture(G_WIGGLE);
    faceToast("A: start 25/5", 3000);
  }
}

// ---------------------------------------------------------------- timer
void onTimerChange(TState from, TState to) {
  touched();
  sleepy = false;
  switch (to) {
    case T_GETREADY:
      faceSetBase(E_NEUTRAL);
      faceFlash(E_HAPPY, 800);
      soundPlay(Tune::START);
      headGesture(G_PERK);
      break;
    case T_FOCUS:
      faceSetBase(E_FOCUS);
      faceGaze(0, 0.3f);                 // eyes down, "reading"
      soundPlay(from == T_PAUSED ? Tune::RESUME : Tune::CLICK);
      headGesture(G_CENTER);
      break;
    case T_REST:
      faceSetBase(E_HAPPY);
      faceGaze(0, 0);
      if (from == T_PAUSED) soundPlay(Tune::RESUME);
      break;
    case T_PAUSED:
      faceSetBase(E_SAD);
      soundPlay(Tune::PAUSE);
      headGesture(G_TILT_CURIOUS);
      break;
    case T_FOCUS_DONE:
      faceSetBase(E_HAPPY);
      faceFlash(E_LOVE, 1800);
      soundPlay(Tune::FOCUS_DONE);
      headGesture(G_NOD);
      break;
    case T_CHECKPOINT:
      faceSetBase(E_NEUTRAL);
      soundPlay(Tune::REST_DONE);
      headGesture(G_PERK);
      break;
    case T_CONTINUE:
      faceSetBase(E_SURPRISED);
      headGesture(G_TILT_CURIOUS);
      break;
    case T_ENDED:
      faceSetBase(E_LOVE);
      soundPlay(Tune::ENDED);
      headGesture(G_CELEBRATE);
      break;
    case T_EXITED:
      faceSetBase(E_SAD);
      soundPlay(Tune::EXITED);
      headGesture(G_DROOP);
      break;
    case T_SUMMARY:
      faceSetBase(timerDone() > 0 ? E_HAPPY : E_NEUTRAL);
      headGesture(G_CENTER);
      break;
    case T_MENU:
      faceSetBase(E_NEUTRAL);
      faceGaze(0, 0);
      break;
  }
}

// ---------------------------------------------------------------- buttons / pad
static void refused() {
  faceFlash(E_ANNOYED, 700);
  soundPlay(Tune::BOOP);
  if (!quietState()) headGesture(G_NO);
}

static void act(TResult r) { if (r != T_OK) refused(); }

void onInput(InputEvent e) {
  if (e == IN_NONE) return;
  touched();
  sleepNowAt = 0;
  if (sleepy) { sleepy = false; faceSetBase(E_NEUTRAL); faceFlash(E_SURPRISED, 500); headGesture(G_CENTER); }
  TState s = timerState();

  switch (e) {
    case IN_AB:
      soundSetMuted(!soundMuted());
      faceToast(soundMuted() ? "sound off" : "sound on", 1200);
      sendStatus();
      break;

    case IN_A_SHORT:
      soundPlay(Tune::CLICK);
      if (s == T_MENU)                         act(timerAuto());
      else if (s == T_FOCUS || s == T_REST)    act(timerPause());
      else if (s == T_PAUSED)                  act(timerResume());
      else if (s == T_CONTINUE)                act(timerAnswer(true));
      break;

    case IN_A_LONG:
      if (s == T_MENU) act(timerRepeatLast());          // last custom session from the app
      else if (s == T_GETREADY || s == T_REST) act(timerSkip());
      else refused();                                   // a focus block can't be skipped
      break;

    case IN_B_SHORT:
      soundPlay(Tune::CLICK);
      if (s == T_CONTINUE) act(timerAnswer(false));
      else faceStatusPage(4000);
      break;

    case IN_B_LONG:
      if (timerInSession()) act(timerExit());
      else {                                            // at the menu: go to sleep now
        faceSetBase(E_SLEEPY);
        soundPlay(Tune::SLEEPY);
        sleepy = true;
        sleepNowAt = millis() + 1500;
        headGesture(G_DROOP);
      }
      break;

    case IN_PET_START:
      if (quietState()) faceFlash(E_HAPPY, 1500);       // quiet thanks during focus
      else {
        faceFlash(E_LOVE, 2500);
        soundPlay(Tune::PURR);
        headGesture(G_NOD);
      }
      break;

    default: break;
  }
}

// ---------------------------------------------------------------- motion
void onMotion(ImuEvent e) {
  if (e == IMU_NONE) return;
  TState s = timerState();
  switch (e) {
    case IMU_SHAKE:
      touched();
      if (s == T_FOCUS || s == T_REST) { timerPause(); faceFlash(E_SURPRISED, 800); }
      else { faceFlash(E_ANNOYED, 1200); faceToast("whoa, dizzy", 1200); }
      break;
    case IMU_PICKUP:
      touched();
      if (sleepy) { sleepy = false; faceSetBase(E_NEUTRAL); }
      faceFlash(E_SURPRISED, 600);
      if (!quietState()) soundPlay(Tune::SURPRISE);
      break;
    case IMU_FACE_DOWN:
      faceOff();               // timer keeps running; saves ~10 mA
      break;
    case IMU_FACE_UP:
      touched();
      faceOn();
      faceFlash(E_HAPPY, 800);
      break;
    default: break;
  }
}

// ---------------------------------------------------------------- idle life
void personalityUpdate() {
  uint32_t now = millis();
  TState s = timerState();
  uint32_t idleFor = now - max(lastInteract, max(inputsLastActivity(), imuLastMotion()));

  // Being held: eyes follow the tilt. On the desk: occasional glances.
  bool held = now - imuLastMotion() < 1500;
  if (held && s != T_FOCUS) faceGaze(imuTiltX(), -imuTiltY());
  else if (due(nextGlance)) {
    nextGlance = now + random(3000, 9000);
    if (s == T_FOCUS) faceGaze(random(-3, 4) / 10.0f, 0.3f);   // small reading drift
    else if (random(3) == 0) faceGaze(0, 0);
    else faceGaze(random(-10, 11) / 10.0f, random(-5, 6) / 10.0f);
  }

  // Head idles (servo noise + battery): menu and breaks only, not too often
  if ((s == T_MENU || s == T_REST) && !sleepy && due(nextHeadIdle) && !headBusy()) {
    nextHeadIdle = now + random(45000, 120000);
    static const Gesture IDLE[] = {G_GLANCE_L, G_GLANCE_R, G_TILT_CURIOUS};
    headGesture(IDLE[random(3)]);
  }

  // Long focus block and nobody touching it: dim the panel
  if (s == T_FOCUS && idleFor > DIM_AFTER_MS) faceDim(true);

  // Low battery: say it once
  if (batteryLow() && !lowBatWarned) { lowBatWarned = true; faceToast("low battery", 3000); }
  if (!batteryLow()) lowBatWarned = false;

  // Sleep: only idle at the menu, and never while an app is connected
  bool appConnected = usbConnected() || bleConnected();
  if (s == T_MENU) {
    if (!sleepy && idleFor > SLEEP_AFTER_MS - 10000) {
      sleepy = true;
      faceSetBase(E_SLEEPY);
      headGesture(G_DROOP);
    }
    bool buttonsUp = digitalRead(PIN_BTN_A) && digitalRead(PIN_BTN_B);   // a held button would wake it at once
    bool asked = sleepNowAt && due(sleepNowAt);
    if (sleepy && (asked || (idleFor > SLEEP_AFTER_MS && !appConnected)) && !headBusy() && buttonsUp)
      powerSleepNow();
  } else {
    sleepNowAt = 0;
  }
}
