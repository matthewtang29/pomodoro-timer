#include "inputs.h"
#include "config.h"

struct Button {
  int pin;
  bool raw = HIGH, stable = HIGH;            // HIGH = released (INPUT_PULLUP)
  uint32_t rawAt = 0, downAt = 0;
  bool longDone = false, used = false;       // used = swallowed by A+B
};
static Button a{PIN_BTN_A}, b{PIN_BTN_B};

static uint32_t padBase = 0, lastPad = 0, lastActivity = 0;
static bool pet = false;

static bool debounce(Button& k, uint32_t now) {   // true on a clean edge
  bool r = digitalRead(k.pin);
  if (r != k.raw) { k.raw = r; k.rawAt = now; }
  if (now - k.rawAt >= DEBOUNCE_MS && k.stable != k.raw) { k.stable = k.raw; return true; }
  return false;
}

void inputsBegin() {
  pinMode(PIN_BTN_A, INPUT_PULLUP);
  pinMode(PIN_BTN_B, INPUT_PULLUP);
  // A button held at boot (it woke us) shouldn't also count as a press
  uint32_t now = millis();
  a.raw = a.stable = digitalRead(PIN_BTN_A);
  b.raw = b.stable = digitalRead(PIN_BTN_B);
  if (a.stable == LOW) a.used = true;
  if (b.stable == LOW) b.used = true;
  // Pad baseline: don't touch the pad during the first ~50 ms after boot
  for (int i = 0; i < 16; i++) padBase += touchRead(PIN_PAD);
  padBase /= 16;
  lastActivity = now;
}

InputEvent inputsUpdate() {
  uint32_t now = millis();
  bool aEdge = debounce(a, now), bEdge = debounce(b, now);
  bool aDown = a.stable == LOW, bDown = b.stable == LOW;
  if (aEdge || bEdge) lastActivity = now;

  if (aEdge && aDown) { a.downAt = now; a.longDone = a.used = false; }
  if (bEdge && bDown) { b.downAt = now; b.longDone = b.used = false; }

  if (aDown && bDown && !a.used && !b.used) { a.used = b.used = true; return IN_AB; }
  if (aDown && !a.used && !a.longDone && now - a.downAt >= A_LONG_MS) { a.longDone = true; return IN_A_LONG; }
  if (bDown && !b.used && !b.longDone && now - b.downAt >= B_LONG_MS) { b.longDone = true; return IN_B_LONG; }
  if (aEdge && !aDown && !a.used && !a.longDone) return IN_A_SHORT;
  if (bEdge && !bDown && !b.used && !b.longDone) return IN_B_SHORT;

  if (now - lastPad >= PAD_SAMPLE_MS) {
    lastPad = now;
    uint32_t v = touchRead(PIN_PAD);                       // goes UP when touched on the S3
    bool t = v > padBase + padBase * PAD_TRIGGER_PCT / 100;
    if (!t) padBase = (padBase * 63 + v) / 64;             // follow slow drift while untouched
    if (t != pet) {
      pet = t;
      lastActivity = now;
      return t ? IN_PET_START : IN_PET_END;
    }
  }
  return IN_NONE;
}

uint32_t inputsLastActivity() { return lastActivity; }
bool petting() { return pet; }
