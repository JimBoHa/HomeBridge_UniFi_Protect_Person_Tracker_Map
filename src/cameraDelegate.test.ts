import { EventEmitter } from 'node:events';
import { PassThrough, type Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  PrepareStreamRequest,
  StartStreamRequest,
  StopStreamRequest,
  StreamRequestCallback,
} from 'homebridge';
import { SRTPCryptoSuites, StreamRequestTypes } from 'homebridge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapCameraDelegate, type ProcessSpawner, writeFrameWithBackpressure } from './cameraDelegate.js';
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
  public readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function createHarness(spawnImplementation?: ProcessSpawner): {
  delegate: MapCameraDelegate;
  logger: Logger;
  renderRawRgba: ReturnType<typeof vi.fn>;
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

  return {
    delegate: new MapCameraDelegate(
      new PersonTracker(map, 60_000),
      renderer,
      '/test/ffmpeg',
      logger,
      processSpawner,
    ),
    logger,
    renderRawRgba,
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

describe('MapCameraDelegate ffmpeg lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports an asynchronous spawn error through the START callback', async () => {
    const child = new FakeProcess();
    const spawner = vi.fn<ProcessSpawner>(() => child as unknown as ChildProcessWithoutNullStreams);
    const { delegate, logger, renderRawRgba } = createHarness(spawner);
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

    const retry = vi.fn<StreamRequestCallback>();
    delegate.handleStreamRequest(startRequest(), retry);
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ message: 'Unknown stream session: session-1' }));
    expect(spawner).toHaveBeenCalledOnce();
  });

  it('acknowledges START on spawn and cleans up an early nonzero exit once', async () => {
    const child = new FakeProcess();
    const spawner = vi.fn<ProcessSpawner>(() => child as unknown as ChildProcessWithoutNullStreams);
    const { delegate, logger } = createHarness(spawner);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    await prepareStream(delegate);
    const callback = vi.fn<StreamRequestCallback>();

    delegate.handleStreamRequest(startRequest(), callback);
    expect(callback).not.toHaveBeenCalled();

    child.emit('spawn');
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith();

    child.emit('exit', 1, null);
    expect(callback).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith('ffmpeg exited with code 1');

    const retry = vi.fn<StreamRequestCallback>();
    delegate.handleStreamRequest(startRequest(), retry);
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ message: 'Unknown stream session: session-1' }));
  });

  it('settles a pending START and kills ffmpeg when STOP wins the race', async () => {
    const child = new FakeProcess();
    const spawner = vi.fn<ProcessSpawner>(() => child as unknown as ChildProcessWithoutNullStreams);
    const { delegate } = createHarness(spawner);
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

    child.emit('spawn');
    child.emit('exit', null, 'SIGTERM');
    expect(startCallback).toHaveBeenCalledOnce();
  });

  it('reports a synchronous spawner failure through the START callback', async () => {
    const spawnError = new Error('invalid ffmpeg command');
    const spawner = vi.fn<ProcessSpawner>(() => {
      throw spawnError;
    });
    const { delegate } = createHarness(spawner);
    await prepareStream(delegate);
    const callback = vi.fn<StreamRequestCallback>();

    expect(() => delegate.handleStreamRequest(startRequest(), callback)).not.toThrow();
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(spawnError);
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
