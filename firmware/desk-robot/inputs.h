// =============================================================================
// inputs: buttons A/B (30 ms debounce, long press fires while held, A+B combo)
// and the capacitive pet pad. Same logic as the Phase 2 stage 3 sketch.
// =============================================================================
#pragma once
#include <Arduino.h>

enum InputEvent : uint8_t {
  IN_NONE, IN_A_SHORT, IN_A_LONG, IN_B_SHORT, IN_B_LONG, IN_AB, IN_PET_START, IN_PET_END,
};

void       inputsBegin();
InputEvent inputsUpdate();      // at most one event per call
uint32_t   inputsLastActivity();
bool       petting();
