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
    const camera = this.findCamera(event.cameraId);
    const previous = this.people.get(event.personId);
    const position = event.path?.at(-1) ?? camera.position;
    const directionDegrees = event.directionDegrees ?? this.deriveDirection(event.path, camera, previous);
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
