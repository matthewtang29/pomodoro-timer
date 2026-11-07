#include "links.h"
#include "config.h"
#include <stdarg.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>

// Nordic UART Service UUIDs (what nRF Connect, Bluefy and most BLE serial apps expect)
#define NUS_SERVICE "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_RX      "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"   // app writes here
#define NUS_TX      "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"   // robot notifies here

static LineHandler handler = nullptr;

// ---------------------------------------------------------------- line assembly
struct LineBuf {
  char buf[MAX_LINE];
  size_t len = 0;
  void feed(char c, Link from) {
    if (c == '\n' || c == '\r') {
      if (len) { buf[len] = '\0'; handler(buf, from); len = 0; }
    } else if (len < MAX_LINE - 1) {
      buf[len++] = toupper((unsigned char)c);   // v1 upper-cases commands too
    }
  }
};
static LineBuf usbIn, bleIn;

// ---------------------------------------------------------------- BLE
// The BLE stack runs in its own FreeRTOS task. Its callbacks only push bytes
// into a queue; loop() does all the real work, so nothing here needs locks.
static BLECharacteristic* txChar = nullptr;
static BLEServer* server = nullptr;
static QueueHandle_t bleRxQ;
static volatile bool bleUp = false;
static volatile uint16_t blePayload = 20;   // ATT MTU - 3; grows if the phone negotiates more
static volatile bool restartAdv = false;

class ServerCb : public BLEServerCallbacks {
  void onConnect(BLEServer*) override { bleUp = true; blePayload = 20; }
  void onDisconnect(BLEServer*) override { bleUp = false; restartAdv = true; }
  void onMtuChanged(BLEServer*, esp_ble_gatts_cb_param_t* p) override {
    uint16_t m = p->mtu.mtu;
    blePayload = m > 23 ? m - 3 : 20;
  }
};

class RxCb : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    String v = c->getValue();
    for (size_t i = 0; i < v.length(); i++) { char ch = v[i]; xQueueSend(bleRxQ, &ch, 0); }
  }
};

static void bleBegin() {
  bleRxQ = xQueueCreate(256, 1);
  BLEDevice::init(ROBOT_NAME);
  server = BLEDevice::createServer();
  server->setCallbacks(new ServerCb());
  BLEService* svc = server->createService(NUS_SERVICE);
  txChar = svc->createCharacteristic(NUS_TX, BLECharacteristic::PROPERTY_NOTIFY);
  txChar->addDescriptor(new BLE2902());
  BLECharacteristic* rx = svc->createCharacteristic(
      NUS_RX, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rx->setCallbacks(new RxCb());
  svc->start();
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(NUS_SERVICE);
  adv->setScanResponse(true);     // name goes in the scan response, UUID in the advert
  adv->start();
}

static void bleSend(const char* s, size_t n) {
  // A notification carries at most one payload; split longer lines.
  // Receivers must re-assemble on '\n' (Pomegranate already does for Web Serial).
  size_t chunk = blePayload;
  for (size_t i = 0; i < n; i += chunk) {
    size_t len = min(chunk, n - i);
    txChar->setValue((uint8_t*)s + i, len);
    txChar->notify();
  }
}

// ---------------------------------------------------------------- public
void linksBegin(LineHandler h) {
  handler = h;
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);   // never block loop() when no host is reading the port
  bleBegin();
}

void linksUpdate() {
  while (Serial.available()) usbIn.feed(Serial.read(), LINK_USB);
  char c;
  while (xQueueReceive(bleRxQ, &c, 0) == pdTRUE) bleIn.feed(c, LINK_BLE);
  if (restartAdv) { restartAdv = false; BLEDevice::startAdvertising(); }
}

void sendLine(const char* s, Link to) {
  if (to & LINK_USB) Serial.println(s);
  if ((to & LINK_BLE) && bleUp) {
    char out[160];
    int n = snprintf(out, sizeof out, "%s\n", s);
    bleSend(out, min((size_t)n, sizeof out - 1));
  }
}

void sendf(Link to, const char* fmt, ...) {
  char buf[160];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  sendLine(buf, to);
}

bool bleConnected() { return bleUp; }

bool usbConnected() {
  // True while a host has the port open (DTR set), e.g. Pomegranate or the
  // Serial Monitor. A plain USB charger doesn't count, so the robot still
  // sleeps on a charger. Works in both USB modes (TinyUSB CDC or HW CDC).
  return (bool)Serial;
}
