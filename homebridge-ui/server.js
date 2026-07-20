import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize } from 'node:path';
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { fetchBootstrap } from './protect-client.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

class TrackerMapUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/save-map-image', this.saveMapImage.bind(this));
    this.onRequest('/load-map-image', this.loadMapImage.bind(this));
    this.onRequest('/discover-cameras', this.discoverCameras.bind(this));
    this.ready();
  }

  async saveMapImage(payload) {
    const dataUrl = typeof payload?.dataUrl === 'string' ? payload.dataUrl : '';
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match) {
      throw new RequestError('Map image must be a PNG or JPEG.', {});
    }

    const [, format, base64] = match;
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new RequestError('Map image must be 10 MB or smaller.', {});
    }

    const directory = join(this.homebridgeStoragePath ?? process.cwd(), 'person-tracker-map');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `map.${format === 'png' ? 'png' : 'jpg'}`);
    await writeFile(path, buffer, { mode: 0o600 });
    return { path };
  }

  async loadMapImage(payload) {
    const path = typeof payload?.path === 'string' ? normalize(payload.path) : '';
    if (!isAbsolute(path) || path.includes('\0')) {
      throw new RequestError('Map image path is invalid.', {});
    }
    const extension = extname(path).toLowerCase();
    const mime = extension === '.png' ? 'image/png' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : undefined;
    if (!mime) {
      throw new RequestError('Map image must be PNG or JPEG.', {});
    }
    const fileStat = await stat(path);
    if (fileStat.size > MAX_IMAGE_BYTES) {
      throw new RequestError('Map image is too large to preview.', {});
    }
    const content = await readFile(path);
    return { dataUrl: `data:${mime};base64,${content.toString('base64')}` };
  }

  async discoverCameras(payload) {
    const protect = await this.resolveProtectConfig(payload?.protect);
    if (!protect.host || !protect.username || !protect.password) {
      throw new RequestError('UniFi Protect credentials not found.', {});
    }

    const bootstrap = await fetchBootstrap(protect);
    return { cameras: extractCameras(bootstrap) };
  }

  async resolveProtectConfig(inline) {
    const direct = sanitizeProtect(inline);
    if (direct.host && direct.username && direct.password) {
      return direct;
    }

    const configPath = this.homebridgeConfigPath;
    if (!configPath) {
      return direct;
    }

    try {
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      const unifi = Array.isArray(config.platforms)
        ? config.platforms.find((platform) => platform?.platform === 'UniFi Protect')
        : undefined;
      const controller = Array.isArray(unifi?.controllers) ? unifi.controllers[0] : undefined;
      return {
        host: direct.host ?? controller?.address,
        username: direct.username ?? controller?.username,
        password: direct.password ?? controller?.password,
        ignoreTls: direct.ignoreTls ?? true,
      };
    } catch {
      return direct;
    }
  }
}

function sanitizeProtect(value) {
  return {
    host: typeof value?.host === 'string' ? value.host.trim() : undefined,
    username: typeof value?.username === 'string' ? value.username : undefined,
    password: typeof value?.password === 'string' ? value.password : undefined,
    ignoreTls: Boolean(value?.ignoreTls),
  };
}

function extractCameras(payload) {
  const candidates = Array.isArray(payload?.cameras) ? payload.cameras : [];
  const cameras = candidates
    .filter((camera) => camera && typeof camera === 'object')
    .map((camera) => ({
      id: stringValue(camera.id) ?? stringValue(camera._id) ?? stringValue(camera.mac),
      name: stringValue(camera.name) ?? stringValue(camera.marketName) ?? stringValue(camera.mac) ?? 'Camera',
      mac: stringValue(camera.mac),
      host: stringValue(camera.host) ?? stringValue(camera.hostAddress) ?? stringValue(camera.ip),
      model: stringValue(camera.marketName) ?? stringValue(camera.modelKey) ?? stringValue(camera.type),
    }))
    .filter((camera) => camera.id);

  const byId = new Map();
  for (const camera of cameras) {
    byId.set(camera.id, camera);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

(() => new TrackerMapUiServer())();
