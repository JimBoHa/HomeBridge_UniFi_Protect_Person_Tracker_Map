import type { Logger, ProtectConfig, ProtectPersonEvent } from './types.js';
import { Agent, fetch as undiciFetch } from 'undici';

export type ProtectEventSink = (event: ProtectPersonEvent) => void;

const REQUEST_TIMEOUT_MS = 30_000;
const EVENT_PAGE_LIMIT = 1000;
const MAX_EVENT_PAGES = 64;
const EVENT_CURSOR_OVERLAP_MS = 15 * 60 * 1000;

type ProtectEventBatch = {
  events: ProtectPersonEvent[];
  completedThrough: number;
};

export class UniFiProtectAdapter {
  private cookie = '';
  private timer?: NodeJS.Timeout;
  private activePoll?: Promise<void>;
  private activeRequest?: AbortController;
  private lastEvent: number;
  private readonly eventQueryFloor: number;
  private cursorAdvanced = false;
  private readonly recentEvents = new Map<string, number>();
  private tlsAgent?: Agent;
  private running = false;

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
    this.lastEvent = Date.now() - Math.max(10_000, initialLookbackMs);
    this.eventQueryFloor = this.lastEvent + 1;
  }

  public start(): void {
    if (!this.config?.host || !this.config.username || !this.config.password) {
      this.logger.warn('UniFi Protect credentials not configured; use /events endpoint or configure Protect host, username, and password.');
      return;
    }

    if (this.running) {
      return;
    }

    this.running = true;
    this.tlsAgent = this.config.ignoreTls ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
    this.runPoll();
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.activeRequest?.abort(abortError('Protect polling stopped'));
    await this.activePoll;

    const tlsAgent = this.tlsAgent;
    this.tlsAgent = undefined;
    this.cookie = '';
    await tlsAgent?.close();
  }

  private runPoll(): void {
    if (!this.running || this.activePoll) {
      return;
    }

    const activePoll = this.poll();
    this.activePoll = activePoll;
    void activePoll.finally(() => {
      if (this.activePoll === activePoll) {
        this.activePoll = undefined;
      }
      this.schedulePoll();
    });
  }

  private schedulePoll(): void {
    if (!this.running) {
      return;
    }

    const pollMs = Math.max(2, this.config?.pollSeconds ?? 5) * 1000;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.runPoll();
    }, pollMs);
  }

  private async poll(): Promise<void> {
    try {
      await this.ensureLogin();
      const end = Date.now();
      const start = this.cursorAdvanced
        ? Math.max(this.eventQueryFloor, this.lastEvent - EVENT_CURSOR_OVERLAP_MS + 1)
        : this.eventQueryFloor;
      const batch = await this.fetchEventRange(start, end);
      const events = dedupeEvents(batch.events)
        .sort((left, right) => left.timestamp - right.timestamp)
        .filter((event) => !this.recentEvents.has(eventFingerprint(event)));
      if (events.length > 0) {
        this.logger.info(`UniFi Protect person events found: ${events.length}`);
      }
      for (const event of events) {
        this.sink(event);
        this.recentEvents.set(eventFingerprint(event), batch.completedThrough);
      }
      this.lastEvent = Math.max(this.lastEvent, batch.completedThrough);
      this.cursorAdvanced = true;
      this.pruneRecentEvents();
    } catch (error) {
      if (!this.running) {
        return;
      }
      this.logger.warn(`UniFi Protect poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private pruneRecentEvents(): void {
    const cutoff = this.lastEvent - EVENT_CURSOR_OVERLAP_MS;
    for (const [fingerprint, cursorTimestamp] of this.recentEvents) {
      if (cursorTimestamp < cutoff) {
        this.recentEvents.delete(fingerprint);
      }
    }
  }

  private async fetchEventRange(start: number, end: number): Promise<ProtectEventBatch> {
    if (start > end) {
      return { events: [], completedThrough: end };
    }

    const events: ProtectPersonEvent[] = [];
    for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
      const payload = await this.requestEventRange(start, end, page * EVENT_PAGE_LIMIT);
      const records = protectEventRecords(payload);
      events.push(...extractPersonEvents(payload, start - 1));
      if (records.length < EVENT_PAGE_LIMIT) {
        return { events, completedThrough: end };
      }
    }

    throw new Error(`Protect event backlog exceeded ${MAX_EVENT_PAGES * EVENT_PAGE_LIMIT} events; refusing to advance cursor`);
  }

  private async requestEventRange(start: number, end: number, offset: number): Promise<unknown> {
    const query = new URLSearchParams({
      start: String(start),
      end: String(end),
      limit: String(EVENT_PAGE_LIMIT),
      offset: String(offset),
      orderBy: 'start',
      orderDirection: 'ASC',
      type: 'smartDetectZone',
      smartDetectTypes: 'person',
    });
    return this.requestJson(`/proxy/protect/api/events?${query.toString()}`);
  }

  private async ensureLogin(): Promise<void> {
    if (this.cookie) {
      return;
    }
    const response = await this.withRequestTimeout((signal) => this.fetchImpl(
      this.url('/api/auth/login'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: this.config?.username, password: this.config?.password }),
        dispatcher: this.tlsAgent,
        signal,
      } as FetchOptions,
    ));
    try {
      if (!response.ok) {
        throw new Error(`login failed: ${response.status}`);
      }
      const cookie = response.headers.get('set-cookie');
      if (!cookie) {
        throw new Error('login response did not include cookie');
      }
      this.cookie = cookie.split(';')[0] ?? '';
    } finally {
      await discardResponseBody(response);
    }
  }

  private async requestJson(path: string): Promise<unknown> {
    return this.withRequestTimeout(async (signal) => {
      const response = await this.fetchImpl(this.url(path), {
        headers: { cookie: this.cookie },
        dispatcher: this.tlsAgent,
        signal,
      } as FetchOptions);
      if (response.status === 401 || response.status === 403) {
        this.cookie = '';
        await discardResponseBody(response);
        throw new Error('Protect session expired');
      }
      if (!response.ok) {
        await discardResponseBody(response);
        throw new Error(`Protect request failed: ${response.status}`);
      }
      return response.json() as Promise<unknown>;
    });
  }

  private async withRequestTimeout<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.running) {
      throw abortError('Protect polling stopped');
    }

    const controller = new AbortController();
    this.activeRequest = controller;
    const timeout = setTimeout(() => {
      const error = new Error(`Protect request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      error.name = 'TimeoutError';
      controller.abort(error);
    }, REQUEST_TIMEOUT_MS);

    try {
      return await request(controller.signal);
    } finally {
      clearTimeout(timeout);
      if (this.activeRequest === controller) {
        this.activeRequest = undefined;
      }
    }
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

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The original request result is more useful than a cleanup failure.
  }
}

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
      for (const { thumbnail, identity } of thumbnailDetections(personThumbnails)) {
        const thumbTimestamp = timestampValue(thumbnail.clockBestWall) ?? timestamp;
        const personId = personIdFromThumbnails(thumbnail, identity) ?? stringValue(value.personId) ?? stringValue(value.faceId) ?? stringValue(value.userId) ?? personName ?? String(value.id ?? `${cameraId}:${thumbTimestamp}`);
        events.push({
          personId,
          name: nameFromThumbnails(thumbnail, identity, personName),
          cameraId,
          timestamp: thumbTimestamp,
          confidence: confidenceFromThumbnails(thumbnail, identity) ?? numberValue(value.confidence ?? value.score),
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

function protectEventRecords(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (isRecord(payload) && Array.isArray(payload.events)) {
    return payload.events;
  }
  if (isRecord(payload) && Array.isArray(payload.data)) {
    return payload.data;
  }
  return [];
}

function eventFingerprint(event: ProtectPersonEvent): string {
  return JSON.stringify([
    event.personId,
    event.name ?? null,
    event.cameraId,
    event.timestamp,
    event.confidence ?? null,
    event.directionDegrees ?? null,
    event.path ?? null,
  ]);
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
  group?: {
    id?: string;
    name?: string;
    matchedName?: string;
    confidence?: number;
  };
  name?: string;
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
      attributes: thumbnailAttributes(thumbnail),
      group: thumbnailGroup(thumbnail.group),
      name: stringValue(thumbnail.name),
      confidence: numberValue(thumbnail.confidence),
      clockBestWall: numberValue(thumbnail.clockBestWall),
    }));
}

