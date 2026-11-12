// =============================================================================
// power: battery voltage (our own 470k/470k divider on GPIO10) and deep sleep.
// Deep sleep only ever happens idle at the menu, so no session is lost.
// Wakes on button A, button B or the IMU's movement interrupt (pick-up).
// =============================================================================
#pragma once
#include <Arduino.h>

void     powerBegin();
void     powerUpdate();
uint32_t batteryMv();           // smoothed
int      batteryPercent();      // rough LiPo curve, 0..100
bool     batteryLow();          // below LOW_BAT_MV: no head moves
void     powerSleepNow();       // never returns
const char* wakeReason();       // why we booted, for the hello animation
bool     wokeFromSleep();
