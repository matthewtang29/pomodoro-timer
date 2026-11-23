// =============================================================================
// head: pan + tilt servos behind the AO3401A high-side switch. Same rules as
// the Phase 2 stage 6 sketch: power on, wait 20 ms, then pulses; ramped moves;
// pan and tilt start 50 ms apart; hold 300 ms then cut power; signal pins held
// LOW whenever the servos are unpowered (no back-feeding through the inputs).
// Moves are queued as short gestures (lists of poses).
// =============================================================================
#pragma once
#include <Arduino.h>

enum Gesture : uint8_t {
  G_CENTER, G_NOD, G_NO, G_LOOK_UP, G_DROOP, G_WIGGLE, G_GLANCE_L, G_GLANCE_R,
  G_PERK, G_TILT_CURIOUS, G_CELEBRATE,
};

void headBegin();
void headUpdate();
bool headGesture(Gesture g);    // replaces any move in progress; false if refused (low battery)
void headLook(int panUs, int tiltUs);   // single move to an absolute pose
bool headBusy();
bool headPowered();             // servo rail is on (the IMU ignores its own jolts then)
void headOff();                 // stop now, power off, pins low
