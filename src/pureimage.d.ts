declare module 'pureimage' {
  import type { Readable, Writable } from 'node:stream';

  export type Bitmap = {
    width: number;
    height: number;
    getContext(type: '2d'): CanvasContext;
  };

  export type CanvasContext = {
    fillStyle: string;
    strokeStyle: string;
    lineWidth: number;
    font: string;
    textAlign: 'left' | 'center' | 'right';
    textBaseline: 'top' | 'middle' | 'bottom';
    fillRect(x: number, y: number, width: number, height: number): void;
    drawImage(image: Bitmap, x: number, y: number, width?: number, height?: number): void;
    beginPath(): void;
    arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    closePath(): void;
    fill(): void;
    stroke(): void;
    fillText(text: string, x: number, y: number): void;
    save(): void;
    restore(): void;
    translate(x: number, y: number): void;
    rotate(angle: number): void;
  };

  export function make(width: number, height: number): Bitmap;
  export function encodePNGToStream(bitmap: Bitmap, stream: Writable): Promise<void>;
  export function encodeJPEGToStream(bitmap: Bitmap, stream: Writable, quality?: number): Promise<void>;
  export function decodePNGFromStream(stream: Readable): Promise<Bitmap>;
  export function decodeJPEGFromStream(stream: Readable): Promise<Bitmap>;
}
