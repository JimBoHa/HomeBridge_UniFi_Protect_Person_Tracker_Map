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

  it('preserves legacy Protect thumbnail labels and direction', () => {
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

  it('uses modern Protect group ids and matched names', () => {
    const events = extractPersonEvents([{
      id: 'event-modern',
      type: 'smartDetectZone',
      smartDetectTypes: ['face'],
      personName: 'Event Name',
      camera: 'front',
      start: 30,
      metadata: {
        detectedThumbnails: [{
          type: 'face',
          objectId: 'face-modern',
          name: 'Thumbnail Name',
          group: {
            id: 'identity-ada',
            name: 'Ada Lovelace',
            matchedName: 'Ada',
            confidence: 0.97,
          },
          attributes: { trackerId: 200 },
          confidence: 88,
          clockBestWall: 31_000_000_000,
        }],
      },
    }]);

    expect(events).toEqual([{
      personId: 'identity-ada',
      name: 'Ada',
      cameraId: 'front',
      timestamp: 31_000_000_000,
      confidence: 0.97,
      directionDegrees: undefined,
    }]);
  });

  it('coalesces an explicitly associated person and face', () => {
    const events = extractPersonEvents([{
      id: 'event-associated',
      type: 'smartDetectZone',
      smartDetectTypes: ['face', 'person'],
      camera: 'front',
      start: 40,
      score: 70,
      metadata: {
        detectedAreas: [{ routePath: { lastDirection: [-10, 0] } }],
        detectedThumbnails: [
          {
            type: 'face',
            objectId: 'face-associated',
            attrs: { trackerId: 402 },
            group: {
              id: 'identity-grace',
              name: 'Grace Hopper',
              confidence: 0.93,
            },
            confidence: 86,
            clockBestWall: 40_100_000_000,
          },
          {
            type: 'person',
            objectId: 'person-associated',
            labels: ['group:legacy-person'],
            attrs: { trackerId: 401, associatedFaceTrackerID: 402 },
            confidence: 94,
            clockBestWall: 40_000_000_000,
          },
        ],
      },
    }]);

    expect(events).toEqual([{
      personId: 'identity-grace',
      name: 'Grace Hopper',
      cameraId: 'front',
      timestamp: 40_000_000_000,
      confidence: 0.93,
      directionDegrees: 180,
    }]);
  });

  it('keeps unmatched associated people and unrelated faces separate', () => {
    const events = extractPersonEvents([{
      id: 'event-unmatched',
      type: 'smartDetectZone',
      smartDetectTypes: ['face', 'person'],
      camera: 'front',
      start: 50,
      metadata: {
        detectedThumbnails: [
          {
            type: 'person',
            objectId: 'person-unmatched',
            attributes: { trackerId: 501, associatedFaceTrackerID: 599 },
            confidence: 91,
            clockBestWall: 50_000_000_000,
          },
          {
            type: 'face',
            objectId: 'face-unrelated',
            attributes: { trackerId: 598 },
            group: {
              id: 'identity-unrelated',
              matchedName: 'Unrelated Person',
            },
            confidence: 84,
            clockBestWall: 50_100_000_000,
          },
        ],
      },
    }]);

    expect(events).toEqual([
      {
        personId: 'tracker-501',
        name: 'Person',
        cameraId: 'front',
        timestamp: 50_000_000_000,
        confidence: 91,
        directionDegrees: undefined,
      },
      {
        personId: 'identity-unrelated',
        name: 'Unrelated Person',
        cameraId: 'front',
        timestamp: 50_100_000_000,
        confidence: 84,
        directionDegrees: undefined,
      },
    ]);
  });

  it('preserves multiple people while pairing each matching face', () => {
    const events = extractPersonEvents([{
      id: 'event-crowd',
      type: 'smartDetectZone',
      smartDetectTypes: ['face', 'person'],
      camera: 'front',
      start: 60,
      metadata: {
        detectedThumbnails: [
          {
            type: 'person',
            attributes: { trackerId: 601, associatedFaceTrackerID: 611 },
            clockBestWall: 60_000_000_000,
          },
          {
            type: 'face',
            attributes: { trackerId: 612 },
            group: { id: 'identity-b', name: 'Person B', confidence: 0.82 },
            clockBestWall: 60_300_000_000,
          },
          {
            type: 'person',
            attributes: { trackerId: 602, associatedFaceTrackerID: 612 },
            clockBestWall: 60_100_000_000,
          },
          {
            type: 'face',
            attributes: { trackerId: 611 },
            group: { id: 'identity-a', matchedName: 'Person A', confidence: 0.91 },
            clockBestWall: 60_400_000_000,
          },
          {
            type: 'person',
            attributes: { trackerId: 603 },
            name: 'Person C',
            clockBestWall: 60_200_000_000,
          },
        ],
      },
    }]);

    expect(events).toEqual([
      {
        personId: 'identity-a',
        name: 'Person A',
        cameraId: 'front',
        timestamp: 60_000_000_000,
        confidence: 0.91,
        directionDegrees: undefined,
      },
      {
        personId: 'identity-b',
        name: 'Person B',
        cameraId: 'front',
        timestamp: 60_100_000_000,
        confidence: 0.82,
        directionDegrees: undefined,
      },
      {
        personId: 'tracker-603',
        name: 'Person C',
        cameraId: 'front',
        timestamp: 60_200_000_000,
        confidence: undefined,
        directionDegrees: undefined,
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
    adapter.stop();
    vi.useRealTimers();
  });
});
