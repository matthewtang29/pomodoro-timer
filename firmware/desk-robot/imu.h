// =============================================================================
// imu: LSM6DS3TR-C over I2C with plain register writes (same values as the
// Phase 2 stage 4/8 sketches). Detects shake, pick-up, face-down and gives a
// smoothed tilt for the eyes to follow.
// =============================================================================
#pragma once
#include <Arduino.h>

enum ImuEvent : uint8_t { IMU_NONE, IMU_SHAKE, IMU_PICKUP, IMU_FACE_DOWN, IMU_FACE_UP };

bool     imuBegin();            // false if WHO_AM_I is wrong / no chip
ImuEvent imuUpdate();           // call every loop(); at most one event per call
bool     imuFaceDown();
float    imuTiltX();            // -1..1, roll  (smoothed), for gaze
float    imuTiltY();            // -1..1, pitch (smoothed)
uint32_t imuLastMotion();       // millis() of last real movement
void     imuSleepMode();        // low-power wake-up config before deep sleep
