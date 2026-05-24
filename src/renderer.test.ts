import { describe, expect, it } from 'vitest';
import { MapRenderer } from './renderer.js';
import type { TrackerSnapshot } from './types.js';

describe('MapRenderer', () => {
  it('renders PNG and JPEG snapshots', async () => {
    const renderer = new MapRenderer();
    const snapshot: TrackerSnapshot = {
      generatedAt: Date.parse('2026-05-24T12:00:00.000Z'),
      map: {
        width: 320,
        height: 180,
        cameras: [{ id: 'front', name: 'Front', position: { x: 60, y: 60 } }],
      },
      people: [{
        personId: 'p1',
        name: 'Ada',
        color: '#d7263d',
        position: { x: 100, y: 70 },
        timestamp: Date.parse('2026-05-24T12:00:00.000Z'),
        directionDegrees: 45,
        sourceCameraId: 'front',
      }],
    };

    const png = await renderer.renderPng(snapshot);
    const jpeg = await renderer.renderJpeg(snapshot, 160, 90);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('falls back to grid when configured image is unavailable', async () => {
    const renderer = new MapRenderer('/tmp/does-not-exist.png');
    const png = await renderer.renderPng({
      generatedAt: Date.now(),
      map: { width: 100, height: 80, cameras: [] },
      people: [],
    });
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});
