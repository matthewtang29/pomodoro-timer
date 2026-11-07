// =============================================================================
// face: two animated eyes on the 128x64 SH1106 OLED (U8g2, full buffer),
// plus the timer readout under them during a session. Expressions are a few
// numbers (eye size, lids, smile, gaze) that ease toward their targets, so any
// change of mood animates by itself. A frame is only sent over I2C when the
// picture actually changed, so a still face costs no bus time.
// =============================================================================
#pragma once
#include <Arduino.h>

enum Expr : uint8_t { E_NEUTRAL, E_FOCUS, E_HAPPY, E_SLEEPY, E_SURPRISED, E_SAD, E_ANNOYED, E_LOVE, E_COUNT };

bool faceBegin();
void faceUpdate();
void faceSetBase(Expr e);                       // the mood for the current state
void faceFlash(Expr e, uint32_t ms);            // a reaction, then back to the base mood
void faceGaze(float x, float y);                // -1..1 each; 0,0 = looking at you
void faceToast(const char* text, uint32_t ms);  // one line of text under the eyes
void faceStatusPage(uint32_t ms);               // battery / Bluetooth / USB page
void faceDim(bool dim);
void faceOff();                                 // panel power save (face-down, sleep)
void faceOn();
bool faceIsOff();
