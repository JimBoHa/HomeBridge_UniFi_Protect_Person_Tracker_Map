import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import type { Writable } from 'node:stream';
import type {
  CameraStreamingDelegate,
  PrepareStreamCallback,
  PrepareStreamRequest,
  SnapshotRequest,
  SnapshotRequestCallback,
  StartStreamRequest,
  StreamRequestCallback,
  StreamingRequest,
  StopStreamRequest,
} from 'homebridge';
import { StreamRequestTypes, SRTPCryptoSuites } from 'homebridge';
import type { Logger } from './types.js';
import { MapRenderer } from './renderer.js';
import { PersonTracker } from './tracker.js';

export type ProcessSpawner = (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams;

type SessionInfo = {
  address: string;
  videoPort: number;
  localVideoPort: number;
  videoSsrc: number;
  srtpKey: Buffer;
  srtpSalt: Buffer;
  process?: ChildProcessWithoutNullStreams;
  frameTimer?: NodeJS.Timeout;
  cachedFrame?: Buffer;
  frameRenderedAt?: number;
  frameRender?: Promise<void>;
  frameWriteState?: FrameWriteState;
  finishStart?: (error?: Error) => void;
};

export type FrameWriteState = {
  blocked: boolean;
};

export class MapCameraDelegate implements CameraStreamingDelegate {
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly frameCache = new Map<string, { buffer: Buffer; timestamp: number }>();

  public constructor(
    private readonly tracker: PersonTracker,
    private readonly renderer: MapRenderer,
    ffmpegPath: string,
    private readonly logger: Logger,
    private readonly processSpawner: ProcessSpawner = spawn,
  ) {
    this.ffmpegPath = resolveFfmpegPath(ffmpegPath);
  }

  private readonly ffmpegPath: string;

  public handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    void this.renderer.renderJpeg(this.tracker.snapshot(), request.width, request.height)
      .then((buffer) => {
        callback(undefined, buffer);
      })
      .catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
  }

  public prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    void allocateUdpPort().then((localVideoPort) => {
      const session: SessionInfo = {
        address: request.targetAddress,
        videoPort: request.video.port,
        localVideoPort,
        videoSsrc: randomSsrc(),
        srtpKey: request.video.srtp_key,
        srtpSalt: request.video.srtp_salt,
      };
      this.sessions.set(request.sessionID, session);
      callback(undefined, {
        video: {
          port: localVideoPort,
          ssrc: session.videoSsrc,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
      });
    }).catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
  }

  public handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    if (request.type === StreamRequestTypes.START) {
      this.startStream(request, callback);
      return;
    }
    if (request.type === StreamRequestTypes.STOP) {
      this.stopStream(request, callback);
      return;
    }
    callback();
  }

  private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void {
    const session = this.sessions.get(request.sessionID);
    if (!session) {
      callback(new Error(`Unknown stream session: ${request.sessionID}`));
      return;
    }

    const cryptoSuite = SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80;
    const srtpParams = Buffer.concat([session.srtpKey, session.srtpSalt]).toString('base64');
    const fps = Math.min(Math.max(1, request.video.fps || 10), 10);
    const width = request.video.width || 1280;
    const height = request.video.height || 720;
    session.cachedFrame = this.getCachedFrame(width, height);
    session.frameRenderedAt = session.cachedFrame ? Date.now() : undefined;
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${width}x${height}`,
      '-r', String(fps),
      '-i', 'pipe:0',
      '-an',
      '-vcodec', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'baseline',
      '-level', '3.1',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-bf', '0',
      '-r', String(fps),
      '-b:v', `${Math.max(128, request.video.max_bit_rate || 300)}k`,
      '-maxrate', `${Math.max(128, request.video.max_bit_rate || 300)}k`,
      '-bufsize', `${Math.max(256, (request.video.max_bit_rate || 300) * 2)}k`,
      '-payload_type', String(request.video.pt),
      '-ssrc', String(session.videoSsrc),
      '-f', 'rtp',
      '-srtp_out_suite', cryptoSuite === SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80 ? 'AES_CM_128_HMAC_SHA1_80' : 'NONE',
      '-srtp_out_params', srtpParams,
      `srtp://${session.address}:${session.videoPort}?rtcpport=${session.videoPort}&pkt_size=${request.video.mtu}`,
    ];

    this.logger.info(`Starting map stream ${width}x${height}@${fps}fps to ${session.address}:${session.videoPort} from ${session.localVideoPort}`);
    let callbackFinished = false;
    const finishStart = (error?: Error): void => {
      if (callbackFinished) {
        return;
      }
      callbackFinished = true;
      if (session.finishStart === finishStart) {
        session.finishStart = undefined;
      }
      if (error) {
        callback(error);
      } else {
        callback();
      }
    };
    session.finishStart = finishStart;

    let ffmpegProcess: ChildProcessWithoutNullStreams;
    try {
      ffmpegProcess = this.processSpawner(this.ffmpegPath, args);
    } catch (error: unknown) {
      const spawnError = toError(error);
      this.cleanupSession(request.sessionID, session, undefined);
      this.logger.error(`Unable to start ffmpeg: ${spawnError.message}`);
      finishStart(spawnError);
      return;
    }

    session.process = ffmpegProcess;
    let processFinished = false;
    ffmpegProcess.on('error', (error) => {
      if (processFinished) {
        return;
      }
      processFinished = true;
      this.cleanupSession(request.sessionID, session, ffmpegProcess);
      if (!callbackFinished) {
        this.logger.error(`Unable to start ffmpeg: ${error.message}`);
        finishStart(error);
      } else {
        this.logger.warn(`ffmpeg process error: ${error.message}`);
      }
    });
    ffmpegProcess.once('exit', (code, signal) => {
      if (processFinished) {
        return;
      }
      processFinished = true;
      this.cleanupSession(request.sessionID, session, ffmpegProcess);
      if (code !== null && code !== 0) {
        this.logger.warn(`ffmpeg exited with code ${code}`);
      } else if (signal) {
        this.logger.info(`Map stream stopped by signal ${signal}`);
      } else {
        this.logger.info('Map stream exited');
      }
      if (!callbackFinished) {
        finishStart(new Error(`ffmpeg exited before stream started${code !== null ? ` with code ${code}` : ''}`));
      }
    });
    ffmpegProcess.stdin.on('error', (error) => this.logger.debug(`ffmpeg stdin: ${error.message}`));
    ffmpegProcess.stderr.on('data', (data: Buffer) => this.logger.warn(`ffmpeg: ${data.toString('utf8').trim()}`));
    const refreshFrame = (): void => {
      if (session.frameRender) {
        return;
      }

      session.frameRender = this.renderer.renderRawRgba(this.tracker.snapshot(), width, height)
        .then((buffer) => {
          session.cachedFrame = buffer;
          session.frameRenderedAt = Date.now();
          this.setCachedFrame(width, height, buffer);
        })
        .catch((error: unknown) => this.logger.warn(`stream frame render failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          session.frameRender = undefined;
        });
    };
    const writeFrame = (): void => {
      if (!session.cachedFrame || !session.frameRenderedAt || Date.now() - session.frameRenderedAt > 1000) {
        refreshFrame();
      }
      if (session.process === ffmpegProcess && session.cachedFrame && ffmpegProcess.stdin.writable) {
        session.frameWriteState ??= { blocked: false };
        writeFrameWithBackpressure(ffmpegProcess.stdin, session.cachedFrame, session.frameWriteState);
      }
    };
    ffmpegProcess.once('spawn', () => {
      if (this.sessions.get(request.sessionID) !== session || session.process !== ffmpegProcess) {
        this.killProcess(ffmpegProcess);
        finishStart(new Error(`Stream session stopped before ffmpeg started: ${request.sessionID}`));
        return;
      }
      writeFrame();
      session.frameTimer = setInterval(writeFrame, Math.max(250, Math.floor(1000 / fps)));
      finishStart();
    });
  }

  private stopStream(request: StopStreamRequest, callback: StreamRequestCallback): void {
    const session = this.sessions.get(request.sessionID);
    this.logger.info(`Stopping map stream for session ${request.sessionID}`);
    if (session) {
      const ffmpegProcess = session.process;
      const finishStart = session.finishStart;
      this.cleanupSession(request.sessionID, session, ffmpegProcess);
      finishStart?.(new Error(`Stream stopped before ffmpeg started: ${request.sessionID}`));
      if (ffmpegProcess) {
        this.killProcess(ffmpegProcess);
      }
    }
    callback();
  }

  private cleanupSession(
    sessionID: string,
    session: SessionInfo,
    expectedProcess: ChildProcessWithoutNullStreams | undefined,
  ): void {
    if (session.process !== expectedProcess) {
      return;
    }
    if (session.frameTimer) {
      clearInterval(session.frameTimer);
      session.frameTimer = undefined;
    }
    session.process = undefined;
    if (this.sessions.get(sessionID) === session) {
      this.sessions.delete(sessionID);
    }
  }

  private killProcess(ffmpegProcess: ChildProcessWithoutNullStreams): void {
    if (ffmpegProcess.killed) {
      return;
    }
    try {
      ffmpegProcess.kill('SIGTERM');
    } catch (error: unknown) {
      this.logger.warn(`Unable to stop ffmpeg: ${toError(error).message}`);
    }
  }

  private setCachedFrame(width: number, height: number, buffer: Buffer): void {
    this.frameCache.set(frameCacheKey(width, height), { buffer, timestamp: Date.now() });
  }

  private getCachedFrame(width: number, height: number): Buffer | undefined {
    const cached = this.frameCache.get(frameCacheKey(width, height));
    if (!cached || Date.now() - cached.timestamp > 30_000) {
      return undefined;
    }
    return cached.buffer;
  }
}

async function allocateUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', reject);
    socket.bind(0, () => {
      const address = socket.address();
      socket.close();
      resolve(typeof address === 'object' ? address.port : 0);
    });
  });
}

function randomSsrc(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

function frameCacheKey(width: number, height: number): string {
  return `${width}x${height}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function writeFrameWithBackpressure(stdin: Writable, frame: Buffer, state: FrameWriteState): void {
  if (!stdin.writable || state.blocked) {
    return;
  }
  if (!stdin.write(frame)) {
    state.blocked = true;
    stdin.once('drain', () => {
      state.blocked = false;
    });
  }
}

function resolveFfmpegPath(ffmpegPath: string): string {
  if (ffmpegPath !== 'ffmpeg') {
    return ffmpegPath;
  }

  const bundledPaths = [
    '/var/lib/homebridge/node_modules/homebridge-unifi-protect/node_modules/ffmpeg-for-homebridge/ffmpeg',
    '/var/lib/homebridge/node_modules/ffmpeg-for-homebridge/ffmpeg',
  ];
  return bundledPaths.find((path) => existsSync(path)) ?? ffmpegPath;
}
