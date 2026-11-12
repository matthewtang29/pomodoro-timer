# Desk Robot firmware (v2)

Firmware for the handheld desk robot version of the Pomodoro timer: Seeed XIAO ESP32-S3 Plus, 1.3" SH1106 OLED face, pan and tilt SG90 servos, LSM6DS3TR-C IMU, two buttons, a capacitive pet pad and a piezo, on a 1S LiPo.

The v1 timer state machine is ported unchanged and the line protocol is the same, so **Pomegranate works with it over USB as it is**. The same lines also go over Bluetooth LE (Nordic UART Service), ready for Phase 4 (app transport).

## Build and flash

1. Arduino IDE 2, **Boards Manager → esp32 by Espressif, 3.x** (compiled against 3.1.1).
2. **Library Manager → U8g2** (tested with 2.37).
3. Board: **XIAO_ESP32S3**. Your core may also list a Plus entry; either works for these pins. Tools → **USB CDC On Boot: Enabled**.
4. Open `desk-robot.ino`. The other files in the folder open as tabs. Upload.
5. No port showing? Hold BOOT, plug in USB, release, then upload.

Wiring is the Phase 2 breadboard layout. Every pin lives in `config.h`.

## Files

| File | What it does |
|---|---|
| `desk-robot.ino` | `setup()` and the single non-blocking `loop()` |
| `config.h` | Pins and every tunable number, marked **[calibrate]** where your bench results go |
| `pomodoro.*` | The v1 state machine plus the protocol handler (`STATE` / `EVENT` / `ERR`) |
| `links.*` | USB serial and BLE NUS. Both feed one handler and both get every `STATE` / `EVENT` |
| `face.*` | Animated eyes (7 moods, blinks, gaze) and the timer readout under them |
| `head.*` | Servo power switch, ramped moves, queued gestures (nod, no, glance…) |
| `imu.*` | Shake, pick-up, face-down and tilt, using plain register writes like stage 4 |
| `inputs.*` | Buttons A/B (debounce, long press, A+B) and the pet pad |
| `sound.*` | Non-blocking piezo tunes. Mute is saved in flash |
| `power.*` | Battery voltage and %, deep sleep and wake |
| `personality.*` | The glue that turns events into faces, sounds and head moves |

Each module has a `begin()` and an `update()`. `update()` checks `millis()` and returns at once if there's nothing to do, so nothing ever calls `delay()`.

## Using it

