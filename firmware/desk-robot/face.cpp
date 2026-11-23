#include "face.h"
#include "config.h"
#include "pomodoro.h"
#include "power.h"
#include "links.h"
#include "sound.h"
#include <Wire.h>
#include <U8g2lib.h>

// SSD1306 panel instead? Use U8G2_SSD1306_128X64_NONAME_F_HW_I2C
static U8G2_SH1106_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);

// ---------------------------------------------------------------- expressions
struct Look {
  float w, h;        // eye size (px, before layout scaling)
  float lid;         // 0..1 of the eye covered from the top (flat lid)
  float slant;       // -1..1: + = angry (inner corners down), - = sad (outer corners down)
  float smile;       // 0..1: bottom of the eye cut away in a curve (^ ^)
};
static const Look LOOKS[E_COUNT] = {
  /* NEUTRAL   */ {28, 32, 0.00f,  0.00f, 0.00f},
  /* FOCUS     */ {30, 22, 0.25f,  0.35f, 0.00f},
  /* HAPPY     */ {30, 30, 0.00f,  0.00f, 0.70f},
  /* SLEEPY    */ {30, 30, 0.60f, -0.15f, 0.00f},
  /* SURPRISED */ {24, 38, 0.00f,  0.00f, 0.00f},
  /* SAD       */ {28, 28, 0.15f, -0.60f, 0.00f},
  /* ANNOYED   */ {30, 26, 0.35f,  0.60f, 0.00f},
  /* LOVE      */ {30, 30, 0.00f,  0.00f, 0.90f},
};

static Look cur = LOOKS[E_NEUTRAL];
static Expr base = E_NEUTRAL, shown = E_NEUTRAL;
static uint32_t flashUntil = 0;
static float gx = 0, gy = 0, gxT = 0, gyT = 0;

// blink
static enum : uint8_t { OPEN, CLOSING, OPENING } blinkPhase = OPEN;
static float blinkK = 1.0f;          // 1 open, 0.08 shut
static uint32_t nextBlink = 2500;

// overlays
static char toast[22] = "";
static uint32_t toastUntil = 0, statusUntil = 0;
static bool off = false, dimmed = false;
static uint32_t lastFrame = 0;
static uint8_t lastBuf[1024];

static bool due(uint32_t t) { return (int32_t)(millis() - t) >= 0; }
static float ease(float c, float t, float k) { return c + (t - c) * k; }

bool faceBegin() {
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  oled.setBusClock(400000);
  bool ok = oled.begin();
  oled.setContrast(CONTRAST_AWAKE);
  memset(lastBuf, 0xFF, sizeof lastBuf);   // force the first frame out
  return ok;
}

void faceSetBase(Expr e)            { base = e; }
void faceFlash(Expr e, uint32_t ms) { shown = e; flashUntil = millis() + ms; }
void faceGaze(float x, float y)     { gxT = constrain(x, -1.0f, 1.0f); gyT = constrain(y, -1.0f, 1.0f); }

void faceToast(const char* text, uint32_t ms) {
  strlcpy(toast, text, sizeof toast);
  toastUntil = millis() + ms;
}

void faceStatusPage(uint32_t ms) { statusUntil = millis() + ms; }

void faceDim(bool d) {
  if (d == dimmed) return;
  dimmed = d;
  oled.setContrast(d ? CONTRAST_DIM : CONTRAST_AWAKE);
}

void faceOff()     { if (!off) { off = true; oled.setPowerSave(1); } }
void faceOn()      { if (off) { off = false; oled.setPowerSave(0); memset(lastBuf, 0xFF, sizeof lastBuf); } }
bool faceIsOff()   { return off; }

