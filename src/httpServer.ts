import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mapConfigSchema } from './config.js';
import { MapRenderer } from './renderer.js';
import type { Logger, ProtectPersonEvent } from './types.js';
import { PersonTracker } from './tracker.js';
import { z } from 'zod';

const eventSchema = z.object({
  personId: z.string().min(1).max(128),
  name: z.string().max(128).optional(),
  cameraId: z.string().min(1).max(128),
  timestamp: z.number().int().positive(),
  confidence: z.number().min(0).max(1).optional(),
  directionDegrees: z.number().min(0).lt(360).optional(),
  path: z.array(z.object({ x: z.number().finite(), y: z.number().finite() })).max(64).optional(),
});

export class TrackerHttpServer {
  private server?: Server;

  public constructor(
    private readonly tracker: PersonTracker,
    private readonly renderer: MapRenderer,
    private readonly adminToken: string,
    private readonly logger: Logger,
  ) {}

  public async start(host: string, port: number): Promise<number> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(port, host, resolve);
    });
    const address = this.server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    this.logger.info(`Person tracker map HTTP server listening on ${host}:${actualPort}`);
    return actualPort;
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => error ? reject(error) : resolve());
    });
    this.server = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const pathname = (request.url ?? '/').split('?', 1)[0];
      if (request.method === 'GET' && pathname === '/snapshot.png') {
        const png = await this.renderer.renderPng(this.tracker.snapshot());
        response.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
        });
        response.end(png);
        return;
      }

      if (request.method === 'GET' && pathname === '/state') {
        if (!this.isAuthorized(request)) {
          writeJson(response, 401, { error: 'unauthorized' });
          return;
        }
        writeJson(response, 200, this.tracker.snapshot());
        return;
      }

      if (request.method === 'POST' && pathname === '/events') {
        if (!this.isAuthorized(request)) {
          writeJson(response, 401, { error: 'unauthorized' });
          return;
        }
        const event = eventSchema.parse(await readJson(request));
        const person = this.tracker.ingest(event as ProtectPersonEvent);
        writeJson(response, 202, person);
        return;
      }

      if (request.method === 'POST' && pathname === '/map-config') {
        if (!this.isAuthorized(request)) {
          writeJson(response, 401, { error: 'unauthorized' });
          return;
        }
        const map = mapConfigSchema.parse(await readJson(request));
        this.tracker.setMap(map);
        writeJson(response, 202, map);
        return;
      }

      writeJson(response, 404, { error: 'not_found' });
    } catch (error) {
      this.logger.warn(`Tracker HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
      writeJson(response, 400, { error: 'bad_request' });
    }
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return false;
    }
    const supplied = Buffer.from(header.slice('Bearer '.length));
    const expected = Buffer.from(this.adminToken);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > 1024 * 1024) {
      throw new Error('request body too large');
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}
