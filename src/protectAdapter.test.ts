import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { Agent } from 'undici';
import { extractPersonEvents, UniFiProtectAdapter } from './protectAdapter.js';
import type { Logger, ProtectPersonEvent } from './types.js';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function mockResponse(body: unknown, headers?: HeadersInit, cancel?: () => Promise<void>): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    body: cancel ? { cancel } : null,
    json: async () => body,
  } as unknown as Response;
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

  it('logs and skips polling when credentials are absent', async () => {
    const warn = vi.fn();
    const adapter = new UniFiProtectAdapter(undefined, () => undefined, { ...logger, warn });
    adapter.start();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('credentials not configured'));
    await adapter.stop();
  });

  it('uses the package fetch that owns the TLS dispatcher', async () => {
    const globalFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('Node global fetch was used'));
    vi.stubGlobal('fetch', globalFetch);
    const requestPaths: string[] = [];
    const sunk: ProtectPersonEvent[] = [];
    const server = createServer((request, response) => {
      requestPaths.push(request.url ?? '');
      response.setHeader('connection', 'close');
      if (request.url === '/api/auth/login') {
        response.setHeader('set-cookie', 'TOKEN=test; Path=/');
        response.end('{}');
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        events: [{ type: 'person', personId: 'p1', cameraId: 'front', timestamp: Date.now() }],
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test HTTP server did not bind a TCP port');
    }

    const adapter = new UniFiProtectAdapter({
      host: `http://127.0.0.1:${address.port}`,
      username: 'user',
      password: 'pass',
      ignoreTls: true,
      pollSeconds: 60,
    }, (event) => sunk.push(event), logger);

    try {
      adapter.start();
      await vi.waitFor(() => expect(sunk).toHaveLength(1));
    } finally {
      await adapter.stop();
      vi.unstubAllGlobals();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    expect(globalFetch).not.toHaveBeenCalled();
    expect(requestPaths[0]).toBe('/api/auth/login');
    expect(requestPaths[1]).toContain('/proxy/protect/api/events?');
  });

  it('logs in and sinks parsed person events while polling', async () => {
    const sunk: ProtectPersonEvent[] = [];
    const cancelLoginBody = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(mockResponse({}, { 'set-cookie': 'TOKEN=abc; Path=/' }, cancelLoginBody))
      .mockResolvedValueOnce(mockResponse({
        events: [{ type: 'person', personId: 'p1', cameraId: 'front', timestamp: Date.now() }],
      }));

    const adapter = new UniFiProtectAdapter({
      host: 'protect.local',
      username: 'user',
      password: 'pass',
      pollSeconds: 2,
    }, (event) => sunk.push(event), logger, fetchMock);
    adapter.start();
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
    expect(cancelLoginBody).toHaveBeenCalledOnce();
    await adapter.stop();
  });

  it('overlaps the cursor so delayed events older than the latest result are not skipped', async () => {
    const now = 20_000_020_000;
    const delayedTimestamp = now - 5_000;
    const newerTimestamp = now - 1_000;
    vi.useFakeTimers({ now });
    const sunk: ProtectPersonEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(mockResponse({}, { 'set-cookie': 'TOKEN=abc; Path=/' }))
      .mockResolvedValueOnce(mockResponse({
        events: [{ type: 'person', personId: 'newer', cameraId: 'front', timestamp: newerTimestamp }],
      }))
      .mockResolvedValueOnce(mockResponse({
        events: [
          { type: 'person', personId: 'delayed', cameraId: 'front', timestamp: delayedTimestamp },
          { type: 'person', personId: 'newer', cameraId: 'front', timestamp: newerTimestamp },
        ],
      }));
    const adapter = new UniFiProtectAdapter({
      host: 'protect.local',
      username: 'user',
      password: 'pass',
      pollSeconds: 2,
    }, (event) => sunk.push(event), logger, fetchMock, 10_000);

    try {
      adapter.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(sunk).toEqual([expect.objectContaining({ personId: 'newer', timestamp: newerTimestamp })]);
      await vi.advanceTimersByTimeAsync(2_000);

      const firstPoll = new URL(String(fetchMock.mock.calls[1]?.[0]));
      const secondPoll = new URL(String(fetchMock.mock.calls[2]?.[0]));
      expect(Number(secondPoll.searchParams.get('start'))).toBeLessThanOrEqual(delayedTimestamp);
      expect(Number(secondPoll.searchParams.get('start'))).toBeGreaterThanOrEqual(Number(firstPoll.searchParams.get('start')));
      expect(sunk).toEqual([
        expect.objectContaining({ personId: 'newer', timestamp: newerTimestamp }),
        expect.objectContaining({ personId: 'delayed', timestamp: delayedTimestamp }),
      ]);
    } finally {
      await adapter.stop();
      vi.useRealTimers();
    }
  });

  it('paginates capped time ranges before advancing the event cursor', async () => {
    const now = 20_000_020_000;
    const initialLookbackMs = 2_000_000;
    const firstStart = now - initialLookbackMs + 1;
    vi.useFakeTimers({ now });
    const sunk: ProtectPersonEvent[] = [];
    const eventUrls: URL[] = [];
    const events = (start: number, count: number, prefix: string) => Array.from({ length: count }, (_, index) => ({
      type: 'person',
      personId: `${prefix}-${index}`,
      cameraId: 'front',
      timestamp: start + index * 1000,
    }));
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/auth/login') {
        return mockResponse({}, { 'set-cookie': 'TOKEN=abc; Path=/' });
      }

      eventUrls.push(url);
      const start = Number(url.searchParams.get('start'));
      const end = Number(url.searchParams.get('end'));
      const offset = Number(url.searchParams.get('offset'));
      if (start === firstStart && end === now && offset === 0) {
        return mockResponse(events(start, 1000, 'first'));
      }
      if (start === firstStart && end === now && offset === 1000) {
        return mockResponse({ data: events(start + offset * 1000, 200, 'second') });
      }
      return mockResponse([]);
    });
    const adapter = new UniFiProtectAdapter({
      host: 'protect.local',
      username: 'user',
      password: 'pass',
      pollSeconds: 2,
    }, (event) => sunk.push(event), logger, fetchMock, initialLookbackMs);

    try {
      adapter.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(sunk).toHaveLength(1200);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(eventUrls.slice(0, 2).map((url) => [
        Number(url.searchParams.get('start')),
        Number(url.searchParams.get('end')),
        Number(url.searchParams.get('offset')),
      ])).toEqual([
        [firstStart, now, 0],
        [firstStart, now, 1000],
      ]);
      expect(eventUrls[2]?.searchParams.get('start')).toBe(String(firstStart + 299_001));
      expect(eventUrls[2]?.searchParams.get('offset')).toBe('0');
      expect(sunk).toHaveLength(1200);
    } finally {
      await adapter.stop();
      vi.useRealTimers();
    }
  });

  it('waits for a poll to finish before scheduling the next one', async () => {
    vi.useFakeTimers();
    let resolveEvents: ((response: Response) => void) | undefined;
    const pendingEvents = new Promise<Response>((resolve) => {
      resolveEvents = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(mockResponse({}, { 'set-cookie': 'TOKEN=abc; Path=/' }))
      .mockReturnValueOnce(pendingEvents)
      .mockResolvedValueOnce(mockResponse({ events: [] }));
    const adapter = new UniFiProtectAdapter({
      host: 'protect.local',
      username: 'user',
      password: 'pass',
      pollSeconds: 2,
    }, () => undefined, logger, fetchMock);

    try {
      adapter.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      resolveEvents?.(mockResponse({ events: [] }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      await adapter.stop();
      vi.useRealTimers();
    }
  });

  it('aborts requests that exceed the timeout', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    let requestSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal;
      requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
    }));
    const adapter = new UniFiProtectAdapter({
      host: 'protect.local',
      username: 'user',
      password: 'pass',
      pollSeconds: 2,
    }, () => undefined, { ...logger, warn }, fetchMock);

    try {
      adapter.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(requestSignal?.aborted).toBe(true);
      expect(warn).toHaveBeenCalledWith('UniFi Protect poll failed: Protect request timed out after 30000ms');
    } finally {
      await adapter.stop();
      vi.useRealTimers();
    }
  });

  it('aborts an active poll and closes its TLS agent on stop', async () => {
    const warn = vi.fn();
    const close = vi.spyOn(Agent.prototype, 'close');
    let requestSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal;
      requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
    }));
    const adapter = new UniFiProtectAdapter({
      host: 'protect.local',
      username: 'user',
      password: 'pass',
      pollSeconds: 2,
      ignoreTls: true,
    }, () => undefined, { ...logger, warn }, fetchMock);

    try {
      adapter.start();
      await adapter.stop();
      expect(requestSignal?.aborted).toBe(true);
      expect(close.mock.calls.filter((args) => args.length === 0)).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      close.mockRestore();
    }
  });
});
