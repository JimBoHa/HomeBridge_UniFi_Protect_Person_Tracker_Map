import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { decodeJPEGFromStream, decodePNGFromStream, encodeJPEGToStream, encodePNGToStream, make, type Bitmap, type CanvasContext } from 'pureimage';
import { requireAbsoluteSafePath } from './config.js';
import type { TrackerSnapshot } from './types.js';

export type MapImageSource = {
  path?: string;
  dataUrl?: string;
};

export class MapRenderer {
  private background?: Promise<Bitmap>;
  private readonly mapImagePath?: string;
  private readonly mapImageDataUrl?: string;

  public constructor(mapImage?: string | MapImageSource) {
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

  private async render(snapshot: TrackerSnapshot, format: 'png' | 'jpeg'): Promise<Buffer> {
    const image = make(snapshot.map.width, snapshot.map.height);
    const ctx = image.getContext('2d');
    await this.drawBackground(ctx, snapshot);
    this.drawCameras(ctx, snapshot);
    this.drawPeople(ctx, snapshot);
    this.drawFooter(ctx, snapshot);
    return format === 'png' ? encodePng(image) : encodeJpeg(image);
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
      ctx.font = '20px sans-serif';
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
      ctx.fillStyle = '#1d3557';
      ctx.beginPath();
      ctx.arc(camera.position.x, camera.position.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1d3557';
      ctx.font = '14px sans-serif';
      ctx.fillText(camera.name, camera.position.x + 12, camera.position.y - 6);
    }
  }

  private drawPeople(ctx: CanvasContext, snapshot: TrackerSnapshot): void {
    for (const person of snapshot.people) {
      ctx.fillStyle = person.color;
      ctx.beginPath();
      ctx.arc(person.position.x, person.position.y, 13, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(person.position.x, person.position.y, 13, 0, Math.PI * 2);
      ctx.stroke();

      if (typeof person.directionDegrees === 'number') {
        this.drawArrow(ctx, person.position.x, person.position.y, person.directionDegrees, person.color);
      }

      ctx.fillStyle = '#111111';
      ctx.font = '16px sans-serif';
      ctx.fillText(`${person.name} ${new Date(person.timestamp).toLocaleTimeString('en-US', { hour12: false })}`, person.position.x + 18, person.position.y + 5);
    }
  }

  private drawArrow(ctx: CanvasContext, x: number, y: number, degrees: number, color: string): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(degrees * Math.PI / 180);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(18, 0);
    ctx.lineTo(58, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(64, 0);
    ctx.lineTo(48, -10);
    ctx.lineTo(48, 10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawFooter(ctx: CanvasContext, snapshot: TrackerSnapshot): void {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
    ctx.fillRect(0, snapshot.map.height - 34, snapshot.map.width, 34);
    ctx.fillStyle = '#242423';
    ctx.font = '14px sans-serif';
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
  return {
    generatedAt: snapshot.generatedAt,
    map: {
      width,
      height,
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
