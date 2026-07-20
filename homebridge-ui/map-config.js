import { open } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';

const PLATFORM = 'UniFiProtectPersonTrackerMap';
const MAX_HOMEBRIDGE_CONFIG_BYTES = 32 * 1024 * 1024;
export const MAX_MAP_CONFIG_BYTES = 1024 * 1024;

const pointSchema = z.object({
  x: z.number().finite().min(0),
  y: z.number().finite().min(0),
});

const mapConfigSchema = z.object({
  width: z.number().int().positive().max(10000),
  height: z.number().int().positive().max(10000),
  scale: z.object({
    pixels: z.number().finite().positive().max(10000),
    distance: z.number().finite().positive().max(100000),
    unit: z.enum(['ft', 'm']),
  }).optional(),
  cameras: z.array(z.object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    position: pointSchema,
    headingDegrees: z.number().finite().min(0).lt(360).optional(),
  })).max(512),
}).superRefine((config, context) => {
  for (const [index, camera] of config.cameras.entries()) {
    if (camera.position.x > config.width || camera.position.y > config.height) {
      context.addIssue({
        code: 'custom',
        path: ['cameras', index, 'position'],
        message: 'camera position must be inside map bounds',
      });
    }
  }
});

export class MapConfigLoadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MapConfigLoadError';
  }
}

function safeAbsolutePath(pathValue, fieldName) {
  if (typeof pathValue !== 'string' || !pathValue.trim()) {
    throw new MapConfigLoadError(`${fieldName} is not configured.`);
  }
  if (pathValue.includes('\0')) {
    throw new MapConfigLoadError(`${fieldName} contains invalid characters.`);
  }

  const path = normalize(pathValue);
  if (!isAbsolute(path)) {
    throw new MapConfigLoadError(`${fieldName} must be an absolute path.`);
  }
  return path;
}

async function readBoundedFile(path, maxBytes, messages) {
  let handle;
  try {
    handle = await open(path, 'r');
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new MapConfigLoadError(messages.notFile);
    }
    if (fileStat.size > maxBytes) {
      throw new MapConfigLoadError(messages.tooLarge);
    }

    const chunks = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const bytesRemaining = maxBytes + 1 - totalBytes;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, bytesRemaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }

    if (totalBytes > maxBytes) {
      throw new MapConfigLoadError(messages.tooLarge);
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  } catch (error) {
    if (error instanceof MapConfigLoadError) throw error;
    throw new MapConfigLoadError(messages.unreadable);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseJson(content, invalidMessage) {
  try {
    return JSON.parse(content);
  } catch {
    throw new MapConfigLoadError(invalidMessage);
  }
}

export function configuredMapConfigPath(homebridgeConfig) {
  const platform = Array.isArray(homebridgeConfig?.platforms)
    ? homebridgeConfig.platforms.find((candidate) => candidate?.platform === PLATFORM)
    : undefined;
  return safeAbsolutePath(platform?.mapConfigPath, 'mapConfigPath');
}

export async function loadConfiguredMapConfig(homebridgeConfigPath) {
  const configPath = safeAbsolutePath(homebridgeConfigPath, 'Homebridge config path');
  const homebridgeContent = await readBoundedFile(configPath, MAX_HOMEBRIDGE_CONFIG_BYTES, {
    notFile: 'Homebridge config path is not a file.',
    tooLarge: 'Homebridge config is too large to inspect safely.',
    unreadable: 'Homebridge config could not be read.',
  });
  const homebridgeConfig = parseJson(homebridgeContent, 'Homebridge config contains invalid JSON.');
  const mapPath = configuredMapConfigPath(homebridgeConfig);
  const mapContent = await readBoundedFile(mapPath, MAX_MAP_CONFIG_BYTES, {
    notFile: 'Configured map path is not a file.',
    tooLarge: 'Configured map JSON must be 1 MB or smaller.',
    unreadable: 'Configured map JSON could not be read.',
  });
  const mapConfig = parseJson(mapContent, 'Configured map file contains invalid JSON.');
  const result = mapConfigSchema.safeParse(mapConfig);
  if (!result.success) {
    throw new MapConfigLoadError('Configured map JSON does not match the required map format.');
  }
  return result.data;
}