| Input | Menu | Get ready | Focus / break | Paused | "Again?" prompt |
|---|---|---|---|---|---|
| **A short** | start 25/5 | – | pause | resume | yes |
| **A long (1 s)** | repeat last custom session | skip countdown | skip the **break** (a focus block can't be skipped) | – | – |
| **B short** | status page | status page | status page | status page | no |
| **B long (2 s)** | sleep now | exit | exit | exit | exit |
| **A + B** | mute / unmute | mute / unmute | mute / unmute | mute / unmute | mute / unmute |
| **Shake** | "dizzy" | "dizzy" | pause | "dizzy" | "dizzy" |
| **Pet pad** | happy + purr + nod | quiet smile | quiet smile in focus, purr + nod in a break | purr + nod | purr + nod |
| **Pick up** | wakes it from sleep, surprised face | surprised | surprised | surprised | surprised |
| **Face down** | screen off | screen off | screen off, timer keeps running | screen off | screen off |

Custom sessions are set from the app (`START f b c`). The robot remembers the last one, so **A long** at the menu repeats it.

### Personality

- **Focus:** narrowed eyes looking down, blinks less, no head moves, no sounds. It dims after 60 s with no interaction.
- **Break:** happy eyes, glances around, and now and then turns its head.
- **Focus done:** heart eyes and a nod. **Session done:** a celebration wiggle.
- **Paused:** sad eyes and a curious head tilt. **Exited:** it droops.
- **Menu:** looks around. Held in your hand, the eyes follow the tilt. After about 2 minutes idle it gets sleepy, droops, then deep-sleeps. It never sleeps while Pomegranate has the USB port open or a phone is connected over Bluetooth.

## Protocol

Unchanged from v1. One line per message, 115200 baud on USB, and the same text over BLE.

- App → robot: `START f b c`, `AUTO`, `PAUSE`, `RESUME`, `EXIT`, `YES`, `NO`, `MUTE`, `UNMUTE`, `STATUS`
- Robot → app: `READY`, `STATE state= left= cycle= cycles= focus= break= done= total= mode= muted=` (every second and on change), `EVENT FOCUS_DONE|REST_DONE|SESSION_ENDED|EXITED`, `ERR BUSY|RANGE|STATE|UNKNOWN`

All of these are additions only:

- `INFO` → `INFO fw=0.1.0 bat=87 mv=4012 usb=1 ble=0`. Battery is a separate command, so the `STATE` line stays byte-for-byte what v1 sends and nothing changes for the Firestore relay.
- `ERR` lines go only to the link that sent the command. `STATE` and `EVENT` go to both links.
- Lines starting with `#` are debug comments. Pomegranate just logs them.

BLE: the device is named `DeskBot`. Service `6E400001-…`, the app writes to RX `6E400002-…` and subscribes to TX `6E400003-…`. Long lines are split to fit the negotiated MTU, so the receiver must re-assemble on `\n`, which Pomegranate already does for Web Serial. nRF Connect on a phone works for testing.

## Bring-up checklist

Flash it and check these in order. Each one builds on the stage sketches you already passed.

1. **USB:** Pomegranate connects and runs a session exactly like the Uno did.
2. **Face:** eyes blink. Start a session and the time shows under them.
3. **Buttons:** walk through the table above. A+B shows "sound off/on".
4. **Pad:** if it triggers by itself, raise `PAD_TRIGGER_PCT` (try 8–10).
5. **IMU:** shake during focus pauses it. If walking around also pauses it, raise `SHAKE_G` or `SHAKE_JOLTS`.
6. **Servos (battery in):** put your calibrated end points into `PAN_*` / `TILT_*`. The gestures are offsets from centre, so they scale to your limits. If it browns out, lower `SERVO_MAX_SPEED`.
7. **Bluetooth:** in nRF Connect, connect to DeskBot, enable notify on TX, and write `STATUS` to RX.
8. **Sleep:** unplug USB, leave it at the menu, and it sleeps after about 2 min. Pick it up, or press A or B, to wake it.

## Things to know / [verify]

- **USB only, no battery:** the servos can't move (the power path only feeds them from the battery), and the battery reading may be meaningless, so you might see "low battery". That's expected on the bench.
- **ext0 + ext1 wake together on the S3 [verify]:** if a pick-up doesn't wake it, change `powerSleepNow()` to wake on GPIO3 with ext1 alone and drop the button wake, or move the buttons to the IMU INT pin through diodes.
- **OLED frame time:** a frame that changed costs about 25 ms of I2C. Unchanged frames aren't sent, and servo steps catch up, so moves stay smooth. Set `DEBUG_LOOP 1` in the `.ino` to print the worst loop time.
- **IMU axes:** which way "tilt" moves the eyes depends on how the IMU sits in the case. Flip the signs in `personalityUpdate()` if the eyes look the wrong way.
- **SSD1306 panel:** swap the constructor at the top of `face.cpp`.
- The vibration motor (D6) isn't used.

## Not done yet (next phases)

- **Phase 4:** Pomegranate talks over Web Bluetooth (a second transport into the existing `handleLine()`). iPhone/iPad Safari has no Web Bluetooth, so phones keep using the Firestore relay through the laptop, or Bluefy.
- **Robot Wi-Fi → Firestore bridge**, so the robot doesn't depend on the laptop. Planned, not in this firmware.
