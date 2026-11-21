// =============================================================================
// sound: non-blocking note player on the passive piezo. Every sound goes
// through soundPlay(), so mute silences everything (as in v1). Mute is kept
// in flash (NVS) so it survives a restart, like v1's EEPROM byte.
// =============================================================================
#pragma once
#include <Arduino.h>

struct Note { uint16_t hz, ms; };   // hz 0 = rest; {0, 0} ends a tune

namespace Tune {
  extern const Note HELLO[], CHIRP[], CLICK[], BOOP[], START[], FOCUS_DONE[],
                    REST_DONE[], ENDED[], EXITED[], PAUSE[], RESUME[], PURR[],
                    UNMUTE[], SLEEPY[], SURPRISE[];
}

void soundBegin();
void soundUpdate();
void soundPlay(const Note* tune);   // replaces whatever is playing
void soundStop();
void soundSetMuted(bool m);
bool soundMuted();
