import { createReadStream, existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { decodeJPEGFromStream, decodePNGFromStream, encodeJPEGToStream, encodePNGToStream, make, type Bitmap, type CanvasContext } from 'pureimage';
import { requireAbsoluteSafePath } from './config.js';
import type { CameraPlacement, TrackerSnapshot } from './types.js';

export type MapImageSource = {
  path?: string;
  dataUrl?: string;
};

type BitmapWithData = Bitmap & {
  data: Uint8Array;
};

export class MapRenderer {
  private background?: Promise<Bitmap>;
  private readonly mapImagePath?: string;
  private readonly mapImageDataUrl?: string;

  public constructor(mapImage?: string | MapImageSource) {
    ensureFont();
    if (typeof mapImage === 'string') {
      this.mapImagePath = mapImage;
    } else {
      this.mapImagePath = mapImage?.path;
      this.mapImageDataUrl = mapImage?.dataUrl;
    }
  }

  public async renderPng(snapshot: TrackerSnapshot): Promise<Buffer> {
    return this.render(snapshot, 'png');
  }

  public async renderJpeg(snapshot: TrackerSnapshot, width: number, height: number): Promise<Buffer> {
    return this.render(scaleSnapshot(snapshot, width, height), 'jpeg');
  }

  public async renderRawRgba(snapshot: TrackerSnapshot, width: number, height: number): Promise<Buffer> {
    const image = await this.renderBitmap(scaleSnapshot(snapshot, width, height));
    return Buffer.from((image as BitmapWithData).data);
  }

  private async render(snapshot: TrackerSnapshot, format: 'png' | 'jpeg'): Promise<Buffer> {
    const image = await this.renderBitmap(snapshot);
    return format === 'png' ? encodePng(image) : encodeJpeg(image);
  }

  private async renderBitmap(snapshot: TrackerSnapshot): Promise<Bitmap> {
    const image = make(snapshot.map.width, snapshot.map.height);
    const ctx = image.getContext('2d');
    await this.drawBackground(ctx, snapshot);
    this.drawCameras(ctx, snapshot);
    this.drawPeople(ctx, snapshot);
    this.drawFooter(ctx, snapshot);
    return image;
  }

  private async drawBackground(ctx: CanvasContext, snapshot: TrackerSnapshot): Promise<void> {
    ctx.fillStyle = '#f7f7f2';
    ctx.fillRect(0, 0, snapshot.map.width, snapshot.map.height);

    if (!this.mapImagePath && !this.mapImageDataUrl) {
      this.drawGrid(ctx, snapshot.map.width, snapshot.map.height);
      return;
    }

    try {
      const background = await this.loadBackground();
      ctx.drawImage(background, 0, 0, snapshot.map.width, snapshot.map.height);
    } catch {
      this.drawGrid(ctx, snapshot.map.width, snapshot.map.height);
      ctx.fillStyle = '#5f0f40';
      ctx.font = `20px ${FONT_FAMILY}`;
      ctx.fillText('Map image unavailable', 24, 34);
    }
  }

  private drawGrid(ctx: CanvasContext, width: number, height: number): void {
    ctx.strokeStyle = '#d7d7cf';
    ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += 80) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += 80) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  private drawCameras(ctx: CanvasContext, snapshot: TrackerSnapshot): void {
    for (const camera of snapshot.map.cameras) {
      this.drawFovWedge(ctx, camera, snapshot);
      ctx.fillStyle = '#1d3557';
      ctx.beginPath();
      ctx.arc(camera.position.x, camera.position.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1d3557';
      ctx.font = `14px ${FONT_FAMILY}`;
      ctx.fillText(camera.name, camera.position.x + 12, camera.position.y - 6);
    }
  }

  private drawFovWedge(ctx: CanvasContext, camera: CameraPlacement, snapshot: TrackerSnapshot): void {
    if (typeof camera.headingDegrees !== 'number' || typeof camera.fovDegrees !== 'number') {
      return;
    }

    const fov = Math.min(360, camera.fovDegrees);
    const radius = pixelsForFeet(snapshot, 15) ?? 60;
    const startDegrees = camera.headingDegrees - fov / 2;
    const stepCount = Math.max(8, Math.ceil(fov / 5));
    ctx.fillStyle = 'rgba(29, 53, 87, 0.12)';
    ctx.beginPath();
    ctx.moveTo(camera.position.x, camera.position.y);
    for (let step = 0; step <= stepCount; step += 1) {
      const radians = (startDegrees + (fov * step) / stepCount) * Math.PI / 180;
      ctx.lineTo(camera.position.x + Math.cos(radians) * radius, camera.position.y + Math.sin(radians) * radius);
    }
    ctx.closePath();
    ctx.fill();
  }

  private drawPeople(ctx: CanvasContext, snapshot: TrackerSnapshot): void {
    const dotRadius = pixelsForFeet(snapshot, 1.5) ?? 13;
    const dotOutlineRadius = dotRadius + Math.max(2, dotRadius * 0.18);
    for (const person of snapshot.people) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(person.position.x, person.position.y, dotOutlineRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = person.color;
      ctx.beginPath();
      ctx.arc(person.position.x, person.position.y, dotRadius, 0, Math.PI * 2);
      ctx.fill();

      if (typeof person.directionDegrees === 'number') {
        this.drawArrow(ctx, person.position.x, person.position.y, person.directionDegrees, person.color, snapshot, dotOutlineRadius);
      }

      ctx.fillStyle = '#111111';
      ctx.font = `16px ${FONT_FAMILY}`;
      ctx.fillText(`${person.name} ${new Date(person.timestamp).toLocaleTimeString('en-US', { hour12: false })}`, person.position.x + 18, person.position.y + 5);
    }
  }

  private drawArrow(ctx: CanvasContext, x: number, y: number, degrees: number, color: string, snapshot: TrackerSnapshot, offset: number): void {
    const length = pixelsForFeet(snapshot, 10) ?? 46;
    const lineWidth = Math.max(3, Math.min(10, length * 0.12));
    const headLength = Math.max(8, Math.min(18, length * 0.28));
    const headWidth = Math.max(6, Math.min(14, length * 0.22));
    const start = offset + 2;
    const end = start + length;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(degrees * Math.PI / 180);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(start, 0);
    ctx.lineTo(end, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(end + headLength, 0);
    ctx.lineTo(end, -headWidth);
    ctx.lineTo(end, headWidth);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawFooter(ctx: CanvasContext, snapshot: TrackerSnapshot): void {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
    ctx.fillRect(0, snapshot.map.height - 34, snapshot.map.width, 34);
    ctx.fillStyle = '#242423';
    ctx.font = `14px ${FONT_FAMILY}`;
    ctx.fillText(`Updated ${new Date(snapshot.generatedAt).toISOString()} | People: ${snapshot.people.length}`, 16, snapshot.map.height - 12);
  }

  private loadBackground(): Promise<Bitmap> {
    if (!this.mapImagePath && !this.mapImageDataUrl) {
      throw new Error('No map image configured');
    }
    this.background ??= this.mapImageDataUrl
      ? loadBitmapFromDataUrl(this.mapImageDataUrl)
      : loadBitmap(requireAbsoluteSafePath(this.mapImagePath ?? '', 'mapImagePath'));
    return this.background;
  }
}

const FONT_FAMILY = 'TrackerSans';
let fontLoaded = false;
const require = createRequire(import.meta.url);
const { registerFont } = require('pureimage') as {
  registerFont: (fontPath: string, family: string) => { loadSync: () => void };
};

function ensureFont(): void {
  if (fontLoaded) {
    return;
  }

  const fontPath = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/Library/Fonts/Arial.ttf',
  ].find((path) => existsSync(path));

  if (!fontPath) {
    return;
  }

  try {
    registerFont(fontPath, FONT_FAMILY).loadSync();
    fontLoaded = true;
  } catch {
    fontLoaded = false;
  }
}

async function loadBitmap(pathValue: string): Promise<Bitmap> {
  await access(pathValue);
  const extension = extname(pathValue).toLowerCase();
  if (extension === '.png') {
    return decodePNGFromStream(createReadStream(pathValue));
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return decodeJPEGFromStream(createReadStream(pathValue));
  }
  throw new Error('Map image must be PNG or JPEG');
}

async function loadBitmapFromDataUrl(dataUrl: string): Promise<Bitmap> {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) {
    throw new Error('Map image data must be a PNG or JPEG data URL');
  }

  const [, format, base64] = match;
  const buffer = Buffer.from(base64, 'base64');
  const stream = Readable.from(buffer);
  return format === 'png' ? decodePNGFromStream(stream) : decodeJPEGFromStream(stream);
}

async function encodePng(bitmap: Bitmap): Promise<Buffer> {
  return encode(bitmap, (stream) => encodePNGToStream(bitmap, stream));
}

async function encodeJpeg(bitmap: Bitmap): Promise<Buffer> {
  return encode(bitmap, (stream) => encodeJPEGToStream(bitmap, stream, 90));
}

async function encode(bitmap: Bitmap, encoder: (stream: Writable) => Promise<void>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await encoder(stream);
  return Buffer.concat(chunks);
}

function scaleSnapshot(snapshot: TrackerSnapshot, width: number, height: number): TrackerSnapshot {
  const xScale = width / snapshot.map.width;
  const yScale = height / snapshot.map.height;
  const scaleFactor = (xScale + yScale) / 2;
  return {
    generatedAt: snapshot.generatedAt,
    map: {
      width,
      height,
      scale: snapshot.map.scale ? {
        ...snapshot.map.scale,
        pixels: snapshot.map.scale.pixels * scaleFactor,
      } : undefined,
      cameras: snapshot.map.cameras.map((camera) => ({
        ...camera,
        position: {
          x: camera.position.x * xScale,
          y: camera.position.y * yScale,
        },
      })),
    },
    people: snapshot.people.map((person) => ({
      ...person,
      position: {
        x: person.position.x * xScale,
        y: person.position.y * yScale,
      },
    })),
  };
}

function pixelsForFeet(snapshot: TrackerSnapshot, feet: number): number | undefined {
  if (!snapshot.map.scale) {
    return undefined;
  }

  const distance = snapshot.map.scale.unit === 'ft' ? feet : feet * 0.3048;
  return distance * (snapshot.map.scale.pixels / snapshot.map.scale.distance);
}
