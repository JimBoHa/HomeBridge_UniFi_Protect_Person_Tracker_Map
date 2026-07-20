import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import type { MapConfig, PluginConfig } from './types.js';

const MAX_MAP_IMAGE_DATA_BYTES = 10 * 1024 * 1024;

const pointSchema = z.object({
  x: z.number().finite().min(0),
  y: z.number().finite().min(0),
});

const mapImageDataSchema = z.string()
  .max(Math.ceil(MAX_MAP_IMAGE_DATA_BYTES * 1.4), 'map image data is too large')
  .regex(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/, 'map image must be a PNG or JPEG data URL')
  .superRefine((value, ctx) => {
    const base64 = value.slice(value.indexOf(',') + 1);
    const byteLength = Buffer.byteLength(base64, 'base64');
    if (byteLength > MAX_MAP_IMAGE_DATA_BYTES) {
      ctx.addIssue({
        code: 'custom',
        message: 'map image data must be 10 MB or smaller',
      });
    }
  });

export const mapConfigSchema = z.object({
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
    fovDegrees: z.number().finite().min(10).max(360).optional(),
  })).max(512),
}).superRefine((config, ctx) => {
  const cameraIds = new Set<string>();
  for (const [index, camera] of config.cameras.entries()) {
    if (cameraIds.has(camera.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cameras', index, 'id'],
        message: 'camera id must be unique',
      });
    }
    cameraIds.add(camera.id);
    if (camera.position.x > config.width || camera.position.y > config.height) {
      ctx.addIssue({
        code: 'custom',
        path: ['cameras', index, 'position'],
        message: 'camera position must be inside map bounds',
      });
    }
  }
});

export const pluginConfigSchema = z.object({
  name: z.string().min(1).max(128).default('Person Tracker Map'),
  mapImagePath: z.string().optional(),
  mapImageData: mapImageDataSchema.optional(),
  mapConfigPath: z.string().optional(),
  mapConfig: mapConfigSchema.optional(),
  bindHost: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(0),
  adminToken: z.string().min(24).optional(),
  protect: z.object({
    host: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    ignoreTls: z.boolean().default(false),
    pollSeconds: z.number().int().min(2).default(5),
  }).optional(),
  peopleTtlSeconds: z.number().int().min(10).default(86400),
  ffmpegPath: z.string().min(1).default('ffmpeg'),
  motionSensor: z.boolean().default(false),
  motionResetSeconds: z.number().int().min(5).max(3600).default(30),
});

export type ResolvedPluginConfig = z.infer<typeof pluginConfigSchema> & {
  adminToken: string;
};

export function resolvePluginConfig(raw: PluginConfig): ResolvedPluginConfig {
  const parsed = pluginConfigSchema.parse(raw);
  return {
    ...parsed,
    adminToken: parsed.adminToken ?? randomBytes(32).toString('hex'),
  };
}

export function requireAbsoluteSafePath(pathValue: string, fieldName: string): string {
  const normalized = normalize(pathValue);
  if (!isAbsolute(normalized)) {
    throw new Error(`${fieldName} must be an absolute path`);
  }
  if (normalized.includes('\0')) {
    throw new Error(`${fieldName} contains invalid characters`);
  }
  return normalized;
}

export async function loadMapConfig(configPath?: string, inlineConfig?: MapConfig): Promise<MapConfig> {
  if (inlineConfig) {
    return mapConfigSchema.parse(inlineConfig);
  }

  if (!configPath) {
    return {
      width: 1280,
      height: 720,
      cameras: [],
    };
  }

  const safePath = requireAbsoluteSafePath(configPath, 'mapConfigPath');
  const content = await readFile(safePath, 'utf8');
  return mapConfigSchema.parse(JSON.parse(content));
}
