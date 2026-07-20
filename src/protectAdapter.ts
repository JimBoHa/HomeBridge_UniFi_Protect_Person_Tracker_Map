import type { Logger, ProtectConfig, ProtectPersonEvent } from './types.js';
import { Agent, fetch as undiciFetch } from 'undici';

export type ProtectEventSink = (event: ProtectPersonEvent) => void;

export class UniFiProtectAdapter {
  private cookie = '';
  private timer?: NodeJS.Timeout;
  private lastEvent: number;
  private readonly tlsAgent?: Agent;

  public constructor(
    private readonly config: ProtectConfig | undefined,
    private readonly sink: ProtectEventSink,
    private readonly logger: Logger,
    // The undici package's fetch, not the Node global: the tlsAgent dispatcher is an
    // undici-package Agent, and handing it to a different undici build (the Node
    // built-in fetch) yields responses with missing headers, so login cookies vanish.
    private readonly fetchImpl: typeof fetch = undiciFetch as unknown as typeof fetch,
    initialLookbackMs = 7 * 24 * 60 * 60 * 1000,
  ) {
    this.tlsAgent = config?.ignoreTls ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
    this.lastEvent = Date.now() - Math.max(10_000, initialLookbackMs);
  }

  public start(): void {
    if (!this.config?.host || !this.config.username || !this.config.password) {
      this.logger.warn('UniFi Protect credentials not configured; use /events endpoint or configure Protect host, username, and password.');
      return;
    }

    const pollMs = Math.max(2, this.config.pollSeconds ?? 5) * 1000;
    this.timer = setInterval(() => {
      void this.poll();
    }, pollMs);
    void this.poll();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    try {
      await this.ensureLogin();
      const end = Date.now();
      const query = new URLSearchParams({
        start: String(this.lastEvent + 1),
        end: String(end),
        limit: '1000',
        type: 'smartDetectZone',
        smartDetectTypes: 'person',
      });
      const eventsPayload = await this.requestJson(`/proxy/protect/api/events?${query.toString()}`);
      const events = extractPersonEvents(eventsPayload, this.lastEvent);
      if (events.length > 0) {
        this.logger.info(`UniFi Protect person events found: ${events.length}`);
      }
      for (const event of events) {
        this.lastEvent = Math.max(this.lastEvent, event.timestamp);
        this.sink(event);
      }
      this.lastEvent = Math.max(this.lastEvent, end - 1000);
    } catch (error) {
      this.logger.warn(`UniFi Protect poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async ensureLogin(): Promise<void> {
    if (this.cookie) {
      return;
    }
    const response = await this.fetchImpl(this.url('/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.config?.username, password: this.config?.password }),
      dispatcher: this.tlsAgent,
    } as FetchOptions);
    if (!response.ok) {
      throw new Error(`login failed: ${response.status}`);
    }
    const cookie = response.headers.get('set-cookie');
    if (!cookie) {
      throw new Error('login response did not include cookie');
    }
    this.cookie = cookie.split(';')[0] ?? '';
  }

  private async requestJson(path: string): Promise<unknown> {
    const response = await this.fetchImpl(this.url(path), {
      headers: { cookie: this.cookie },
      dispatcher: this.tlsAgent,
    } as FetchOptions);
    if (response.status === 401 || response.status === 403) {
      this.cookie = '';
      throw new Error('Protect session expired');
    }
    if (!response.ok) {
      throw new Error(`Protect request failed: ${response.status}`);
    }
    return response.json() as Promise<unknown>;
  }

  private url(path: string): string {
    const rawHost = this.config?.host ?? '';
    const host = rawHost.startsWith('http://') || rawHost.startsWith('https://') ? rawHost : `https://${rawHost}`;
    const url = new URL(host);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('Protect host must be HTTP or HTTPS');
    }
    const [pathname, search] = path.split('?', 2);
    url.pathname = pathname ?? '/';
    url.search = search ? `?${search}` : '';
    return url.toString();
  }
}

type FetchOptions = RequestInit & {
  dispatcher?: Agent;
};

export function extractPersonEvents(payload: unknown, afterTimestamp = 0): ProtectPersonEvent[] {
  const events: ProtectPersonEvent[] = [];
  walk(payload, (value) => {
    if (!isRecord(value)) {
      return;
    }

    const type = String(value.type ?? value.smartDetectType ?? value.detectionType ?? '').toLowerCase();
    const thumbnails = detectedThumbnails(value.metadata);
    const personThumbnails = thumbnails.filter((thumbnail) => thumbnail.type === 'person' || thumbnail.type === 'face');
    const hasPersonType = type.includes('person') || type.includes('face') || arrayIncludesPerson(value.smartDetectTypes) || arrayIncludesPerson(value.types) || personThumbnails.length > 0;
    const personName = stringValue(value.name) ?? stringValue(value.personName) ?? stringValue(value.faceName) ?? stringValue(value.metadata, 'name');
    const cameraId = stringValue(value.cameraId) ?? stringValue(value.deviceId) ?? stringValue(value.camera);
    const timestamp = timestampValue(value.timestamp ?? value.start ?? value.createdAt ?? value.end);

    if (!hasPersonType || !cameraId || !timestamp || timestamp <= afterTimestamp) {
      return;
    }

    if (personThumbnails.length > 0) {
      const directionDegrees = routeDirectionDegrees(value.metadata);
      for (const thumbnail of personThumbnails) {
        const thumbTimestamp = timestampValue(thumbnail.clockBestWall) ?? timestamp;
        const personId = personIdFromThumbnail(thumbnail) ?? stringValue(value.personId) ?? stringValue(value.faceId) ?? stringValue(value.userId) ?? personName ?? String(value.id ?? `${cameraId}:${thumbTimestamp}`);
        events.push({
          personId,
          name: personName ?? nameFromThumbnail(thumbnail),
          cameraId,
          timestamp: thumbTimestamp,
          confidence: numberValue(thumbnail.confidence) ?? numberValue(value.confidence ?? value.score),
          directionDegrees,
        });
      }
      return;
    }

    const personId = stringValue(value.personId) ?? stringValue(value.faceId) ?? stringValue(value.userId) ?? personName ?? String(value.id ?? `${cameraId}:${timestamp}`);
    events.push({
      personId,
      name: personName,
      cameraId,
      timestamp,
      confidence: numberValue(value.confidence ?? value.score),
      directionDegrees: numberValue(value.directionDegrees ?? value.direction) ?? routeDirectionDegrees(value.metadata),
    });
  });
  return dedupeEvents(events);
}

function walk(value: unknown, visit: (value: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visit);
    }
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) {
      walk(item, visit);
    }
  }
}

