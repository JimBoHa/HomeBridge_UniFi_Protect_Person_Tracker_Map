import type { Logger, ProtectConfig, ProtectPersonEvent } from './types.js';

export type ProtectEventSink = (event: ProtectPersonEvent) => void;

export class UniFiProtectAdapter {
  private cookie = '';
  private timer?: NodeJS.Timeout;
  private lastEvent = 0;

  public constructor(
    private readonly config: ProtectConfig | undefined,
    private readonly sink: ProtectEventSink,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

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
      const bootstrap = await this.requestJson('/proxy/protect/api/bootstrap');
      for (const event of extractPersonEvents(bootstrap, this.lastEvent)) {
        this.lastEvent = Math.max(this.lastEvent, event.timestamp);
        this.sink(event);
      }
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
    });
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
    });
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
    url.pathname = path;
    url.search = '';
    return url.toString();
  }
}

export function extractPersonEvents(payload: unknown, afterTimestamp = 0): ProtectPersonEvent[] {
  const events: ProtectPersonEvent[] = [];
  walk(payload, (value) => {
    if (!isRecord(value)) {
      return;
    }

    const type = String(value.type ?? value.smartDetectType ?? value.detectionType ?? '').toLowerCase();
    const hasPersonType = type.includes('person') || arrayIncludesPerson(value.smartDetectTypes) || arrayIncludesPerson(value.types);
    const personName = stringValue(value.name) ?? stringValue(value.personName) ?? stringValue(value.faceName) ?? stringValue(value.metadata, 'name');
    const personId = stringValue(value.personId) ?? stringValue(value.faceId) ?? stringValue(value.userId) ?? personName;
    const cameraId = stringValue(value.cameraId) ?? stringValue(value.deviceId) ?? stringValue(value.camera);
    const timestamp = timestampValue(value.timestamp ?? value.start ?? value.createdAt ?? value.end);

    if (!hasPersonType || !personId || !cameraId || !timestamp || timestamp <= afterTimestamp) {
      return;
    }

    events.push({
      personId,
      name: personName,
      cameraId,
      timestamp,
      confidence: numberValue(value.confidence),
      directionDegrees: numberValue(value.directionDegrees ?? value.direction),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
