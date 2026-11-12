#include "head.h"
#include "config.h"
#include "power.h"

struct Pose { int16_t pan, tilt; };   // offsets from centre, us

// Gestures: a few poses each. The last pose is where the head stays.
static const Pose P_CENTER[]   = {{0, 0}};
static const Pose P_NOD[]      = {{0, -180}, {0, 60}, {0, -120}, {0, 0}};
static const Pose P_NO[]       = {{-220, 0}, {220, 0}, {-160, 0}, {0, 0}};
static const Pose P_LOOK_UP[]  = {{0, 250}};
static const Pose P_DROOP[]    = {{0, -300}};
static const Pose P_WIGGLE[]   = {{-300, 0}, {300, 0}, {0, -200}, {0, 150}, {0, 0}};
static const Pose P_GLANCE_L[] = {{-350, 60}, {-350, 60}, {0, 0}};
static const Pose P_GLANCE_R[] = {{350, 60}, {350, 60}, {0, 0}};
static const Pose P_PERK[]     = {{0, 200}, {0, 120}};
static const Pose P_CURIOUS[]  = {{150, 150}, {150, 150}, {0, 0}};
static const Pose P_CELEB[]    = {{-250, 200}, {250, 200}, {-250, 200}, {250, 200}, {0, 100}, {0, 0}};

struct GestureDef { const Pose* poses; uint8_t n; };
#define G(x) {x, sizeof(x) / sizeof(Pose)}
static const GestureDef GESTURES[] = {
  G(P_CENTER), G(P_NOD), G(P_NO), G(P_LOOK_UP), G(P_DROOP), G(P_WIGGLE),
  G(P_GLANCE_L), G(P_GLANCE_R), G(P_PERK), G(P_CURIOUS), G(P_CELEB),
};

struct Axis {
  int pin, lo, hi, centre;
  float pos, target, speed = 0;
  bool attached = false;
  uint32_t startAt = 0;
};
static Axis pan  {PIN_PAN,  PAN_MIN,  PAN_MAX,  PAN_CENTER,  PAN_CENTER,  PAN_CENTER};
static Axis tilt {PIN_TILT, TILT_MIN, TILT_MAX, TILT_CENTER, TILT_CENTER, TILT_CENTER};

enum Power : uint8_t { OFF, WARMING, ON, SETTLING };
static Power power = OFF;
static uint32_t powerAt = 0, lastFrame = 0;
static const Pose* seq = nullptr;
static uint8_t seqLen = 0, seqStep = 0;

static void writeAxis(Axis& a) { ledcWrite(a.pin, (uint32_t)(a.pos * 16384 / 20000)); }   // 14-bit @ 50 Hz

static void release(Axis& a) {
  if (a.attached) { ledcDetach(a.pin); a.attached = false; }
  pinMode(a.pin, OUTPUT);
  digitalWrite(a.pin, LOW);
}

static bool step(Axis& a, uint32_t now) {      // one 20 ms frame; true once at target
  if ((int32_t)(now - a.startAt) < 0) return false;
  if (!a.attached) { ledcAttach(a.pin, 50, 14); a.attached = true; }
  float left = fabsf(a.target - a.pos);
  if (left < 1) { a.pos = a.target; a.speed = 0; writeAxis(a); return true; }
  a.speed = min(min(a.speed + SERVO_ACCEL, SERVO_MAX_SPEED), sqrtf(2 * SERVO_ACCEL * left));  // trapezoid
  if (a.speed < 1) a.speed = 1;
  a.pos += (a.target > a.pos ? 1 : -1) * min(a.speed, left);
  writeAxis(a);
  return false;
}

static void setTarget(const Pose& p) {
  pan.target  = constrain(pan.centre  + p.pan,  pan.lo,  pan.hi);
  tilt.target = constrain(tilt.centre + p.tilt, tilt.lo, tilt.hi);
}

static bool begin() {
  if (batteryLow()) return false;          // a sagging cell + servo surge = brownout
  if (power == OFF) {
    digitalWrite(PIN_SERVO_EN, HIGH);      // power first, pulses SERVO_WARMUP_MS later
    power = WARMING;
    powerAt = millis();
  } else if (power == SETTLING) {
    power = ON;
  }
  return true;
}

void headBegin() {
  release(pan);
  release(tilt);
  pinMode(PIN_SERVO_EN, OUTPUT);
  digitalWrite(PIN_SERVO_EN, LOW);
}

bool headGesture(Gesture g) {
  if (g >= sizeof(GESTURES) / sizeof(GESTURES[0])) return false;
  if (!begin()) return false;
  seq = GESTURES[g].poses;
  seqLen = GESTURES[g].n;
  seqStep = 0;
  setTarget(seq[0]);
  return true;
}

void headLook(int panUs, int tiltUs) {
  if (!begin()) return;
  seq = nullptr;
  pan.target  = constrain(panUs,  pan.lo,  pan.hi);
  tilt.target = constrain(tiltUs, tilt.lo, tilt.hi);
}

bool headBusy()    { return power != OFF; }
bool headPowered() { return power != OFF; }

void headOff() {
  release(pan);
  release(tilt);
  digitalWrite(PIN_SERVO_EN, LOW);
  power = OFF;
  seq = nullptr;
}

void headUpdate() {
  uint32_t now = millis();
  switch (power) {
    case OFF: break;
    case WARMING:
      if (now - powerAt >= SERVO_WARMUP_MS) {
        pan.startAt = now;
        tilt.startAt = now + SERVO_STAGGER_MS;
        lastFrame = now - 20;
        power = ON;
      }
      break;
    case ON: {
      // Catch up if loop() was held up (an OLED frame is ~25 ms of I2C)
      int frames = min<int>((now - lastFrame) / 20, 3);
      if (frames <= 0) break;
      lastFrame += frames * 20;
      bool p = false, t = false;
      for (int i = 0; i < frames; i++) { p = step(pan, now); t = step(tilt, now); }
      if (p && t) {
        if (seq && ++seqStep < seqLen) setTarget(seq[seqStep]);
        else { power = SETTLING; powerAt = now; }
      }
      break;
    }
    case SETTLING:
      if (now - powerAt >= SERVO_HOLD_MS) {   // hold briefly, then go quiet
        release(pan);
        release(tilt);
        digitalWrite(PIN_SERVO_EN, LOW);
        power = OFF;
        seq = nullptr;
      }
      break;
  }
}
