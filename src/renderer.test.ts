import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { encodePNGToStream, make } from 'pureimage';
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
        trail: [{ x: 40, y: 40 }, { x: 70, y: 55 }],
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

  it('renders an uploaded PNG data URL as the map background', async () => {
    const renderer = new MapRenderer({ dataUrl: await makePngDataUrl() });
    const png = await renderer.renderPng({
      generatedAt: Date.now(),
      map: { width: 20, height: 20, cameras: [] },
      people: [],
    });
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('renders every trail below every current marker', async () => {
    const width = 120;
    const height = 100;
    const renderer = new MapRenderer();
    const rgba = await renderer.renderRawRgba({
      generatedAt: Date.now(),
      map: { width, height, cameras: [] },
      people: [
        {
          personId: 'first',
          name: 'First',
          color: '#d7263d',
          position: { x: 50, y: 50 },
          timestamp: Date.now(),
          sourceCameraId: 'front',
        },
        {
          personId: 'second',
          name: 'Second',
          color: '#1b998b',
          position: { x: 90, y: 50 },
          timestamp: Date.now(),
          sourceCameraId: 'hall',
          trail: [{ x: 10, y: 50 }],
        },
      ],
    }, width, height);
    const firstMarkerCenter = (50 * width + 50) * 4;

    expect([...rgba.subarray(firstMarkerCenter, firstMarkerCenter + 4)]).toEqual([215, 38, 61, 255]);
  });
});

async function makePngDataUrl(): Promise<string> {
  const bitmap = make(2, 2);
  const ctx = bitmap.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 2, 2);
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await encodePNGToStream(bitmap, stream);
  return `data:image/png;base64,${Buffer.concat(chunks).toString('base64')}`;
}