// ---------------------------------------------------------------- drawing
// One eye centred on (cx, cy). mirror = +1 for the right eye, -1 for the left,
// so a slant tilts the inner corners of both eyes the same way.
static void drawEye(int cx, int cy, float w, float h, int mirror) {
  int W = max(2, (int)w), H = max(2, (int)h);
  int x = cx - W / 2, y = cy - H / 2;
  int r = min(8, H / 2 - 1);
  oled.setDrawColor(1);
  if (r >= 1 && W > 2 * r) oled.drawRBox(x, y, W, H, r); else oled.drawBox(x, y, W, H);

  oled.setDrawColor(0);
  // flat top lid
  int lidPx = (int)(cur.lid * H);
  if (lidPx > 0) oled.drawBox(x - 1, y - 1, W + 2, lidPx + 1);
  // slanted lid: a triangle cut from the inner (angry) or outer (sad) top corner
  if (fabsf(cur.slant) > 0.02f) {
    int drop = (int)(fabsf(cur.slant) * H * 0.6f);
    int top = y + lidPx - 1;
    bool inner = cur.slant > 0;
    // inner corner is toward the middle of the screen
    int xc = (inner == (mirror > 0)) ? x - 1 : x + W;   // corner that drops
    int xo = (inner == (mirror > 0)) ? x + W : x - 1;   // corner that stays
    oled.drawTriangle(xc, top, xo, top, xc, top + drop);
  }
  // smile: an ellipse from below eats the bottom of the eye -> ^ shape
  if (cur.smile > 0.02f) {
    int ry = (int)(cur.smile * H * 0.75f);
    oled.drawFilledEllipse(cx, y + H + ry / 3, W * 0.75f, ry);
  }
  oled.setDrawColor(1);
}

static void drawEyes(int cy, float scale) {
  float w = cur.w * scale, h = cur.h * scale * blinkK;
  int dx = (int)(gx * 10 * scale), dy = (int)(gy * 6 * scale);
  int sep = (int)(24 * scale) + 4;
  drawEye(64 - sep + dx, cy + dy, w, h, -1);
  drawEye(64 + sep + dx, cy + dy, w, h, +1);
}

static void centreStr(int y, const char* s) {
  oled.drawStr((128 - oled.getStrWidth(s)) / 2, y, s);
}

static void drawTimerBar() {
  TState st = timerState();
  char buf[24];
  uint32_t ms = timerMsLeft();

  if (st == T_GETREADY) {
    oled.setFont(u8g2_font_logisoso16_tn);
    snprintf(buf, sizeof buf, "%lu", (unsigned long)(ms / 1000));
    centreStr(60, buf);
    oled.setFont(u8g2_font_5x7_tr);
    oled.drawStr(0, 60, "ready");
    return;
  }

  bool timed = st == T_FOCUS || st == T_REST || st == T_PAUSED;
  if (!timed) return;
  uint32_t secs = (ms + 999) / 1000;
  bool colonOn = st == T_PAUSED ? (millis() / 500) % 2 : (ms % 1000) < 700;   // v1's blinking colon
  snprintf(buf, sizeof buf, colonOn ? "%02lu:%02lu" : "%02lu %02lu",
           (unsigned long)(secs / 60), (unsigned long)(secs % 60));
  oled.setFont(u8g2_font_logisoso16_tn);
  if (!(st == T_PAUSED && (millis() / 500) % 2)) centreStr(59, buf);   // paused: time blinks

  oled.setFont(u8g2_font_5x7_tr);
  bool focus = st == T_FOCUS || (st == T_PAUSED && timerPausedFrom() == T_FOCUS);
  oled.drawStr(0, 59, st == T_PAUSED ? "pause" : focus ? "focus" : "break");
  if (timerCycles() > 0) snprintf(buf, sizeof buf, "%d/%d", timerCycle(), timerCycles());
  else snprintf(buf, sizeof buf, "#%d", timerCycle());
  oled.drawStr(128 - oled.getStrWidth(buf), 59, buf);

  // progress: fills up as the phase goes by
  uint32_t total = timerPhaseMs();
  int px = total ? (int)(128.0f * (total - min(ms, total)) / total) : 0;
  oled.drawFrame(0, 62, 128, 2);
  oled.drawBox(0, 62, px, 2);
}

