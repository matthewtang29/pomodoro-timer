#include "pomodoro.h"
#include "config.h"
#include "sound.h"
#include "power.h"
#include <Preferences.h>

// ---------------------------------------------------------------- state
static TState state = T_MENU;
static TState pausedFrom = T_FOCUS;
static TimerListener listener = nullptr;

static bool autoMode = false;
static int sessFocus = AUTO_FOCUS, sessBreak = AUTO_BREAK, sessCycles = 0;
static int cycleNum = 0, count = 0, totalFocus = 0;

static uint32_t phaseEnd = 0, phaseMs = 0, pausedLeft = 0, screenEnd = 0;
static uint32_t lastStatus = 0;
static long lastSentSecs = -1;

static Preferences prefs;           // last custom session survives a restart / deep sleep

// ---------------------------------------------------------------- helpers
static bool due(uint32_t t) { return (int32_t)(millis() - t) >= 0; }

static bool isTimed() {
  return state == T_GETREADY || state == T_FOCUS || state == T_REST || state == T_PAUSED;
}

bool timerInSession() { return state >= T_GETREADY && state <= T_CONTINUE; }

uint32_t timerMsLeft() {
  if (state == T_PAUSED) return pausedLeft;
  if (!isTimed()) return 0;
  int32_t d = (int32_t)(phaseEnd - millis());
  return d > 0 ? d : 0;
}

// Seconds as v1 reported them: GET READY counts 5..0, timers round up
static long statusSecs() {
  if (!isTimed()) return -1;
  if (state == T_GETREADY) return timerMsLeft() / 1000;
  return (timerMsLeft() + 999) / 1000;
}

static void goTo(TState s) {
  TState from = state;
  state = s;
  sendStatus();
  if (listener) listener(from, s);
}

static void showFor(TState s, uint32_t ms) {
  screenEnd = millis() + ms;
  goTo(s);
}

static void event(const char* name) { sendf(LINK_ALL, "EVENT %s", name); }

// ---------------------------------------------------------------- sessions
static void startGetReady() {
  phaseMs = GET_READY_MS;
  phaseEnd = millis() + phaseMs;
  goTo(T_GETREADY);
}

static void startPhase(TState s, int mins) {
  phaseMs = (uint32_t)mins * 60000UL;
  phaseEnd = millis() + phaseMs;
  goTo(s);
}

static void startSession(bool isAuto, int f, int b, int c) {
  autoMode = isAuto;
  sessFocus = f;
  sessBreak = b;
  sessCycles = isAuto ? 0 : c;
  cycleNum = 1;
  count = 0;
  totalFocus = 0;
  startGetReady();
}

static void endSession() {
  event("SESSION_ENDED");
  showFor(T_ENDED, 2000);
}

static void focusFinished() {
  count++;
  totalFocus += sessFocus;
  event("FOCUS_DONE");
  if (!autoMode && cycleNum >= sessCycles) { endSession(); return; }   // last cycle: no break
  showFor(T_FOCUS_DONE, 2000);
}

static void restFinished() {
  event("REST_DONE");
  showFor(T_CHECKPOINT, 1500);
}

// ---------------------------------------------------------------- actions
TResult timerAuto() {
  if (timerInSession()) return T_ERR_BUSY;
  startSession(true, AUTO_FOCUS, AUTO_BREAK, 0);
  return T_OK;
}

TResult timerStart(int f, int b, int c) {
  if (timerInSession()) return T_ERR_BUSY;
  if (f < 1 || f > REMOTE_MAX_MINS || b < 1 || b > REMOTE_MAX_MINS ||
      c < 1 || c > REMOTE_MAX_CYCLES) return T_ERR_RANGE;
  prefs.putUChar("lf", f); prefs.putUChar("lb", b); prefs.putUChar("lc", c);
  startSession(false, f, b, c);
  return T_OK;
}

TResult timerRepeatLast() {
  int f = prefs.getUChar("lf", 0), b = prefs.getUChar("lb", 0), c = prefs.getUChar("lc", 0);
  if (!f) return timerAuto();
  return timerStart(f, b, c);
}

TResult timerPause() {
  if (state != T_FOCUS && state != T_REST) return T_ERR_STATE;
  pausedLeft = timerMsLeft();
  pausedFrom = state;
  goTo(T_PAUSED);
  return T_OK;
}

TResult timerResume() {
  if (state != T_PAUSED) return T_ERR_STATE;
  phaseEnd = millis() + pausedLeft;
  goTo(pausedFrom);
  return T_OK;
}

TResult timerExit() {
  if (!timerInSession()) return T_ERR_STATE;
  event("EXITED");
  showFor(T_EXITED, 1500);
  return T_OK;
}

TResult timerAnswer(bool yes) {
  if (state != T_CONTINUE) return T_ERR_STATE;
  if (yes) { cycleNum++; startGetReady(); }
  else showFor(T_SUMMARY, 2500);
  return T_OK;
}

