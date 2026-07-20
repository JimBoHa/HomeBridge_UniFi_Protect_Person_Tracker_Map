import { describe, expect, it, vi } from 'vitest';
import { extractPersonEvents, UniFiProtectAdapter } from './protectAdapter.js';
import type { Logger, ProtectPersonEvent } from './types.js';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

async function poll(adapter: UniFiProtectAdapter): Promise<void> {
  await (adapter as unknown as { poll(): Promise<void> }).poll();
}

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
    const pollUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(`${pollUrl.origin}${pollUrl.pathname}`).toBe('https://protect.local/proxy/protect/api/events');
    expect(pollUrl.searchParams.get('type')).toBe('smartDetectZone');
    expect(pollUrl.searchParams.get('smartDetectTypes')).toBe('person');
    expect(pollUrl.searchParams.get('limit')).toBe('1000');
    expect(pollUrl.searchParams.get('offset')).toBe('0');
    expect(pollUrl.searchParams.get('orderBy')).toBe('start');
    expect(pollUrl.searchParams.get('orderDirection')).toBe('ASC');
    adapter.stop();
    vi.useRealTimers();
  });

  it('overlaps the cursor so delayed events older than the latest result are not skipped', async () => {
    const now = 20_000_020_000;
    const delayedTimestamp = now - 5_000;
    const newerTimestamp = now - 1_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const sunk: ProtectPersonEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', {
        status: 200,
        headers: { 'set-cookie': 'TOKEN=abc; Path=/' },
      }))
      .mockResolvedValueOnce(Response.json({
        events: [{ type: 'person', personId: 'newer', cameraId: 'front', timestamp: newerTimestamp }],
      }))
      .mockResolvedValueOnce(Response.json({
        events: [
          { type: 'person', personId: 'delayed', cameraId: 'front', timestamp: delayedTimestamp },
          { type: 'person', personId: 'newer', cameraId: 'front', timestamp: newerTimestamp },
        ],
      }));

    const adapter = new UniFiProtectAdapter({
      host: 'protect.local',
      username: 'user',
      password: 'pass',
    }, (event) => sunk.push(event), logger, fetchMock, 10_000);

    await poll(adapter);
    await poll(adapter);

    const firstPoll = new URL(String(fetchMock.mock.calls[1]?.[0]));
    const secondPoll = new URL(String(fetchMock.mock.calls[2]?.[0]));
    expect(Number(secondPoll.searchParams.get('start'))).toBeLessThanOrEqual(delayedTimestamp);
    expect(Number(secondPoll.searchParams.get('start'))).toBeGreaterThanOrEqual(Number(firstPoll.searchParams.get('start')));
    expect(sunk).toEqual([
      expect.objectContaining({ personId: 'newer', timestamp: newerTimestamp }),
      expect.objectContaining({ personId: 'delayed', timestamp: delayedTimestamp }),
    ]);
    vi.restoreAllMocks();
  });

  it('paginates capped time ranges before advancing the event cursor', async () => {
    const now = 20_000_020_000;
    const initialLookbackMs = 2_000_000;
    const firstStart = now - initialLookbackMs + 1;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const sunk: ProtectPersonEvent[] = [];
    const eventUrls: URL[] = [];
    let loggedIn = false;
    const events = (start: number, count: number, prefix: string) => Array.from({ length: count }, (_, index) => ({
      type: 'person',
      personId: `${prefix}-${index}`,
      cameraId: 'front',
      timestamp: start + index * 1000,
    }));
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (!loggedIn) {
        loggedIn = true;
        return new Response('{}', {
          status: 200,
          headers: { 'set-cookie': 'TOKEN=abc; Path=/' },
        });
      }

      eventUrls.push(url);
      const start = Number(url.searchParams.get('start'));
      const end = Number(url.searchParams.get('end'));
      const offset = Number(url.searchParams.get('offset'));
      if (start === firstStart && end === now && offset === 0) {
        return Response.json(events(start, 1000, 'first'));
      }
      if (start === firstStart && end === now && offset === 1000) {
        return Response.json({ data: events(start + offset * 1000, 200, 'second') });
      }
      return Response.json([]);
    });

    const adapter = new UniFiProtectAdapter({
      host: 'protect.local',
      username: 'user',
      password: 'pass',
    }, (event) => sunk.push(event), logger, fetchMock, initialLookbackMs);

    await poll(adapter);
    await poll(adapter);

    expect(eventUrls.slice(0, 2).map((url) => [
      Number(url.searchParams.get('start')),
      Number(url.searchParams.get('end')),
      Number(url.searchParams.get('offset')),
    ])).toEqual([
      [firstStart, now, 0],
      [firstStart, now, 1000],
    ]);
    expect(sunk).toHaveLength(1200);
    expect(eventUrls[2]?.searchParams.get('start')).toBe(String(firstStart + 299_001));
    expect(eventUrls[2]?.searchParams.get('offset')).toBe('0');
    vi.restoreAllMocks();
  });
});
