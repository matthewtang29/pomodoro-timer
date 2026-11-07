#include "imu.h"
#include "config.h"
#include "head.h"
#include <Wire.h>

// Registers (LSM6DS3TR-C datasheet / AN5130) [verify against your chip]
enum : uint8_t {
  WHO_AM_I = 0x0F, CTRL1_XL = 0x10, CTRL6_C = 0x15, WAKE_UP_SRC = 0x1B,
  OUTX_L_XL = 0x28, TAP_CFG = 0x58, WAKE_UP_THS = 0x5B, WAKE_UP_DUR = 0x5C, MD1_CFG = 0x5E,
};
constexpr float G_PER_LSB = 0.000122f;   // +/-4 g

static bool ok = false;
static uint32_t lastSample = 0, lastJolt = 0, firstJolt = 0, downSince = 0, lastMotion = 0;
static int jolts = 0;
static bool faceDown = false;
static float tx = 0, ty = 0;           // smoothed tilt
static float gAvg = 1.0f;              // slow average of |g|, for pick-up detection
static uint32_t stillSince = 0;

static void wr(uint8_t reg, uint8_t v) {
  Wire.beginTransmission(IMU_ADDR); Wire.write(reg); Wire.write(v); Wire.endTransmission();
}
static int rd(uint8_t reg) {
  Wire.beginTransmission(IMU_ADDR); Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom((int)IMU_ADDR, 1) != 1) return -1;
  return Wire.read();
}
static bool readAccel(float& x, float& y, float& z) {
  Wire.beginTransmission(IMU_ADDR); Wire.write(OUTX_L_XL);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)IMU_ADDR, 6) != 6) return false;
  int16_t v[3];
  for (int i = 0; i < 3; i++) { uint8_t lo = Wire.read(), hi = Wire.read(); v[i] = (int16_t)(hi << 8 | lo); }
  x = v[0] * G_PER_LSB; y = v[1] * G_PER_LSB; z = v[2] * G_PER_LSB;
  return true;
}

bool imuBegin() {
  pinMode(PIN_IMU_INT, INPUT);
  int id = rd(WHO_AM_I);
  ok = (id == 0x6A);
  if (!ok) return false;
  wr(CTRL6_C, 0x00);        // high-performance on (undo sleep mode)
  wr(CTRL1_XL, 0x48);       // 104 Hz, +/-4 g
  wr(TAP_CFG, 0x81);        // basic interrupts on, latched
  wr(WAKE_UP_THS, WAKE_THS);
  wr(WAKE_UP_DUR, 0x00);
  wr(MD1_CFG, 0x20);        // wake-up event -> INT1
  rd(WAKE_UP_SRC);          // clear the latch left over from sleep
  lastMotion = millis();
  return true;
}

void imuSleepMode() {
  if (!ok) return;
  wr(CTRL6_C, 0x10);        // high-performance off -> low power
  wr(CTRL1_XL, 0x18);       // 12.5 Hz, +/-4 g
  wr(TAP_CFG, 0x81);
  wr(WAKE_UP_THS, WAKE_THS);
  wr(MD1_CFG, 0x20);
  rd(WAKE_UP_SRC);          // clear, so it doesn't wake us instantly
}

ImuEvent imuUpdate() {
  if (!ok) return IMU_NONE;
  uint32_t now = millis();
  if (now - lastSample < 10) return IMU_NONE;   // 100 Hz
  lastSample = now;

  float x, y, z;
  if (!readAccel(x, y, z)) return IMU_NONE;
  float g = sqrtf(x * x + y * y + z * z);
  ImuEvent ev = IMU_NONE;

  // The head's own servo moves shake the body. Ignore jolts while they run,
  // otherwise every nod would read as a shake.
  bool selfMoving = headPowered();

  // Shake: SHAKE_JOLTS jolts over SHAKE_G within SHAKE_WINDOW_MS, 120 ms apart
  if (!selfMoving && g > SHAKE_G && now - lastJolt > 120) {
    lastJolt = now;
    if (jolts == 0 || now - firstJolt > SHAKE_WINDOW_MS) { jolts = 0; firstJolt = now; }
    if (++jolts >= SHAKE_JOLTS) { ev = IMU_SHAKE; jolts = 0; }
  }

  // Pick-up: after >= 2 s of sitting still, |g| leaves 1 g by more than 0.15 g
  float dev = fabsf(g - gAvg);
  gAvg += (g - gAvg) * 0.02f;
  if (dev > 0.06f && !selfMoving) lastMotion = now;   // its own nods don't count as being handled
  if (dev < 0.04f) {
    if (!stillSince) stillSince = now;
  } else if (dev > 0.15f) {
    if (!selfMoving && stillSince && now - stillSince > 2000 && ev == IMU_NONE) ev = IMU_PICKUP;
    stillSince = 0;
  }

  // Face down: z below -0.8 g for FACEDOWN_MS
  bool down = z < -0.8f;
  if (down && !downSince) downSince = now;
  if (!down) downSince = 0;
  bool fd = downSince && now - downSince > FACEDOWN_MS;
  if (fd != faceDown) { faceDown = fd; if (ev == IMU_NONE) ev = fd ? IMU_FACE_DOWN : IMU_FACE_UP; }

  // Tilt for the eyes, heavily smoothed so they drift rather than jitter
  tx += (constrain(x, -1.0f, 1.0f) - tx) * 0.05f;
  ty += (constrain(y, -1.0f, 1.0f) - ty) * 0.05f;

  // Keep INT1's latch clear while awake so it's ready for sleep
  if (digitalRead(PIN_IMU_INT)) rd(WAKE_UP_SRC);

  return ev;
}

bool     imuFaceDown()     { return faceDown; }
float    imuTiltX()        { return tx; }
float    imuTiltY()        { return ty; }
uint32_t imuLastMotion()   { return lastMotion; }