function thumbnailAttributes(thumbnail: Record<string, unknown>): Record<string, unknown> | undefined {
  const attrs = isRecord(thumbnail.attrs) ? thumbnail.attrs : undefined;
  const attributes = isRecord(thumbnail.attributes) ? thumbnail.attributes : undefined;
  return attrs || attributes ? { ...attrs, ...attributes } : undefined;
}

function thumbnailGroup(value: unknown): Thumbnail['group'] {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    id: idValue(value.id),
    name: stringValue(value.name),
    matchedName: stringValue(value.matchedName),
    confidence: numberValue(value.confidence),
  };
}

function thumbnailDetections(thumbnails: Thumbnail[]): { thumbnail: Thumbnail; identity?: Thumbnail }[] {
  const facesByTrackerId = new Map<string, Thumbnail[]>();
  for (const thumbnail of thumbnails) {
    if (thumbnail.type !== 'face') {
      continue;
    }
    const trackerId = trackerIdFromThumbnail(thumbnail);
    if (trackerId) {
      facesByTrackerId.set(trackerId, [...(facesByTrackerId.get(trackerId) ?? []), thumbnail]);
    }
  }

  const identities = new Map<Thumbnail, Thumbnail>();
  const matchedFaces = new Set<Thumbnail>();
  for (const thumbnail of thumbnails) {
    if (thumbnail.type !== 'person') {
      continue;
    }
    const associatedFaceTrackerId = idValue(thumbnail.attributes?.associatedFaceTrackerID);
    const identity = associatedFaceTrackerId
      ? facesByTrackerId.get(associatedFaceTrackerId)?.find((face) => !matchedFaces.has(face))
      : undefined;
    if (identity) {
      identities.set(thumbnail, identity);
      matchedFaces.add(identity);
    }
  }

  return thumbnails.flatMap((thumbnail) => {
    if (matchedFaces.has(thumbnail)) {
      return [];
    }
    return [{ thumbnail, identity: identities.get(thumbnail) }];
  });
}

