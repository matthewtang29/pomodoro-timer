// =============================================================================
// pomodoro: the v1 timer state machine, ported as-is minus the LCD menus.
// Same states, same timing (absolute phaseEnd from millis()), same protocol.
// Custom sessions are set up from the app (START f b c); the robot's buttons
// start AUTO or repeat the last custom session.
// =============================================================================
#pragma once
#include <Arduino.h>
#include "links.h"

enum TState : uint8_t {
  T_MENU,
  T_GETREADY, T_FOCUS, T_REST, T_PAUSED,          // timers
  T_FOCUS_DONE, T_CHECKPOINT, T_CONTINUE,         // between timers
  T_ENDED, T_EXITED, T_SUMMARY                    // end of a session
};

enum TResult : uint8_t { T_OK, T_ERR_BUSY, T_ERR_RANGE, T_ERR_STATE };

// Called on every state change, after the STATE line went out.
using TimerListener = void (*)(TState from, TState to);

void timerBegin(TimerListener listener);
void timerUpdate();                 // moves on when a timer / message screen runs out

// Actions. The protocol handler and the buttons both go through these.
TResult timerAuto();
TResult timerStart(int focusMin, int breakMin, int cycles);
TResult timerRepeatLast();          // last START f b c (kept in flash), else AUTO
TResult timerPause();
TResult timerResume();
TResult timerExit();
TResult timerAnswer(bool yes);      // CONTINUE prompt
TResult timerSkip();                // end GET READY or a break early (never a focus block)

// Line protocol: one command line in, replies / errors out to the sender.
void protocolHandle(char* line, Link from);
void sendStatus(Link to = LINK_ALL);

// For the face
TState   timerState();
TState   timerPausedFrom();         // T_FOCUS or T_REST
uint32_t timerMsLeft();
uint32_t timerPhaseMs();            // full length of the current phase
int      timerCycle();
int      timerCycles();             // 0 = auto (unlimited)
int      timerDone();               // focus blocks finished
int      timerTotalMin();
bool     timerAutoMode();
bool     timerInSession();
const char* timerStateName();
