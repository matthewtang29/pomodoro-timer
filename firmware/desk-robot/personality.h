// =============================================================================
// personality: the glue. Turns timer changes, buttons, petting and motion into
// faces, sounds and head moves, and decides when to dim and when to sleep.
// The rules in one line each:
//   focus  = still, narrowed eyes, no head moves, no sounds except at the end
//   break  = happy, glances around now and then
//   menu   = curious idle; gets sleepy, then deep-sleeps if nobody is around
// =============================================================================
#pragma once
#include "pomodoro.h"
#include "inputs.h"
#include "imu.h"

void personalityBegin();
void personalityUpdate();
void onTimerChange(TState from, TState to);
void onInput(InputEvent e);
void onMotion(ImuEvent e);
