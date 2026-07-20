import { describe, expect, it } from 'vitest';
import { normalizeDegrees, PersonTracker, signedAngleDelta } from './tracker.js';
import type { MapConfig } from './types.js';

const map: MapConfig = {
  width: 500,
  height: 300,
  scale: { pixels: 10, distance: 1, unit: 'ft' },
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
      sourceCameraId: 'hall',
    });
    expect(snapshot.people[0]?.position.x).toBeCloseTo(350, 1);
    expect(snapshot.people[0]?.position.y).toBeCloseTo(150, 1);
  });

  it('derives direction from path and clamps map bounds', () => {
    const tracker = new PersonTracker(map, 60_000, () => 1_000);
    const person = tracker.ingest({
      personId: 'p2',
      cameraId: 'front',
      timestamp: 1_000,
      path: [{ x: 50, y: 50 }, { x: 700, y: -20 }],
    });

    expect(person.position.x).toBeCloseTo(500, 1);
    expect(person.position.y).toBeCloseTo(300, 1);
    expect(person.directionDegrees).toBe(45);
  });

  it('projects detections into the camera field of view when no path is available', () => {
    const tracker = new PersonTracker(map, 60_000, () => 1_000);
    const person = tracker.ingest({
      personId: 'p3',
      cameraId: 'front',
      timestamp: 1_000,
      directionDegrees: 200,
    });

    expect(person.position.x).toBeCloseTo(29.29, 1);
    expect(person.position.y).toBeCloseTo(120.71, 1);
    expect(person.directionDegrees).toBe(135);
  });

  it('expires stale people', () => {
    const tracker = new PersonTracker(map, 100, () => 1_000);
    tracker.ingest({ personId: 'old', cameraId: 'front', timestamp: 800 });
    tracker.ingest({ personId: 'new', cameraId: 'front', timestamp: 950 });

    expect(tracker.snapshot().people.map((person) => person.personId)).toEqual(['new']);
  });

  it('releases color assignments when people expire', () => {
    let now = 1_000;
    const tracker = new PersonTracker(map, 100, () => now);
    for (let index = 0; index < 50; index += 1) {
      tracker.ingest({ personId: `front:${index}`, cameraId: 'front', timestamp: now });
      now += 10;
    }

    now += 1_000;
    expect(tracker.snapshot().people).toHaveLength(0);
    const colors = (tracker as unknown as { colors: Map<string, string> }).colors;
    expect(colors.size).toBe(0);
  });

  it('reuses the first available color without colliding with active people', () => {
    let now = 1_000;
    const tracker = new PersonTracker(map, 100, () => now);
    const expired = tracker.ingest({ personId: 'expired', cameraId: 'front', timestamp: now });

    now = 1_050;
    const active = tracker.ingest({ personId: 'active', cameraId: 'front', timestamp: now });
    now = 1_110;
    expect(tracker.snapshot().people.map((person) => person.personId)).toEqual(['active']);

    const newcomer = tracker.ingest({ personId: 'newcomer', cameraId: 'front', timestamp: now });
    const activeColors = tracker.snapshot().people.map((person) => person.color);
    expect(newcomer.color).toBe(expired.color);
    expect(newcomer.color).not.toBe(active.color);
    expect(new Set(activeColors).size).toBe(activeColors.length);
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
    expect(signedAngleDelta(350, 10)).toBe(20);
    expect(signedAngleDelta(10, 350)).toBe(-20);
  });
});
