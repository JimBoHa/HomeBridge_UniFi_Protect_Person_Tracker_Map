import { EventEmitter } from 'node:events';
import { PassThrough, type Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  PrepareStreamRequest,
  ReconfigureStreamRequest,
  StartStreamRequest,
  StopStreamRequest,
  StreamRequestCallback,
} from 'homebridge';
import { SRTPCryptoSuites, StreamRequestTypes } from 'homebridge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSrtpOutputUrl,
  FFMPEG_TERMINATION_GRACE_MS,
  MapCameraDelegate,
  type ProcessSpawner,
  udpSocketTypeForAddressVersion,
  writeFrameWithBackpressure,
} from './cameraDelegate.js';
import type { MapRenderer } from './renderer.js';
import { PersonTracker } from './tracker.js';
import type { Logger, MapConfig } from './types.js';

const map: MapConfig = {
  width: 2,
  height: 2,
  cameras: [],
};

class FakeProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public killed = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  public readonly kill = vi.fn((signal?: NodeJS.Signals | number) => {
    this.killed = true;
    this.signals.push(signal);
    return true;
  });

  public emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function createHarness(spawnImplementation?: ProcessSpawner): {
  delegate: MapCameraDelegate;
  logger: Logger;
  renderRawRgba: ReturnType<typeof vi.fn>;
  streamTerminationHandler: ReturnType<typeof vi.fn>;
} {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies Logger;
  const renderRawRgba = vi.fn().mockResolvedValue(Buffer.alloc(16));
  const renderer = {
    renderRawRgba,
    renderJpeg: vi.fn().mockResolvedValue(Buffer.from('jpeg')),
  } as unknown as MapRenderer;
  const processSpawner = spawnImplementation ?? (() => {
    throw new Error('Test must provide a process spawner');
  });
  const streamTerminationHandler = vi.fn<(sessionID: string) => void>();

  return {
    delegate: new MapCameraDelegate(
      new PersonTracker(map, 60_000),
      renderer,
      '/test/ffmpeg',
      logger,
      processSpawner,
      streamTerminationHandler,
    ),
    logger,
    renderRawRgba,
    streamTerminationHandler,
  };
}

