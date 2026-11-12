/*
  Desk Robot firmware (v2 of the Pomodoro timer) - Matthew Tang
  Seeed XIAO ESP32-S3 Plus + 1.3" SH1106 OLED + 2x SG90 + LSM6DS3TR-C
  + 2 buttons + pet pad + piezo, on a 1S LiPo.

  Same idea as v1: one non-blocking loop(). Nothing calls delay(); every module
  has an update() that checks millis() and returns at once if it has nothing
  to do. The v1 timer state machine is unchanged, and the USB line protocol
  is the same, so Pomegranate works with it as it is. The same lines also go
  over Bluetooth LE (Nordic UART Service).

  Arduino IDE: board "XIAO_ESP32S3", USB CDC On Boot: Enabled,
  esp32 core by Espressif 3.x, library U8g2. See README.md.

  ---------------------------- PROTOCOL (USB 115200, or BLE NUS) ----------------------------
  App -> robot:  START f b c | AUTO | PAUSE | RESUME | EXIT | YES | NO | MUTE | UNMUTE | STATUS
                 INFO  (new: battery / link details, the app doesn't need it)
  Robot -> app:  READY (once at boot)
                 STATE state= left= cycle= cycles= focus= break= done= total= mode= muted=
                 EVENT FOCUS_DONE | REST_DONE | SESSION_ENDED | EXITED
                 ERR BUSY | RANGE | STATE | UNKNOWN   (only to whoever sent the command)
                 INFO fw= bat= mv= usb= ble=          (reply to INFO)

  ---------------------------- BUTTONS ----------------------------
  A short   start 25/5 (menu) / pause / resume / YES
  A long    repeat the last custom session (menu) / skip GET READY or a break
  B short   NO on the continue prompt, otherwise the status page
  B long    exit the session / go to sleep (menu)
  A + B     mute / unmute
  Pet pad   it likes that.  Shake: pause.  Pick up: wakes it.  Face down: screen off.
*/

#include "config.h"
#include "links.h"
#include "pomodoro.h"
#include "face.h"
#include "head.h"
#include "imu.h"
#include "inputs.h"
#include "sound.h"
#include "power.h"
#include "personality.h"

static uint32_t loopMaxUs = 0, lastLoopReport = 0;

void setup() {
  headBegin();                  // first: servo power off, signal pins low
  powerBegin();
  soundBegin();
  inputsBegin();
  linksBegin(protocolHandle);

  if (!faceBegin()) Serial.println("# OLED not found (check SDA/SCL, 0x3C)");
  if (!imuBegin())  Serial.println("# IMU not found (WHO_AM_I != 0x6A; try IMU_ADDR 0x6B)");
  Serial.printf("# desk robot " FW_VERSION ", woke: %s\n", wakeReason());

  timerBegin(onTimerChange);    // sends READY + the first STATE
  personalityBegin();
}

void loop() {
  uint32_t t0 = micros();

  linksUpdate();                // USB + BLE lines -> protocolHandle()
  onInput(inputsUpdate());
  onMotion(imuUpdate());
  timerUpdate();                // may call onTimerChange()
  personalityUpdate();
  headUpdate();
  soundUpdate();
  powerUpdate();
  faceUpdate();                 // last: draws whatever the others decided

  // Debug: worst loop time each 10 s, as a '#' comment line the app ignores
  // (it only acts on STATE / EVENT / ERR). Turn it off with DEBUG_LOOP 0.
#ifndef DEBUG_LOOP
#define DEBUG_LOOP 0
#endif
  uint32_t dt = micros() - t0;
  if (dt > loopMaxUs) loopMaxUs = dt;
  if (DEBUG_LOOP && millis() - lastLoopReport > 10000) {
    lastLoopReport = millis();
    sendf(LINK_USB, "# loop max %lu us", (unsigned long)loopMaxUs);
    loopMaxUs = 0;
  }
}