TResult timerSkip() {
  if (state == T_GETREADY || state == T_REST) { phaseEnd = millis(); return T_OK; }
  return T_ERR_STATE;
}

// ---------------------------------------------------------------- update
void timerBegin(TimerListener l) {
  listener = l;
  prefs.begin("pomodoro", false);
  sendLine("READY");
  sendStatus();
}

void timerUpdate() {
  switch (state) {
    case T_GETREADY: if (timerMsLeft() == 0) startPhase(T_FOCUS, sessFocus); break;
    case T_FOCUS:    if (timerMsLeft() == 0) focusFinished(); break;
    case T_REST:     if (timerMsLeft() == 0) restFinished(); break;
    case T_FOCUS_DONE:
      if (due(screenEnd)) startPhase(T_REST, sessBreak);
      break;
    case T_CHECKPOINT:
      if (due(screenEnd)) {
        if (autoMode) goTo(T_CONTINUE);
        else { cycleNum++; startGetReady(); }
      }
      break;
    case T_ENDED:
    case T_EXITED:
      if (due(screenEnd)) showFor(T_SUMMARY, 2500);
      break;
    case T_SUMMARY:
      if (due(screenEnd)) goTo(T_MENU);
      break;
    default: break;
  }
  // v1: a STATE line whenever the seconds change, plus a heartbeat every second
  if (statusSecs() != lastSentSecs || millis() - lastStatus >= STATE_EVERY_MS) sendStatus();
}

// ---------------------------------------------------------------- protocol
static void reply(TResult r, Link to) {
  static const char* const ERR[] = {"", "ERR BUSY", "ERR RANGE", "ERR STATE"};
  if (r != T_OK) sendLine(ERR[r], to);   // errors go back only to whoever asked
}

void protocolHandle(char* cmd, Link from) {
  int f, b, c;
  if      (!strcmp(cmd, "STATUS")) sendStatus(from);
  else if (!strcmp(cmd, "AUTO"))   reply(timerAuto(), from);
  else if (!strncmp(cmd, "START", 5)) {
    if (sscanf(cmd, "START %d %d %d", &f, &b, &c) != 3) sendLine("ERR UNKNOWN", from);
    else reply(timerStart(f, b, c), from);
  }
  else if (!strcmp(cmd, "PAUSE"))  reply(timerPause(), from);
  else if (!strcmp(cmd, "RESUME")) reply(timerResume(), from);
  else if (!strcmp(cmd, "EXIT"))   reply(timerExit(), from);
  else if (!strcmp(cmd, "YES"))    reply(timerAnswer(true), from);
  else if (!strcmp(cmd, "NO"))     reply(timerAnswer(false), from);
  else if (!strcmp(cmd, "MUTE"))   { soundSetMuted(true);  sendStatus(); }
  else if (!strcmp(cmd, "UNMUTE")) { soundSetMuted(false); sendStatus(); }
  // ---- additions (v1 apps never send these) ----
  else if (!strcmp(cmd, "INFO"))
    sendf(from, "INFO fw=" FW_VERSION " bat=%d mv=%lu usb=%d ble=%d",
          batteryPercent(), (unsigned long)batteryMv(), usbConnected(), bleConnected());
  else sendLine("ERR UNKNOWN", from);
}

const char* timerStateName() {
  switch (state) {
    case T_GETREADY:   return "GETREADY";
    case T_FOCUS:      return "FOCUS";
    case T_REST:       return "REST";
    case T_PAUSED:     return pausedFrom == T_FOCUS ? "PAUSED_FOCUS" : "PAUSED_REST";
    case T_FOCUS_DONE: return "FOCUS_DONE";
    case T_CHECKPOINT: return "CHECKPOINT";
    case T_CONTINUE:   return "CONTINUE";
    case T_ENDED:      return "ENDED";
    case T_EXITED:     return "EXITED";
    case T_SUMMARY:    return "SUMMARY";
    default:           return "MENU";
  }
}

void sendStatus(Link to) {
  long secs = statusSecs();
  lastStatus = millis();
  lastSentSecs = secs;
  // Same fields, same order as v1. Nothing is appended, so older parsers
  // and the Firestore relay see exactly what the Uno sent.
  sendf(to, "STATE state=%s left=%ld cycle=%d cycles=%d focus=%d break=%d done=%d total=%d mode=%s muted=%d",
        timerStateName(), secs < 0 ? 0 : secs, cycleNum, sessCycles, sessFocus, sessBreak,
        count, totalFocus, autoMode ? "AUTO" : "CUSTOM", soundMuted() ? 1 : 0);
}

// ---------------------------------------------------------------- getters
TState   timerState()      { return state; }
TState   timerPausedFrom() { return pausedFrom; }
uint32_t timerPhaseMs()    { return phaseMs; }
int      timerCycle()      { return cycleNum; }
int      timerCycles()     { return sessCycles; }
int      timerDone()       { return count; }
int      timerTotalMin()   { return totalFocus; }
bool     timerAutoMode()   { return autoMode; }