static void drawStatus() {
  char buf[28];
  oled.setFont(u8g2_font_6x12_tr);
  snprintf(buf, sizeof buf, "battery %d%%  %.2fV", batteryPercent(), batteryMv() / 1000.0f);
  oled.drawStr(0, 12, buf);
  snprintf(buf, sizeof buf, "bluetooth %s", bleConnected() ? "connected" : "waiting");
  oled.drawStr(0, 26, buf);
  snprintf(buf, sizeof buf, "usb %s", usbConnected() ? "app open" : "-");
  oled.drawStr(0, 40, buf);
  snprintf(buf, sizeof buf, "sound %s  v" FW_VERSION, soundMuted() ? "off" : "on");
  oled.drawStr(0, 54, buf);
}

// Text under the eyes for the between-timer screens
static const char* stateCaption(char* buf, size_t n) {
  switch (timerState()) {
    case T_FOCUS_DONE: return "focus done! break";
    case T_CHECKPOINT: snprintf(buf, n, "%d done  %d:%02d", timerDone(), timerTotalMin() / 60, timerTotalMin() % 60); return buf;
    case T_CONTINUE:   return "again? A yes  B no";
    case T_ENDED:      return "session done!";
    case T_EXITED:     return "stopped";
    case T_SUMMARY:    snprintf(buf, n, "%d blocks  %d:%02d", timerDone(), timerTotalMin() / 60, timerTotalMin() % 60); return buf;
    default:           return nullptr;
  }
}

// ---------------------------------------------------------------- update
static void animate(uint32_t now) {
  if (flashUntil && due(flashUntil)) { flashUntil = 0; shown = base; }
  if (!flashUntil) shown = base;
  const Look& t = LOOKS[shown];
  cur.w = ease(cur.w, t.w, 0.3f);
  cur.h = ease(cur.h, t.h, 0.3f);
  cur.lid = ease(cur.lid, t.lid, 0.25f);
  cur.slant = ease(cur.slant, t.slant, 0.25f);
  cur.smile = ease(cur.smile, t.smile, 0.25f);
  gx = ease(gx, gxT, 0.35f);
  gy = ease(gy, gyT, 0.35f);

  switch (blinkPhase) {
    case OPEN:
      if (due(nextBlink) && shown != E_SURPRISED) blinkPhase = CLOSING;
      break;
    case CLOSING:
      blinkK -= 0.35f;
      if (blinkK <= 0.08f) { blinkK = 0.08f; blinkPhase = OPENING; }
      break;
    case OPENING:
      blinkK += 0.25f;
      if (blinkK >= 1.0f) {
        blinkK = 1.0f;
        blinkPhase = OPEN;
        // focused robots blink less; sleepy ones more
        uint32_t lo = shown == E_FOCUS ? 4000 : shown == E_SLEEPY ? 1200 : 2000;
        nextBlink = now + random(lo, lo * 3);
      }
      break;
  }
}

void faceUpdate() {
  uint32_t now = millis();
  if (off || now - lastFrame < FRAME_MS) return;
  lastFrame = now;
  animate(now);

  oled.clearBuffer();
  if (!due(statusUntil)) {
    drawStatus();
  } else {
    TState st = timerState();
    char buf[24];
    const char* caption = !due(toastUntil) ? toast : stateCaption(buf, sizeof buf);
    bool timed = st == T_GETREADY || st == T_FOCUS || st == T_REST || st == T_PAUSED;
    if (timed && due(toastUntil)) {
      drawEyes(20, 0.75f);
      drawTimerBar();
    } else if (caption) {
      drawEyes(22, 0.8f);
      oled.setFont(u8g2_font_6x12_tr);
      centreStr(58, caption);
    } else {
      drawEyes(32, 1.0f);
    }
  }

  // Only push the frame if a pixel changed: ~25 ms of I2C saved on still frames
  uint8_t* buf = oled.getBufferPtr();
  if (memcmp(buf, lastBuf, sizeof lastBuf) != 0) {
    memcpy(lastBuf, buf, sizeof lastBuf);
    oled.sendBuffer();
  }
}
