import { describe, expect, it } from 'vitest';
import { normalizeDegrees, PersonTracker } from './tracker.js';
import type { MapConfig } from './types.js';

const map: MapConfig = {
  width: 500,
  height: 300,
  cameras: [
    { id: 'front', name: 'Front', position: { x: 100, y: 50 }, headingDegrees: 90 },
    { id: 'hall', name: 'Hall', position: { x: 250, y: 150 } },
  ],
};

describe('PersonTracker', () => {
  it('keeps one dot per unique person and updates position', () => {
    const tracker = new PersonTracker(map, 60_000, () => 2_000);
    tracker.ingest({ personId: 'p1', name: 'Ada', cameraId: 'front', timestamp: 1_000 });
    tracker.ingest({ personId: 'p1', name: 'Ada', cameraId: 'hall', timestamp: 2_000 });

    const snapshot = tracker.snapshot();
    expect(snapshot.people).toHaveLength(1);
    expect(snapshot.people[0]).toMatchObject({
      personId: 'p1',
      name: 'Ada',
      position: { x: 250, y: 150 },
      sourceCameraId: 'hall',
    });
  });

  it('derives direction from path and clamps map bounds', () => {
    const tracker = new PersonTracker(map, 60_000, () => 1_000);
    const person = tracker.ingest({
      personId: 'p2',
      cameraId: 'front',
      timestamp: 1_000,
      path: [{ x: 50, y: 50 }, { x: 700, y: -20 }],
    });

    expect(person.position).toEqual({ x: 500, y: 0 });
    expect(person.directionDegrees).toBeCloseTo(353.85, 1);
  });

  it('expires stale people', () => {
    const tracker = new PersonTracker(map, 100, () => 1_000);
    tracker.ingest({ personId: 'old', cameraId: 'front', timestamp: 800 });
    tracker.ingest({ personId: 'new', cameraId: 'front', timestamp: 950 });

    expect(tracker.snapshot().people.map((person) => person.personId)).toEqual(['new']);
  });

  it('rejects unknown cameras', () => {
    const tracker = new PersonTracker(map, 60_000);
    expect(() => tracker.ingest({ personId: 'p1', cameraId: 'missing', timestamp: 1 })).toThrow('Unknown camera id');
  });
});

describe('normalizeDegrees', () => {
  it('normalizes negative and overflowing values', () => {
    expect(normalizeDegrees(-90)).toBe(270);
    expect(normalizeDegrees(450)).toBe(90);
  });
});
