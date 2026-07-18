# Homebridge UniFi Protect Person Tracker Map

Homebridge platform plugin that renders a floor plan or site map as a HomeKit camera. UniFi Protect person/facial detection events update one marker per identified person. Each marker has a stable color, name, timestamp, and optional movement arrow.

## What It Can And Cannot Do

UniFi does not expose a supported third-party extension point for injecting custom pages into the UniFi web UI or Protect mobile apps. This plugin therefore uses the supported Homebridge/HomeKit surface:

- A HomeKit camera accessory showing the live map overlay.
- A local HTTP endpoint for map snapshots and event ingestion.
- A UniFi Protect poller boundary that parses person/facial detection-like events from Protect bootstrap data when credentials are configured.

iOS lock screen widgets cannot be shipped by a Homebridge plugin. The practical lock screen path is the Home app camera tile/snapshot exposed by Homebridge.

## Configuration

Open the plugin settings in Homebridge to upload a PNG, JPEG, or PDF map, discover UniFi Protect cameras, drag cameras onto the map, set each camera heading, and set a map scale. PDF uploads render the first page to a PNG map image before saving. The custom settings UI stores the map image and camera placements in Homebridge `config.json`.

```json
{
  "platform": "UniFiProtectPersonTrackerMap",
  "name": "Person Tracker Map",
  "mapImagePath": "/var/lib/homebridge/person-map.png",
  "mapConfigPath": "/var/lib/homebridge/person-map.local.json",
  "bindHost": "127.0.0.1",
  "port": 0,
  "adminToken": "replace-with-at-least-24-random-characters",
  "peopleTtlSeconds": 86400,
  "ffmpegPath": "ffmpeg",
  "protect": {
    "host": "10.0.7.1",
    "username": "local-protect-user",
    "password": "local-protect-password",
    "pollSeconds": 5
  }
}
```

`adminToken` protects `/state`, `/events`, and `/map-config`. Do not expose the HTTP server to the internet.

Set `"motionSensor": true` to expose a HomeKit motion sensor on the map accessory. It triggers whenever a person detection is ingested (from the Protect poller or `/events`) and clears after `motionResetSeconds` (default 30) without a new detection, so HomeKit automations can react to people on the map.

## Map Config

```json
{
  "width": 1280,
  "height": 720,
  "cameras": [
    {
      "id": "camera-id-from-protect",
      "name": "Front Door",
      "position": { "x": 240, "y": 180 },
      "headingDegrees": 90
    }
  ]
}
```

Coordinates use the rendered map pixel space. If Protect supplies a path or direction, the marker arrow uses it. Otherwise the plugin extrapolates from previous camera position or camera heading.

## Event Ingestion

External processors can post normalized detections:

```bash
curl -X POST http://127.0.0.1:PORT/events \
  -H "authorization: Bearer TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "personId": "face-123",
    "name": "Ada",
    "cameraId": "front",
    "timestamp": 1779648000000,
    "directionDegrees": 45
  }'
```

## Development

```bash
npm ci
npm run verify
```

Security checks include schema validation, absolute-path enforcement for configured local files, bearer auth on private endpoints, request body limits, and `npm audit`.
