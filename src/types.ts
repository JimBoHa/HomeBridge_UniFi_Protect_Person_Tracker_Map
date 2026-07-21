export type Point = {
  x: number;
  y: number;
};

export type CameraPlacement = {
  id: string;
  name: string;
  position: Point;
  headingDegrees?: number;
  fovDegrees?: number;
};

export type MapConfig = {
  width: number;
  height: number;
  cameras: CameraPlacement[];
  scale?: MapScale;
};

export type MapScale = {
  pixels: number;
  distance: number;
  unit: 'ft' | 'm';
};

export type ProtectPersonEvent = {
  personId: string;
  name?: string;
  cameraId: string;
  timestamp: number;
  confidence?: number;
  directionDegrees?: number;
  path?: Point[];
};

export type PersonPosition = {
  personId: string;
  name: string;
  color: string;
  position: Point;
  timestamp: number;
  directionDegrees?: number;
  sourceCameraId: string;
  confidence?: number;
  trail?: Point[];
};

export type TrackerSnapshot = {
  map: MapConfig;
  people: PersonPosition[];
  generatedAt: number;
};

export type ProtectConfig = {
  host?: string;
  username?: string;
  password?: string;
  ignoreTls?: boolean;
  pollSeconds?: number;
};

export type PluginConfig = {
  name?: string;
  mapImagePath?: string;
  mapImageData?: string;
  mapConfigPath?: string;
  mapConfig?: MapConfig;
  bindHost?: string;
  port?: number;
  adminToken?: string;
  protect?: ProtectConfig;
  peopleTtlSeconds?: number;
  ffmpegPath?: string;
  motionSensor?: boolean;
  motionResetSeconds?: number;
  trailPoints?: number;
};

export type Logger = {
  debug(message: string, ...parameters: unknown[]): void;
  info(message: string, ...parameters: unknown[]): void;
  warn(message: string, ...parameters: unknown[]): void;
  error(message: string, ...parameters: unknown[]): void;
};