function personIdFromThumbnails(thumbnail: Thumbnail, identity?: Thumbnail): string | undefined {
  const candidates = identity ? [identity, thumbnail] : [thumbnail];
  for (const candidate of candidates) {
    if (candidate.group?.id) {
      return candidate.group.id;
    }
  }
  for (const candidate of candidates) {
    const legacyGroup = labelValue(candidate.labels, 'group:');
    if (legacyGroup) {
      return legacyGroup;
    }
  }
  for (const candidate of candidates) {
    const trackerId = trackerIdFromThumbnail(candidate);
    if (trackerId) {
      return 'tracker-' + trackerId;
    }
  }
  return candidates.find((candidate) => candidate.objectId)?.objectId;
}

function nameFromThumbnails(thumbnail: Thumbnail, identity?: Thumbnail, eventName?: string): string {
  const candidates = identity ? [identity, thumbnail] : [thumbnail];
  for (const candidate of candidates) {
    const name = candidate.group?.matchedName ?? candidate.group?.name ?? candidate.name;
    if (name) {
      return name;
    }
  }
  if (eventName) {
    return eventName;
  }
  for (const candidate of candidates) {
    const groupType = labelValue(candidate.labels, 'groupType:');
    if (groupType && groupType.toLowerCase() !== 'unknown') {
      return groupType;
    }
  }
  return thumbnail.type === 'face' ? 'Face' : 'Person';
}

function confidenceFromThumbnails(thumbnail: Thumbnail, identity?: Thumbnail): number | undefined {
  const candidates = identity ? [identity, thumbnail] : [thumbnail];
  for (const candidate of candidates) {
    if (candidate.group?.confidence !== undefined) {
      return candidate.group.confidence;
    }
  }
  for (const candidate of candidates) {
    if (candidate.confidence !== undefined) {
      return candidate.confidence;
    }
  }
  return undefined;
}

function trackerIdFromThumbnail(thumbnail: Thumbnail): string | undefined {
  return idValue(thumbnail.attributes?.trackerId);
}

function labelValue(labels: string[] | undefined, prefix: string): string | undefined {
  const label = labels?.find((candidate) => candidate.startsWith(prefix));
  return label ? stringValue(label.slice(prefix.length)) : undefined;
}

function idValue(value: unknown): string | undefined {
  return stringValue(value) ?? (typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined);
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
