import type { CameraPlacement, MapConfig, PersonPosition, ProtectPersonEvent, TrackerSnapshot } from './types.js';

const palette = [
  '#d7263d',
  '#1b998b',
  '#2e86ab',
  '#f6ae2d',
  '#5c4d7d',
  '#3bceac',
  '#e84855',
  '#ff9b71',
  '#6a4c93',
  '#1982c4',
];

const DEFAULT_CAMERA_PROJECTION_FEET = 10;
const FOV_WIDTH_DEGREES = 90;

export class PersonTracker {
  private readonly people = new Map<string, PersonPosition>();
  private readonly colors = new Map<string, string>();

  public constructor(
    private map: MapConfig,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  public setMap(map: MapConfig): void {
    this.map = map;
  }

  public ingest(event: ProtectPersonEvent): PersonPosition {
    const previous = this.people.get(event.personId);
    if (previous && event.timestamp < previous.timestamp) {
      this.expire();
      return previous;
    }

    const camera = this.findCamera(event.cameraId);
    const directionDegrees = this.clampToCameraFov(event.directionDegrees ?? this.deriveDirection(event.path, camera, previous), camera);
    const position = event.path?.at(-1)
      ? this.projectPointIntoCameraFov(camera, event.path.at(-1) as { x: number; y: number })
      : this.projectIntoCameraFov(camera, directionDegrees);
    const person: PersonPosition = {
      personId: event.personId,
      name: event.name?.trim() || previous?.name || event.personId,
      color: this.colorFor(event.personId),
      position: this.clamp(position),
      timestamp: event.timestamp,
      directionDegrees,
      sourceCameraId: event.cameraId,
      confidence: event.confidence,
    };

    this.people.set(event.personId, person);
    this.expire();
    return person;
  }

  public snapshot(): TrackerSnapshot {
    this.expire();
    return {
      map: this.map,
      people: [...this.people.values()].sort((a, b) => a.name.localeCompare(b.name)),
      generatedAt: this.now(),
    };
  }

  private findCamera(cameraId: string): CameraPlacement {
    const camera = this.map.cameras.find((candidate) => candidate.id === cameraId);
    if (!camera) {
      throw new Error(`Unknown camera id: ${cameraId}`);
    }
    return camera;
  }

  private deriveDirection(path: { x: number; y: number }[] | undefined, camera: CameraPlacement, previous?: PersonPosition): number | undefined {
    if (path && path.length >= 2) {
      const from = path[path.length - 2];
      const to = path[path.length - 1];
      return normalizeDegrees(Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI);
    }

    if (previous) {
      return normalizeDegrees(Math.atan2(camera.position.y - previous.position.y, camera.position.x - previous.position.x) * 180 / Math.PI);
    }

    return camera.headingDegrees;
  }

  private projectIntoCameraFov(camera: CameraPlacement, directionDegrees: number | undefined): { x: number; y: number } {
    const headingDegrees = camera.headingDegrees ?? directionDegrees ?? 0;
    const bearing = this.clampToCameraFov(directionDegrees ?? headingDegrees, camera) ?? headingDegrees;
    const distance = this.pixelsForFeet(DEFAULT_CAMERA_PROJECTION_FEET);
    const radians = bearing * Math.PI / 180;
    return this.clamp({
      x: camera.position.x + Math.cos(radians) * distance,
      y: camera.position.y + Math.sin(radians) * distance,
    });
  }

  private projectPointIntoCameraFov(camera: CameraPlacement, point: { x: number; y: number }): { x: number; y: number } {
    if (typeof camera.headingDegrees !== 'number') {
      return this.clamp(point);
    }

    const xDelta = point.x - camera.position.x;
    const yDelta = point.y - camera.position.y;
    const distance = Math.hypot(xDelta, yDelta) || this.pixelsForFeet(DEFAULT_CAMERA_PROJECTION_FEET);
    const bearing = normalizeDegrees(Math.atan2(yDelta, xDelta) * 180 / Math.PI);
    const clampedBearing = this.clampToCameraFov(bearing, camera) ?? bearing;
    const radians = clampedBearing * Math.PI / 180;
    return this.clamp({
      x: camera.position.x + Math.cos(radians) * distance,
      y: camera.position.y + Math.sin(radians) * distance,
    });
  }

  private clampToCameraFov(directionDegrees: number | undefined, camera: CameraPlacement): number | undefined {
    if (typeof directionDegrees !== 'number' || typeof camera.headingDegrees !== 'number') {
      return directionDegrees;
    }

    const halfFov = FOV_WIDTH_DEGREES / 2;
    const delta = signedAngleDelta(camera.headingDegrees, directionDegrees);
    return normalizeDegrees(camera.headingDegrees + Math.max(-halfFov, Math.min(halfFov, delta)));
  }

  private pixelsForFeet(feet: number): number {
    if (!this.map.scale) {
      return feet * 10;
    }

    const distance = this.map.scale.unit === 'ft' ? feet : feet * 0.3048;
    return distance * (this.map.scale.pixels / this.map.scale.distance);
  }

  private colorFor(personId: string): string {
    const existing = this.colors.get(personId);
    if (existing) {
      return existing;
    }

    const color = palette[this.colors.size % palette.length];
    this.colors.set(personId, color);
    return color;
  }

  private expire(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [personId, person] of this.people.entries()) {
      if (person.timestamp < cutoff) {
        this.people.delete(personId);
      }
    }
  }

  private clamp(point: { x: number; y: number }): { x: number; y: number } {
    return {
      x: Math.min(this.map.width, Math.max(0, point.x)),
      y: Math.min(this.map.height, Math.max(0, point.y)),
    };
  }
}

export function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

export function signedAngleDelta(fromDegrees: number, toDegrees: number): number {
  const delta = normalizeDegrees(toDegrees) - normalizeDegrees(fromDegrees);
  return delta > 180 ? delta - 360 : delta < -180 ? delta + 360 : delta;
}
