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
    expect(cancelLoginBody).toHaveBeenCalledOnce();
    await adapter.stop();
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
