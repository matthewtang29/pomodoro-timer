#include "sound.h"
#include "config.h"
#include <Preferences.h>

// v1's notes: SO LA TI DO (abc[] = 3920, 4400, 4940, 5230 Hz)
namespace Tune {
  const Note HELLO[]      = {{3920, 120}, {4400, 120}, {4940, 120}, {5230, 200}, {0, 0}};
  const Note CHIRP[]      = {{2600, 40}, {3400, 60}, {0, 0}};
  const Note CLICK[]      = {{5230, 30}, {0, 0}};
  const Note BOOP[]        = {{1500, 80}, {0, 0}};
  const Note START[]      = {{3920, 50}, {0, 50}, {3920, 50}, {0, 50}, {5230, 120}, {0, 0}};
  const Note FOCUS_DONE[] = {{5230, 120}, {0, 40}, {4400, 120}, {0, 40}, {3920, 200}, {0, 0}};
  const Note REST_DONE[]  = {{3920, 120}, {0, 40}, {4400, 120}, {0, 40}, {5230, 200}, {0, 0}};
  const Note ENDED[]      = {{3920, 100}, {4400, 100}, {4940, 100}, {5230, 150}, {0, 60},
                             {5230, 80}, {0, 40}, {5230, 250}, {0, 0}};
  const Note EXITED[]     = {{3000, 120}, {2200, 200}, {0, 0}};
  const Note PAUSE[]      = {{3400, 60}, {2600, 80}, {0, 0}};
  const Note RESUME[]     = {{2600, 60}, {3400, 80}, {0, 0}};
  const Note PURR[]       = {{1800, 30}, {0, 30}, {2000, 30}, {0, 30}, {1800, 30}, {0, 0}};
  const Note UNMUTE[]     = {{5230, 80}, {0, 0}};
  const Note SLEEPY[]     = {{3000, 150}, {2500, 200}, {2000, 300}, {0, 0}};
  const Note SURPRISE[]   = {{2000, 30}, {4000, 80}, {0, 0}};
}

static const Note* song = nullptr;
static uint32_t noteEnd = 0;
static bool muted = false;
static Preferences prefs;

void soundBegin() {
  ledcAttach(PIN_PIEZO, 2000, 10);
  ledcWriteTone(PIN_PIEZO, 0);
  prefs.begin("sound", false);
  muted = prefs.getBool("muted", false);
}

void soundPlay(const Note* tune) {
  if (muted || !tune) return;
  song = tune;
  noteEnd = millis();    // start now
}

void soundStop() {
  song = nullptr;
  ledcWriteTone(PIN_PIEZO, 0);
}

void soundUpdate() {
  if (!song || (int32_t)(millis() - noteEnd) < 0) return;
  if (song->ms == 0) { soundStop(); return; }
  ledcWriteTone(PIN_PIEZO, song->hz);   // 0 Hz = silent rest
  noteEnd = millis() + song->ms;
  song++;
}

void soundSetMuted(bool m) {
  if (m == muted) return;
  muted = m;
  prefs.putBool("muted", m);           // NVS: wear-levelled, fine to write on change
  if (m) soundStop();
  else soundPlay(Tune::UNMUTE);        // v1: confirmation beep when unmuting
}

bool soundMuted() { return muted; }
