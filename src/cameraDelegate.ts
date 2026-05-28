import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createSocket } from 'node:dgram';
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
};

export class MapCameraDelegate implements CameraStreamingDelegate {
  private readonly sessions = new Map<string, SessionInfo>();

  public constructor(
    private readonly tracker: PersonTracker,
    private readonly renderer: MapRenderer,
    private readonly ffmpegPath: string,
    private readonly logger: Logger,
  ) {}

  public handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    void this.renderer.renderJpeg(this.tracker.snapshot(), request.width, request.height)
      .then((buffer) => callback(undefined, buffer))
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
    const fps = request.video.fps || 10;
    const width = request.video.width || 1280;
    const height = request.video.height || 720;
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-f', 'mjpeg',
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
    session.process = spawn(this.ffmpegPath, args);
    session.process.stdin.on('error', (error) => this.logger.debug(`ffmpeg stdin: ${error.message}`));
    session.process.stderr.on('data', (data: Buffer) => this.logger.warn(`ffmpeg: ${data.toString('utf8').trim()}`));
    session.process.on('exit', (code) => {
      if (session.frameTimer) {
        clearInterval(session.frameTimer);
        session.frameTimer = undefined;
      }
      if (code && code !== 0) {
        this.logger.warn(`ffmpeg exited with code ${code}`);
      } else {
        this.logger.info('Map stream stopped');
      }
    });
    const refreshFrame = (): void => {
      if (session.frameRender) {
        return;
      }

      session.frameRender = this.renderer.renderJpeg(this.tracker.snapshot(), width, height)
        .then((buffer) => {
          session.cachedFrame = buffer;
          session.frameRenderedAt = Date.now();
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
      if (session.cachedFrame && session.process?.stdin.writable) {
        session.process.stdin.write(session.cachedFrame);
      }
    };
    writeFrame();
    session.frameTimer = setInterval(writeFrame, Math.max(250, Math.floor(1000 / fps)));
    callback();
  }

  private stopStream(request: StopStreamRequest, callback: StreamRequestCallback): void {
    const session = this.sessions.get(request.sessionID);
    if (session?.process) {
      if (session.frameTimer) {
        clearInterval(session.frameTimer);
      }
      session.process.kill('SIGTERM');
    }
    this.sessions.delete(request.sessionID);
    callback();
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
  return Math.floor(Math.random() * 0xffffffff);
}