function dedupeEvents(events: ProtectPersonEvent[]): ProtectPersonEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.personId}:${event.cameraId}:${event.timestamp}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function arrayIncludesPerson(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => String(item).toLowerCase().includes('person'));
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function stringValue(value: unknown, nestedKey?: string): string | undefined {
  if (nestedKey && isRecord(value)) {
    return stringValue(value[nestedKey]);
  }
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

type Thumbnail = {
  type?: string;
  objectId?: string;
  labels?: string[];
  attributes?: Record<string, unknown>;
  confidence?: number;
  clockBestWall?: number;
};

function detectedThumbnails(value: unknown): Thumbnail[] {
  if (!isRecord(value) || !Array.isArray(value.detectedThumbnails)) {
    return [];
  }
  return value.detectedThumbnails
    .filter(isRecord)
    .map((thumbnail) => ({
      type: stringValue(thumbnail.type)?.toLowerCase(),
      objectId: stringValue(thumbnail.objectId),
      labels: Array.isArray(thumbnail.labels) ? thumbnail.labels.map(String) : undefined,
      attributes: isRecord(thumbnail.attributes) ? thumbnail.attributes : undefined,
      confidence: numberValue(thumbnail.confidence),
      clockBestWall: numberValue(thumbnail.clockBestWall),
    }));
}

function personIdFromThumbnail(thumbnail: Thumbnail): string | undefined {
  const group = thumbnail.labels?.find((label) => label.startsWith('group:'))?.split(':')[1];
  const trackerId = numberValue(thumbnail.attributes?.trackerId);
  const associatedFaceTrackerId = numberValue(thumbnail.attributes?.associatedFaceTrackerID);
  return group ?? (associatedFaceTrackerId ? `face-tracker-${associatedFaceTrackerId}` : undefined) ?? (trackerId ? `tracker-${trackerId}` : undefined) ?? thumbnail.objectId;
}

function nameFromThumbnail(thumbnail: Thumbnail): string | undefined {
  const groupType = thumbnail.labels?.find((label) => label.startsWith('groupType:'))?.split(':')[1];
  if (groupType && groupType !== 'unknown') {
    return groupType;
  }
  return thumbnail.type === 'face' ? 'Face' : 'Person';
}

function routeDirectionDegrees(metadata: unknown): number | undefined {
  if (!isRecord(metadata) || !Array.isArray(metadata.detectedAreas)) {
    return undefined;
  }
  for (const area of metadata.detectedAreas) {
    if (!isRecord(area) || !isRecord(area.routePath) || !Array.isArray(area.routePath.lastDirection)) {
      continue;
    }
    const [x, y] = area.routePath.lastDirection;
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
      return ((Math.atan2(y, x) * 180 / Math.PI) % 360 + 360) % 360;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
