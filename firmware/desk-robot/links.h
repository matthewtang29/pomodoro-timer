// =============================================================================
// links: the two ways a line can reach the robot, USB serial and Bluetooth LE
// (Nordic UART Service). Both feed the same handler, and both receive every
// STATE / EVENT line, so Pomegranate sees the same protocol on either.
// =============================================================================
#pragma once
#include <Arduino.h>

enum Link : uint8_t { LINK_USB = 1, LINK_BLE = 2, LINK_ALL = 3 };

using LineHandler = void (*)(char* line, Link from);

void linksBegin(LineHandler handler);
void linksUpdate();                         // call every loop(): drains both inputs

void sendLine(const char* s, Link to = LINK_ALL);
void sendf(Link to, const char* fmt, ...);  // printf-style sendLine

bool bleConnected();
bool usbConnected();                        // a host has the USB serial port open