async function prepareStream(delegate: MapCameraDelegate, sessionID = 'session-1'): Promise<void> {
  const source = {
    port: 50_000,
    srtpCryptoSuite: SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80,
    srtp_key: Buffer.alloc(16),
    srtp_salt: Buffer.alloc(14),
  };
  const request: PrepareStreamRequest = {
    sessionID,
    sourceAddress: '127.0.0.1',
    targetAddress: '127.0.0.1',
    addressVersion: 'ipv4',
    audio: source,
    video: source,
  };

  await new Promise<void>((resolve, reject) => {
    delegate.prepareStream(request, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function startRequest(sessionID = 'session-1'): StartStreamRequest {
  return {
    sessionID,
    type: StreamRequestTypes.START,
    video: {
      width: 2,
      height: 2,
      fps: 10,
      pt: 99,
      max_bit_rate: 300,
      mtu: 1_378,
    },
    audio: {},
  } as unknown as StartStreamRequest;
}

function stopRequest(sessionID = 'session-1'): StopStreamRequest {
  return { sessionID, type: StreamRequestTypes.STOP };
}

function reconfigureRequest(sessionID = 'session-1'): ReconfigureStreamRequest {
  return {
    sessionID,
    type: StreamRequestTypes.RECONFIGURE,
    video: {
      width: 2,
      height: 2,
      fps: 5,
      max_bit_rate: 200,
      rtcp_interval: 0.5,
    },
  };
}

describe('MapCameraDelegate ffmpeg lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports an asynchronous spawn error through the START callback', async () => {
    const child = new FakeProcess();
    const spawner = vi.fn<ProcessSpawner>(() => child as unknown as ChildProcessWithoutNullStreams);
    const { delegate, logger, renderRawRgba, streamTerminationHandler } = createHarness(spawner);
    await prepareStream(delegate);
    const callback = vi.fn<StreamRequestCallback>();

    delegate.handleStreamRequest(startRequest(), callback);
    expect(callback).not.toHaveBeenCalled();
    expect(child.listenerCount('error')).toBe(1);

    const spawnError = Object.assign(new Error('spawn /test/ffmpeg ENOENT'), { code: 'ENOENT' });
    child.emit('error', spawnError);
    child.emit('exit', 127, null);
    expect(() => child.emit('error', new Error('later child error'))).not.toThrow();

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(spawnError);
    expect(renderRawRgba).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('Unable to start ffmpeg: spawn /test/ffmpeg ENOENT');
    expect(streamTerminationHandler).not.toHaveBeenCalled();

    const retry = vi.fn<StreamRequestCallback>();
    delegate.handleStreamRequest(startRequest(), retry);
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ message: 'Unknown stream session: session-1' }));
    expect(spawner).toHaveBeenCalledOnce();
  });

  it('acknowledges START on spawn and cleans up an early nonzero exit once', async () => {
    const child = new FakeProcess();
    const spawner = vi.fn<ProcessSpawner>(() => child as unknown as ChildProcessWithoutNullStreams);
    const { delegate, logger, streamTerminationHandler } = createHarness(spawner);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    await prepareStream(delegate);
    const callback = vi.fn<StreamRequestCallback>();

    delegate.handleStreamRequest(startRequest(), callback);
    expect(callback).not.toHaveBeenCalled();

    child.emit('spawn');
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith();

    child.emitExit(1, null);
    expect(callback).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith('ffmpeg exited with code 1');
    expect(streamTerminationHandler).toHaveBeenCalledOnce();
    expect(streamTerminationHandler).toHaveBeenCalledWith('session-1');

    const retry = vi.fn<StreamRequestCallback>();
    delegate.handleStreamRequest(startRequest(), retry);
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ message: 'Unknown stream session: session-1' }));
  });

  it('settles a pending START and kills ffmpeg when STOP wins the race', async () => {
    const child = new FakeProcess();
    const spawner = vi.fn<ProcessSpawner>(() => child as unknown as ChildProcessWithoutNullStreams);
    const { delegate, streamTerminationHandler } = createHarness(spawner);
    await prepareStream(delegate);
    const startCallback = vi.fn<StreamRequestCallback>();
    const stopCallback = vi.fn<StreamRequestCallback>();

    delegate.handleStreamRequest(startRequest(), startCallback);
    delegate.handleStreamRequest(stopRequest(), stopCallback);

    expect(startCallback).toHaveBeenCalledOnce();
    expect(startCallback).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Stream stopped before ffmpeg started: session-1',
    }));
    expect(stopCallback).toHaveBeenCalledWith();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.stdin.writableEnded).toBe(true);

    child.emit('spawn');
    child.emitExit(null, 'SIGTERM');
    expect(startCallback).toHaveBeenCalledOnce();
    expect(streamTerminationHandler).not.toHaveBeenCalled();
  });

  it('reports a synchronous spawner failure through the START callback', async () => {
    const spawnError = new Error('invalid ffmpeg command');
    const spawner = vi.fn<ProcessSpawner>(() => {
      throw spawnError;
    });
    const { delegate, streamTerminationHandler } = createHarness(spawner);
    await prepareStream(delegate);
    const callback = vi.fn<StreamRequestCallback>();

    expect(() => delegate.handleStreamRequest(startRequest(), callback)).not.toThrow();
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(spawnError);
    expect(streamTerminationHandler).not.toHaveBeenCalled();
  });

  it('releases the HomeKit stream once after a post-START process error', async () => {
    vi.useFakeTimers();
    const child = new FakeProcess();
    const spawner = vi.fn<ProcessSpawner>(() => child as unknown as ChildProcessWithoutNullStreams);
    const { delegate, streamTerminationHandler } = createHarness(spawner);
    await prepareStream(delegate);
    const callback = vi.fn<StreamRequestCallback>();

    delegate.handleStreamRequest(startRequest(), callback);
    child.emit('spawn');
    child.emit('error', new Error('encoder failed'));

    expect(callback).toHaveBeenCalledOnce();
    expect(streamTerminationHandler).toHaveBeenCalledOnce();
    expect(streamTerminationHandler).toHaveBeenCalledWith('session-1');
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emitExit(1, null);
    vi.advanceTimersByTime(FFMPEG_TERMINATION_GRACE_MS);
    expect(streamTerminationHandler).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('escalates an ignored SIGTERM and never releases an intentionally stopped stream', async () => {
    vi.useFakeTimers();
    const child = new FakeProcess();
    const spawner = vi.fn<ProcessSpawner>(() => child as unknown as ChildProcessWithoutNullStreams);
    const { delegate, streamTerminationHandler } = createHarness(spawner);
    await prepareStream(delegate);

    delegate.handleStreamRequest(startRequest(), vi.fn());
    child.emit('spawn');
    delegate.handleStreamRequest(stopRequest(), vi.fn());

    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(streamTerminationHandler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(FFMPEG_TERMINATION_GRACE_MS - 1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(streamTerminationHandler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the force-kill fallback when ffmpeg exits after STOP', async () => {
    vi.useFakeTimers();
    const child = new FakeProcess();
    const spawner = vi.fn<ProcessSpawner>(() => child as unknown as ChildProcessWithoutNullStreams);
    const { delegate, streamTerminationHandler } = createHarness(spawner);
    await prepareStream(delegate);

    delegate.handleStreamRequest(startRequest(), vi.fn());
    child.emit('spawn');
    delegate.handleStreamRequest(stopRequest(), vi.fn());
    expect(vi.getTimerCount()).toBe(1);

    child.emitExit(null, 'SIGTERM');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(FFMPEG_TERMINATION_GRACE_MS);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(streamTerminationHandler).not.toHaveBeenCalled();
  });

  it('does not release or terminate a stream when HomeKit reconfigures it', async () => {
    const child = new FakeProcess();
    const spawner = vi.fn<ProcessSpawner>(() => child as unknown as ChildProcessWithoutNullStreams);
    const { delegate, streamTerminationHandler } = createHarness(spawner);
    await prepareStream(delegate);
    const callback = vi.fn<StreamRequestCallback>();

    delegate.handleStreamRequest(startRequest(), vi.fn());
    child.emit('spawn');
    delegate.handleStreamRequest(reconfigureRequest(), callback);

    expect(callback).toHaveBeenCalledWith();
    expect(child.kill).not.toHaveBeenCalled();
    expect(streamTerminationHandler).not.toHaveBeenCalled();

    delegate.handleStreamRequest(stopRequest(), vi.fn());
    child.emitExit(null, 'SIGTERM');
    expect(streamTerminationHandler).not.toHaveBeenCalled();
  });
});

describe('writeFrameWithBackpressure', () => {
  it('keeps only one frame in flight until stdin drains', () => {
    let onDrain: (() => void) | undefined;
    const write = vi.fn(() => false);
    const stdin = {
      writable: true,
      write,
      once: vi.fn((event: string, listener: () => void) => {
        if (event === 'drain') {
          onDrain = listener;
        }
        return stdin;
      }),
    } as unknown as Writable;
    const state = { blocked: false };
    const frame = Buffer.alloc(16);

    writeFrameWithBackpressure(stdin, frame, state);
    writeFrameWithBackpressure(stdin, frame, state);

    expect(write).toHaveBeenCalledTimes(1);
    expect(state.blocked).toBe(true);

    onDrain?.();
    write.mockReturnValue(true);
    writeFrameWithBackpressure(stdin, frame, state);

    expect(write).toHaveBeenCalledTimes(2);
    expect(state.blocked).toBe(false);
  });
});

describe('buildSrtpOutputUrl', () => {
  it('binds RTCP to the port advertised to HomeKit', () => {
    expect(buildSrtpOutputUrl('10.0.0.12', 'ipv4', 50_000, 41_234, 1_376)).toBe(
      'srtp://10.0.0.12:50000?rtcpport=50000&localrtcpport=41234&pkt_size=1376',
    );
  });

  it('brackets an IPv6 destination while retaining the local RTCP port', () => {
    expect(buildSrtpOutputUrl('fd00::12', 'ipv6', 50_000, 41_234, 1_376)).toBe(
      'srtp://[fd00::12]:50000?rtcpport=50000&localrtcpport=41234&pkt_size=1376',
    );
  });

  it('does not double-bracket a normalized IPv6 destination', () => {
    expect(buildSrtpOutputUrl('[fd00::12]', 'ipv6', 50_000, 41_234, 1_376)).toBe(
      'srtp://[fd00::12]:50000?rtcpport=50000&localrtcpport=41234&pkt_size=1376',
    );
  });
});

describe('udpSocketTypeForAddressVersion', () => {
  it.each([
    ['ipv4', 'udp4'],
    ['ipv6', 'udp6'],
  ] as const)('maps %s sessions to %s sockets', (addressVersion, socketType) => {
    expect(udpSocketTypeForAddressVersion(addressVersion)).toBe(socketType);
  });
});
