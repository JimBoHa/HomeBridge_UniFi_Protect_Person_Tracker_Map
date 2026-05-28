import { describe, expect, it, vi } from 'vitest';
import { extractPersonEvents, UniFiProtectAdapter } from './protectAdapter.js';
import type { Logger, ProtectPersonEvent } from './types.js';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('extractPersonEvents', () => {
  it('extracts facial/person detections from nested Protect-like payloads', () => {
    const events = extractPersonEvents({
      cameras: [],
      events: [
        {
          type: 'smartDetectPerson',
          personId: 'face-1',
          personName: 'Grace',
          cameraId: 'front',
          timestamp: '2026-05-24T12:00:00.000Z',
          confidence: 0.91,
        },
        {
          smartDetectTypes: ['vehicle'],
          personId: 'car',
          cameraId: 'front',
          timestamp: 1,
        },
      ],
    });

    expect(events).toEqual([
      {
        personId: 'face-1',
        name: 'Grace',
        cameraId: 'front',
        timestamp: Date.parse('2026-05-24T12:00:00.000Z'),
        confidence: 0.91,
        directionDegrees: undefined,
      },
    ]);
  });

  it('filters old and duplicate events', () => {
    const events = extractPersonEvents({
      events: [
        { types: ['person'], faceId: 'a', camera: 'front', timestamp: 10 },
        { types: ['person'], faceId: 'a', camera: 'front', timestamp: 10 },
        { types: ['person'], faceId: 'b', camera: 'front', timestamp: 9 },
      ],
    }, 9_500);

    expect(events).toHaveLength(1);
    expect(events[0]?.timestamp).toBe(10_000);
  });

  it('extracts Protect smart detection person thumbnails with direction', () => {
    const events = extractPersonEvents([{
      id: 'event-1',
      type: 'smartDetectZone',
      smartDetectTypes: ['face', 'person'],
      camera: 'front',
      start: 20,
      score: 80,
      metadata: {
        detectedAreas: [{ routePath: { lastDirection: [0, 10] } }],
        detectedThumbnails: [
          {
            type: 'person',
            objectId: 'object-1',
            labels: ['smartDetectType:person'],
            attributes: { trackerId: 123 },
            confidence: 94,
            clockBestWall: 21_000_000_000,
          },
          {
            type: 'face',
            objectId: 'face-1',
            labels: ['smartDetectType:face', 'group:known-person', 'groupType:unknown'],
            confidence: 88,
            clockBestWall: 21_100_000_000,
          },
        ],
      },
    }]);

    expect(events).toMatchObject([
      {
        personId: 'tracker-123',
        name: 'Person',
        cameraId: 'front',
        timestamp: 21_000_000_000,
        confidence: 94,
        directionDegrees: 90,
      },
      {
        personId: 'known-person',
        name: 'Face',
        cameraId: 'front',
        timestamp: 21_100_000_000,
        confidence: 88,
        directionDegrees: 90,
      },
    ]);
  });

  it('logs and skips polling when credentials are absent', () => {
    const warn = vi.fn();
    const adapter = new UniFiProtectAdapter(undefined, () => undefined, { ...logger, warn });
    adapter.start();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('credentials not configured'));
    adapter.stop();
  });

  it('logs in and sinks parsed person events while polling', async () => {
    vi.useFakeTimers();
    const sunk: ProtectPersonEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', {
        status: 200,
        headers: { 'set-cookie': 'TOKEN=abc; Path=/' },
      }))
      .mockResolvedValueOnce(Response.json({
        events: [{ type: 'person', personId: 'p1', cameraId: 'front', timestamp: Date.now() }],
      }));

    const adapter = new UniFiProtectAdapter({
      host: 'protect.local',
      username: 'user',
      password: 'pass',
      pollSeconds: 2,
    }, (event) => sunk.push(event), logger, fetchMock);
    adapter.start();
    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(() => expect(sunk).toHaveLength(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://protect.local/api/auth/login');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('https://protect.local/proxy/protect/api/events?');
    adapter.stop();
    vi.useRealTimers();
  });
});
