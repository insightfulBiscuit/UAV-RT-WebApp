# Real-time thermal spot metering — setup guide

The website's approximate thermal reading (color-based) upgrades to **true DJI
radiometric values** once your Dock 3 forwards telemetry through an MQTT
broker. FlightHub 2's public REST API doesn't expose radiometric data — this
is the only supported path.

## What you're building

```
Browser ── HTTPS ─▶ Our Express API ── MQTT ─▶ Broker ◀── MQTT ── Dock 3 ◀── OcuSync ── M4TD
```

The dock publishes device events (including thermal measurements) to the
broker. Our backend publishes measurement commands to the same broker; the
dock forwards them to the M4TD; readings return as MQTT events.

You need three things, in this order.

## 1. Create an MQTT broker

Cheapest and easiest: **EMQX Cloud Free** ([https://www.emqx.com/en/cloud/serverless-mqtt](https://www.emqx.com/en/cloud/serverless-mqtt)).

1. Sign up, create a **Serverless** deployment.
2. Choose the region closest to your dock. Note the connection details:
   - **Address** (looks like `xxxxxxx.ala.us-east-1.emqxsl.com`)
   - **Port** for MQTT/TLS (usually `8883`)
3. Under **Authentication**, create a username + password. Give it access to
   topic pattern `thing/#`.

You'll get something like:
```
Broker URL: mqtts://xxxxxxx.ala.us-east-1.emqxsl.com:8883
Username:   uavrt-app
Password:   ••••••••
```

Alternatives if you'd rather self-host: Mosquitto in Docker
(`docker run -p 1883:1883 eclipse-mosquitto`), HiveMQ Cloud free tier,
Aedes on Node.js — any MQTT 3.1.1 / 5.0 broker works.

## 2. Point FlightHub Sync at your broker

In DJI FlightHub 2 (public cloud web console):

1. **My Organization → Organization Settings → FlightHub Sync**
2. If there is no Sync entry yet, click **Add FlightHub Sync Service**.
3. Fill in:
   - **Organization Key** — you already have this in `server/.env` as
     `FH2_USER_TOKEN`; the same one.
   - **Third-Party Cloud Name** — any label ("UAV-RT App" is fine).
   - **Webhook URL** — this is where FlightHub POSTs REST callbacks. If you
     don't need those, put your app's URL (e.g. `http://localhost:4000/api/webhook`)
     — the webhook is orthogonal to MQTT.
4. Click **Configure Telemetry Data** (or the MQTT/telemetry equivalent).
   Enter your broker settings:
   - Broker: `xxxxxxx.ala.us-east-1.emqxsl.com`
   - Port: `8883`
   - TLS: on
   - Username / Password from step 1
5. Save. FlightHub 2 will now start publishing dock+aircraft telemetry to
   `thing/product/{DOCK_SN}/osd`, `thing/product/{DOCK_SN}/events`, etc.,
   and will subscribe to `thing/product/{DOCK_SN}/services` for the commands
   we publish.

## 3. Configure this app to use the broker

Add to `server/.env`:

```
MQTT_BROKER_URL=mqtts://xxxxxxx.ala.us-east-1.emqxsl.com:8883
MQTT_USERNAME=uavrt-app
MQTT_PASSWORD=your-password
MQTT_DOCK_SN=8UUXP3800A10MS
```

Restart the API server:

```bash
npm --prefix server run dev
```

You should see in the logs:
```
API listening on http://localhost:4000
MQTT connected: mqtts://xxxxxxx.ala.us-east-1.emqxsl.com:8883
MQTT subscribed to dock 8UUXP3800A10MS
```

## 4. Verify

1. Open the app's **Live view** and switch the M4TD lens to **Thermal**.
2. The pill next to "Thermal spot metering" should read **DJI · real-time**
   (green) instead of "Approximate" (orange).
3. Click any spot on the thermal video. You should see the crosshair briefly
   show "…" then update with the real reading, e.g. **32.7°C**.

If the click fails with a timeout, watch the API server logs. The measure
endpoint prints which MQTT methods it tried; the exact one that works
depends on your FlightHub firmware/Cloud API version. See
`server/src/thermalService.ts` — the attempts array is easy to edit.

## Debugging tips

- **MQTT connects but measurements time out** — the dock isn't publishing to
  `services_reply` for the method you're calling. Use a general MQTT tool
  (MQTT Explorer, mqttx) to subscribe to `thing/product/{DOCK_SN}/#` and
  watch what the dock actually emits when you click. Adjust
  `thermalService.ts` to match.
- **Nothing arrives on any topic** — FlightHub Sync isn't publishing.
  Double-check step 2 in the FH2 admin panel; the Sync configuration UI
  will show an "OK / connected" light next to the third-party cloud.
- **TLS handshake fails** — some brokers require the trusted CA cert
  bundled. If you self-host Mosquitto with a self-signed cert, either use
  plain `mqtt://` on your LAN or set `MQTT_TLS_REJECT_UNAUTHORIZED=false`
  (I can add that env var if needed).
