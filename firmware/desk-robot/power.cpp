#include "power.h"
#include "config.h"
#include "imu.h"
#include "face.h"
#include "head.h"
#include "driver/rtc_io.h"

static uint32_t mvSmooth = 0, lastSample = 0;

static uint32_t readMv() { return analogReadMilliVolts(PIN_BAT_ADC) * 2; }   // 1:2 divider

void powerBegin() {
  analogSetPinAttenuation(PIN_BAT_ADC, ADC_11db);
  mvSmooth = readMv();
}

void powerUpdate() {
  uint32_t now = millis();
  if (now - lastSample < BAT_SAMPLE_MS) return;
  lastSample = now;
  // Skip samples taken while the servos pull the cell down; they'd fake a low battery.
  if (headPowered()) return;
  mvSmooth = (mvSmooth * 7 + readMv()) / 8;
}

uint32_t batteryMv() { return mvSmooth; }

int batteryPercent() {
  // Resting LiPo voltage -> charge, roughly. Good to about +/-10 %.
  static const uint16_t MV[]  = {3300, 3500, 3600, 3700, 3750, 3800, 3900, 4000, 4100, 4200};
  static const uint8_t  PCT[] = {   0,    5,   10,   25,   35,   45,   60,   75,   90,  100};
  uint32_t mv = mvSmooth;
  if (mv <= MV[0]) return 0;
  for (int i = 1; i < 10; i++)
    if (mv <= MV[i]) return PCT[i - 1] + (int)((mv - MV[i - 1]) * (PCT[i] - PCT[i - 1]) / (MV[i] - MV[i - 1]));
  return 100;
}

bool batteryLow() { return mvSmooth < LOW_BAT_MV; }

void powerSleepNow() {
  headOff();                                // servo power off, signal pins low
  faceOff();                                // OLED charge pump off
  imuSleepMode();                           // 12.5 Hz low power, wake-up on INT1, latch cleared
  pinMode(PIN_SERVO_EN, INPUT);             // R2 (100k) holds Q2's gate low while asleep
  Serial.flush();

  // IMU INT1 high = moved (ext0). Buttons pull low (ext1, either one).
  // [verify] ext0 + ext1 together on the S3; if pick-up wake fails, see the README.
  esp_sleep_enable_ext0_wakeup((gpio_num_t)PIN_IMU_INT, 1);
  esp_sleep_enable_ext1_wakeup((1ULL << PIN_BTN_A) | (1ULL << PIN_BTN_B), ESP_EXT1_WAKEUP_ANY_LOW);
  rtc_gpio_pullup_en((gpio_num_t)PIN_BTN_A);  rtc_gpio_pulldown_dis((gpio_num_t)PIN_BTN_A);
  rtc_gpio_pullup_en((gpio_num_t)PIN_BTN_B);  rtc_gpio_pulldown_dis((gpio_num_t)PIN_BTN_B);
  rtc_gpio_pulldown_en((gpio_num_t)PIN_IMU_INT); rtc_gpio_pullup_dis((gpio_num_t)PIN_IMU_INT);
  esp_deep_sleep_start();
}

bool wokeFromSleep() {
  esp_sleep_wakeup_cause_t c = esp_sleep_get_wakeup_cause();
  return c == ESP_SLEEP_WAKEUP_EXT0 || c == ESP_SLEEP_WAKEUP_EXT1;
}

const char* wakeReason() {
  switch (esp_sleep_get_wakeup_cause()) {
    case ESP_SLEEP_WAKEUP_EXT0: return "picked up";
    case ESP_SLEEP_WAKEUP_EXT1: return "button";
    default: break;
  }
  switch (esp_reset_reason()) {
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_PANIC:    return "crash";
    case ESP_RST_SW:       return "software";
    default:               return "power on";
  }
}
