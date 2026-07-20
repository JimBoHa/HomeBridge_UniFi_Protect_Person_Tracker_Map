import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { MapRenderer } from './renderer.js';
import { PersonTracker } from './tracker.js';
import { TrackerHttpServer } from './httpServer.js';
import type { Logger, MapConfig } from './types.js';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const map: MapConfig = {
  width: 200,
  height: 100,
  cameras: [{ id: 'front', name: 'Front', position: { x: 20, y: 20 } }],
};

describe('TrackerHttpServer', () => {
  let server: TrackerHttpServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('serves snapshots without exposing private state', async () => {
    const tracker = new PersonTracker(map, 60_000);
    server = new TrackerHttpServer(tracker, new MapRenderer(), 'x'.repeat(32), logger);
    const port = await server.start('127.0.0.1', 0);

    const response = await fetch(`http://127.0.0.1:${port}/snapshot.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
  });

  it('serves routes when the URL includes a query string', async () => {
    const tracker = new PersonTracker(map, 60_000);
    server = new TrackerHttpServer(tracker, new MapRenderer(), 'secure-token-secure-token-1234', logger);
    const port = await server.start('127.0.0.1', 0);

    const snapshot = await fetch(`http://127.0.0.1:${port}/snapshot.png?ts=${Date.now()}`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get('content-type')).toBe('image/png');

    const state = await fetch(`http://127.0.0.1:${port}/state?pretty=1`, {
      headers: { authorization: 'Bearer secure-token-secure-token-1234' },
    });
    expect(state.status).toBe(200);
  });

  it('requires bearer token for state and event ingestion', async () => {
    const tracker = new PersonTracker(map, 60_000);
    server = new TrackerHttpServer(tracker, new MapRenderer(), 'secure-token-secure-token-1234', logger);
    const port = await server.start('127.0.0.1', 0);

    const denied = await fetch(`http://127.0.0.1:${port}/state`);
    expect(denied.status).toBe(401);

    const accepted = await fetch(`http://127.0.0.1:${port}/events`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secure-token-secure-token-1234',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ personId: 'p1', name: 'Ada', cameraId: 'front', timestamp: Date.now() }),
    });
    expect(accepted.status).toBe(202);

    const state = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { authorization: 'Bearer secure-token-secure-token-1234' },
    });
    const body = await state.json() as { people: unknown[] };
    expect(body.people).toHaveLength(1);
  });

  it('rejects oversized request bodies', async () => {
    const tracker = new PersonTracker(map, 60_000);
    server = new TrackerHttpServer(tracker, new MapRenderer(), 'secure-token-secure-token-1234', logger);
    const port = await server.start('127.0.0.1', 0);

    const response = await fetch(`http://127.0.0.1:${port}/events`, {
      method: 'POST',
      headers: { authorization: 'Bearer secure-token-secure-token-1234' },
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(response.status).toBe(400);
  });

  it('updates map config and returns 404 for unknown routes', async () => {
    const tracker = new PersonTracker(map, 60_000);
    server = new TrackerHttpServer(tracker, new MapRenderer(), 'secure-token-secure-token-1234', logger);
    const port = await server.start('127.0.0.1', 0);

    const updated = await fetch(`http://127.0.0.1:${port}/map-config`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secure-token-secure-token-1234',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        width: 300,
        height: 200,
        cameras: [{ id: 'hall', name: 'Hall', position: { x: 50, y: 60 } }],
      }),
    });
    expect(updated.status).toBe(202);

    const missing = await fetch(`http://127.0.0.1:${port}/missing`);
    expect(missing.status).toBe(404);
  });

  it('rejects instead of hanging when the port is already in use', async () => {
    const tracker = new PersonTracker(map, 60_000);
    server = new TrackerHttpServer(tracker, new MapRenderer(), 'x'.repeat(32), logger);
    const port = await server.start('127.0.0.1', 0);

    const second = new TrackerHttpServer(tracker, new MapRenderer(), 'x'.repeat(32), logger);
    await expect(second.start('127.0.0.1', port)).rejects.toThrow(/EADDRINUSE/);
    await second.stop();
  });

  it('replaces the provisional bind error listener after listening', async () => {
    const tracker = new PersonTracker(map, 60_000);
    server = new TrackerHttpServer(tracker, new MapRenderer(), 'x'.repeat(32), logger);
    await server.start('127.0.0.1', 0);

    const nodeServer = Reflect.get(server, 'server') as Server;
    expect(nodeServer.listenerCount('error')).toBe(1);
  });
});
