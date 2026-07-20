import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  configuredMapConfigPath,
  loadConfiguredMapConfig,
  MAX_MAP_CONFIG_BYTES,
} from '../homebridge-ui/map-config.js';

const temporaryDirectories = [];

async function fixture(mapConfig, mapConfigPath) {
  const directory = await mkdtemp(join(tmpdir(), 'tracker-map-ui-'));
  temporaryDirectories.push(directory);
  const mapPath = mapConfigPath ?? join(directory, 'map.json');
  if (mapConfigPath === undefined) {
    await writeFile(mapPath, JSON.stringify(mapConfig));
  }
  const homebridgePath = join(directory, 'config.json');
  await writeFile(homebridgePath, JSON.stringify({
    platforms: [
      { platform: 'OtherPlugin', mapConfigPath: join(directory, 'wrong.json'), password: 'secret' },
      { platform: 'UniFiProtectPersonTrackerMap', mapConfigPath: mapPath, password: 'secret' },
    ],
  }));
  return { directory, homebridgePath, mapPath };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Homebridge UI map config loader', () => {
  it('loads only the configured plugin map and returns validated map fields', async () => {
    const { homebridgePath, mapPath } = await fixture({
      width: 640,
      height: 480,
      cameras: [{
        id: 'front',
        name: 'Front Door',
        position: { x: 40, y: 60 },
        privateNote: 'do not return',
      }],
      password: 'do not return',
    });

    const result = await loadConfiguredMapConfig(homebridgePath);

    expect(result).toEqual({
      width: 640,
      height: 480,
      cameras: [{ id: 'front', name: 'Front Door', position: { x: 40, y: 60 } }],
    });
    expect(configuredMapConfigPath({
      platforms: [{ platform: 'UniFiProtectPersonTrackerMap', mapConfigPath: mapPath }],
    })).toBe(mapPath);
  });

  it('rejects relative paths and invalid placements without exposing the configured path', async () => {
    expect(() => configuredMapConfigPath({
      platforms: [{ platform: 'UniFiProtectPersonTrackerMap', mapConfigPath: '../private/map.json' }],
    })).toThrow('absolute');

    const { homebridgePath, mapPath } = await fixture({
      width: 100,
      height: 100,
      cameras: [{ id: 'front', name: 'Front', position: { x: 101, y: 50 } }],
    });
    let thrown;
    try {
      await loadConfiguredMapConfig(homebridgePath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown?.message).toBe('Configured map JSON does not match the required map format.');
    expect(thrown?.message).not.toContain(mapPath);
  });

  it('bounds map reads before parsing JSON', async () => {
    const { homebridgePath, mapPath } = await fixture({ width: 1, height: 1, cameras: [] });
    await writeFile(mapPath, `${JSON.stringify({ width: 1, height: 1, cameras: [] })}${' '.repeat(MAX_MAP_CONFIG_BYTES)}`);

    await expect(loadConfiguredMapConfig(homebridgePath)).rejects.toThrow('1 MB or smaller');
  });
});
