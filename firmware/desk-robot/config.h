// =============================================================================
// config.h: every pin and every number you might want to tune, in one place.
// Pins match the breadboard bring-up page (Phase 2) and build guide rev A.
// Values marked [calibrate] come from your own bench results.
// =============================================================================
#pragma once
#include <Arduino.h>

// ------------------------------------------------------------------ pins
// XIAO ESP32-S3 Plus: D-label -> GPIO
constexpr int PIN_PAD      = 1;   // D0  capacitive pet pad (touch channel)
constexpr int PIN_BTN_A    = 2;   // D1  button A to GND (INPUT_PULLUP)
constexpr int PIN_IMU_INT  = 3;   // D2  LSM6DS3TR-C INT1 (wake-up, active high)
constexpr int PIN_BTN_B    = 4;   // D3  button B to GND (INPUT_PULLUP)
constexpr int PIN_SDA      = 5;   // D4  I2C (OLED 0x3C + IMU 0x6A)
constexpr int PIN_SCL      = 6;   // D5
constexpr int PIN_PIEZO    = 44;  // D7  passive piezo
constexpr int PIN_PAN      = 7;   // D8  pan servo signal
constexpr int PIN_TILT     = 8;   // D9  tilt servo signal
constexpr int PIN_SERVO_EN = 9;   // D10 Q2 gate -> Q1 high-side switch. HIGH = servos powered
constexpr int PIN_BAT_ADC  = 10;  // back pad, 470k/470k divider + 100 nF
// D6 (GPIO43) is free: vibration motor if you keep it. Not used here.

// ------------------------------------------------------------------ names
#define ROBOT_NAME   "DeskBot"   // Bluetooth name
#define FW_VERSION   "0.1.0"

// ------------------------------------------------------------------ timer (same as v1)
constexpr int AUTO_FOCUS = 25, AUTO_BREAK = 5;
constexpr int REMOTE_MAX_MINS = 99, REMOTE_MAX_CYCLES = 20;
constexpr uint32_t GET_READY_MS = 6000;      // shows 5..0

// ------------------------------------------------------------------ buttons
constexpr uint32_t DEBOUNCE_MS   = 30;
constexpr uint32_t A_LONG_MS     = 1000;
constexpr uint32_t B_LONG_MS     = 2000;

// ------------------------------------------------------------------ pet pad
// On the S3 touchRead() goes UP when touched. Trigger = baseline + this %.
constexpr uint32_t PAD_TRIGGER_PCT = 5;      // [calibrate] 8-10 % if it self-triggers
constexpr uint32_t PAD_SAMPLE_MS   = 50;

// ------------------------------------------------------------------ IMU
constexpr uint8_t  IMU_ADDR        = 0x6A;   // 0x6B if SA0 is high on your board
constexpr float    SHAKE_G         = 1.8f;   // [calibrate] jolt threshold
constexpr int      SHAKE_JOLTS     = 3;      // jolts within SHAKE_WINDOW_MS
constexpr uint32_t SHAKE_WINDOW_MS = 1000;
constexpr uint32_t FACEDOWN_MS     = 1000;
constexpr uint8_t  WAKE_THS        = 0x02;   // [calibrate] 2 x 62.5 mg; 0x03-0x04 if desk bumps wake it

// ------------------------------------------------------------------ servos (pulse widths in us)
constexpr int PAN_MIN = 900,  PAN_CENTER = 1500,  PAN_MAX = 2100;    // [calibrate]
constexpr int TILT_MIN = 1150, TILT_CENTER = 1500, TILT_MAX = 1850;  // [calibrate] + = head up
constexpr float SERVO_ACCEL     = 2.0f;      // us per frame^2 (frame = 20 ms)
constexpr float SERVO_MAX_SPEED = 30.0f;     // us per frame
constexpr uint32_t SERVO_WARMUP_MS  = 20;    // power on, then pulses
constexpr uint32_t SERVO_STAGGER_MS = 50;    // never start both servos together
constexpr uint32_t SERVO_HOLD_MS    = 300;   // hold at target, then cut power
constexpr uint32_t LOW_BAT_MV       = 3550;  // below this the head stops moving

// ------------------------------------------------------------------ display
constexpr uint32_t FRAME_MS        = 40;     // 25 fps target; a full frame is ~25 ms of I2C
constexpr uint8_t  CONTRAST_AWAKE  = 200;
constexpr uint8_t  CONTRAST_DIM    = 10;
constexpr uint32_t DIM_AFTER_MS    = 60000;  // dim during long focus blocks if nobody interacts

// ------------------------------------------------------------------ power
constexpr uint32_t SLEEP_AFTER_MS  = 120000; // idle at the menu, no USB, no Bluetooth
constexpr uint32_t BAT_SAMPLE_MS   = 2000;

// ------------------------------------------------------------------ links
constexpr uint32_t STATE_EVERY_MS  = 1000;   // heartbeat STATE (v1 behaviour)
constexpr size_t   MAX_LINE        = 64;
