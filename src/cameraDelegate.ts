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
export type StreamTerminationHandler = (sessionID: string) => void;

export const FFMPEG_TERMINATION_GRACE_MS = 5_000;

type SessionInfo = {
  address: string;
  addressVersion: PrepareStreamRequest['addressVersion'];
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
  streamStarted?: boolean;
  intentionalTermination?: boolean;
};

export type FrameWriteState = {
  blocked: boolean;
};

export class MapCameraDelegate implements CameraStreamingDelegate {
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly frameCache = new Map<string, { buffer: Buffer; timestamp: number }>();
  private readonly killFallbacks = new Map<ChildProcessWithoutNullStreams, NodeJS.Timeout>();

  public constructor(
    private readonly tracker: PersonTracker,
    private readonly renderer: MapRenderer,
    ffmpegPath: string,
    private readonly logger: Logger,
    private readonly processSpawner: ProcessSpawner = spawn,
    private readonly streamTerminationHandler: StreamTerminationHandler = () => undefined,
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
    void allocateUdpPort(request.addressVersion).then((localVideoPort) => {
      const session: SessionInfo = {
        address: request.targetAddress,
        addressVersion: request.addressVersion,
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
      buildSrtpOutputUrl(session.address, session.addressVersion, session.videoPort, session.localVideoPort, request.video.mtu),
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
    let terminationHandled = false;
    ffmpegProcess.on('error', (error) => {
      if (terminationHandled) {
        return;
      }
      terminationHandled = true;
      this.cleanupSession(request.sessionID, session, ffmpegProcess);
      if (!session.streamStarted) {
        if (callbackFinished) {
          return;
        }
        this.logger.error(`Unable to start ffmpeg: ${error.message}`);
        finishStart(error);
        return;
      }
      this.logger.warn(`ffmpeg process error: ${error.message}`);
      if (!session.intentionalTermination) {
        this.notifyUnexpectedTermination(request.sessionID);
      }
      this.terminateProcess(ffmpegProcess);
    });
    ffmpegProcess.once('exit', (code, signal) => {
      this.clearKillFallback(ffmpegProcess);
      if (terminationHandled) {
        return;
      }
      terminationHandled = true;
      this.cleanupSession(request.sessionID, session, ffmpegProcess);
      if (code !== null && code !== 0) {
        this.logger.warn(`ffmpeg exited with code ${code}`);
      } else if (signal) {
        this.logger.info(`Map stream stopped by signal ${signal}`);
      } else {
        this.logger.info('Map stream exited');
      }
      if (!session.streamStarted) {
        finishStart(new Error(`ffmpeg exited before stream started${code !== null ? ` with code ${code}` : ''}`));
      } else if (!session.intentionalTermination) {
        this.notifyUnexpectedTermination(request.sessionID);
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
        this.terminateProcess(ffmpegProcess);
        finishStart(new Error(`Stream session stopped before ffmpeg started: ${request.sessionID}`));
        return;
      }
      writeFrame();
      session.frameTimer = setInterval(writeFrame, frameIntervalMs(fps));
      session.streamStarted = true;
      finishStart();
    });
  }

  private stopStream(request: StopStreamRequest, callback: StreamRequestCallback): void {
    const session = this.sessions.get(request.sessionID);
    this.logger.info(`Stopping map stream for session ${request.sessionID}`);
    if (session) {
      session.intentionalTermination = true;
      const ffmpegProcess = session.process;
      const finishStart = session.finishStart;
      this.cleanupSession(request.sessionID, session, ffmpegProcess);
      finishStart?.(new Error(`Stream stopped before ffmpeg started: ${request.sessionID}`));
      if (ffmpegProcess) {
        this.terminateProcess(ffmpegProcess);
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

  private notifyUnexpectedTermination(sessionID: string): void {
    try {
      this.streamTerminationHandler(sessionID);
    } catch (error: unknown) {
      this.logger.error(`Unable to release failed HomeKit stream ${sessionID}: ${toError(error).message}`);
    }
  }

  private terminateProcess(ffmpegProcess: ChildProcessWithoutNullStreams): void {
    if (!ffmpegProcess.stdin.destroyed && !ffmpegProcess.stdin.writableEnded) {
      try {
        ffmpegProcess.stdin.end();
      } catch (error: unknown) {
        this.logger.warn(`Unable to close ffmpeg stdin: ${toError(error).message}`);
      }
    }
    if (
      this.killFallbacks.has(ffmpegProcess)
      || ffmpegProcess.exitCode !== null
      || ffmpegProcess.signalCode !== null
    ) {
      return;
    }

    let signalSent = false;
    try {
      signalSent = ffmpegProcess.kill('SIGTERM');
    } catch (error: unknown) {
      this.logger.warn(`Unable to stop ffmpeg: ${toError(error).message}`);
      return;
    }
    if (!signalSent) {
      this.logger.warn('Unable to stop ffmpeg: SIGTERM was not accepted');
      return;
    }
    if (ffmpegProcess.exitCode !== null || ffmpegProcess.signalCode !== null) {
      return;
    }

    const fallback = setTimeout(() => {
      this.killFallbacks.delete(ffmpegProcess);
      if (ffmpegProcess.exitCode !== null || ffmpegProcess.signalCode !== null) {
        return;
      }
      try {
        if (!ffmpegProcess.kill('SIGKILL')) {
          this.logger.warn('Unable to stop ffmpeg: SIGKILL was not accepted');
        }
      } catch (error: unknown) {
        this.logger.warn(`Unable to force-stop ffmpeg: ${toError(error).message}`);
      }
    }, FFMPEG_TERMINATION_GRACE_MS);
    fallback.unref();
    this.killFallbacks.set(ffmpegProcess, fallback);
  }

  private clearKillFallback(ffmpegProcess: ChildProcessWithoutNullStreams): void {
    const fallback = this.killFallbacks.get(ffmpegProcess);
    if (fallback) {
      clearTimeout(fallback);
      this.killFallbacks.delete(ffmpegProcess);
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

async function allocateUdpPort(addressVersion: PrepareStreamRequest['addressVersion']): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(udpSocketTypeForAddressVersion(addressVersion));
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

export function udpSocketTypeForAddressVersion(addressVersion: PrepareStreamRequest['addressVersion']): 'udp4' | 'udp6' {
  return addressVersion === 'ipv6' ? 'udp6' : 'udp4';
}

export function buildSrtpOutputUrl(
  address: string,
  addressVersion: PrepareStreamRequest['addressVersion'],
  videoPort: number,
  localRtcpPort: number,
  mtu: number,
): string {
  const host = addressVersion === 'ipv6' && !(address.startsWith('[') && address.endsWith(']'))
    ? `[${address}]`
    : address;
  return `srtp://${host}:${videoPort}?rtcpport=${videoPort}&localrtcpport=${localRtcpPort}&pkt_size=${mtu}`;
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

export function frameIntervalMs(fps: number): number {
  return Math.floor(1000 / fps);
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
