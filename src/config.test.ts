import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMapConfig, mapConfigSchema, requireAbsoluteSafePath, resolvePluginConfig } from './config.js';

describe('config validation', () => {
  it('generates a strong admin token when omitted', () => {
    const config = resolvePluginConfig({ name: 'Map' });
    expect(config.adminToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects short admin tokens', () => {
    expect(() => resolvePluginConfig({ name: 'Map', adminToken: 'short' })).toThrow();
  });

  it('accepts inline map config and rejects unsafe uploaded image data', async () => {
    await expect(loadMapConfig(undefined, {
      width: 100,
      height: 100,
      scale: { pixels: 50, distance: 10, unit: 'ft' },
      cameras: [{ id: 'front', name: 'Front', position: { x: 10, y: 20 } }],
    })).resolves.toMatchObject({ width: 100, scale: { unit: 'ft' }, cameras: [{ id: 'front' }] });

    expect(() => resolvePluginConfig({
      name: 'Map',
      mapImageData: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    })).toThrow('map image');
  });

  it('requires absolute local paths to prevent ambiguous traversal', () => {
    expect(() => requireAbsoluteSafePath('../secret', 'mapImagePath')).toThrow('absolute');
    expect(requireAbsoluteSafePath('/tmp/map.png', 'mapImagePath')).toBe('/tmp/map.png');
  });

  it('rejects camera coordinates outside map bounds', () => {
    expect(() => mapConfigSchema.parse({
      width: 100,
      height: 100,
      cameras: [{ id: 'a', name: 'A', position: { x: 200, y: 50 } }],
    })).toThrow('camera position');
  });

  it('rejects duplicate camera ids from manual configuration', () => {
    expect(() => mapConfigSchema.parse({
      width: 100,
      height: 100,
      cameras: [
        { id: 'front', name: 'Front', position: { x: 10, y: 20 } },
        { id: 'front', name: 'Duplicate', position: { x: 30, y: 40 } },
      ],
    })).toThrow('camera id must be unique');
  });

  it('loads default and file-backed map config', async () => {
    expect(await loadMapConfig()).toEqual({ width: 1280, height: 720, cameras: [] });
    const directory = await mkdtemp(join(tmpdir(), 'tracker-map-'));
    const configPath = join(directory, 'map.json');
    await writeFile(configPath, JSON.stringify({
      width: 100,
      height: 100,
      cameras: [{ id: 'front', name: 'Front', position: { x: 10, y: 20 } }],
    }));

    expect(await loadMapConfig(configPath)).toMatchObject({ width: 100, height: 100 });
  });
});
