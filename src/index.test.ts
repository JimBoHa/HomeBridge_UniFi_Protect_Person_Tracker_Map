import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { APIEvent } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';
import {
  type PlatformDependencies,
  UniFiProtectPersonTrackerPlatform,
} from './index.js';
import type { MapConfig } from './types.js';

const map: MapConfig = {
  width: 200,
  height: 100,
  cameras: [{ id: 'front', name: 'Front', position: { x: 20, y: 20 } }],
};

const config = {
  platform: 'UniFiProtectPersonTrackerMap',
  name: 'Person Tracker Map',
  adminToken: 'secure-token-secure-token-1234',
  mapConfig: map,
} as PlatformConfig;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createLogger(): Logging {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logging;
}

function createAccessory(configureController = vi.fn()): PlatformAccessory {
  const informationService = { setCharacteristic: vi.fn() };
  informationService.setCharacteristic.mockReturnValue(informationService);
  return {
    context: {},
    updateDisplayName: vi.fn(),
    getService: vi.fn()
      .mockReturnValueOnce(informationService)
      .mockReturnValue(undefined),
    addService: vi.fn(),
    removeService: vi.fn(),
    configureController,
  } as unknown as PlatformAccessory;
}

function createApi(): {
  api: API;
  emit(event: APIEvent): void;
} {
  const listeners = new Map<APIEvent, () => void>();
  class CameraController {}
  const api = {
    on: vi.fn((event: APIEvent, listener: () => void) => {
      listeners.set(event, listener);
    }),
    hap: {
      Service: { AccessoryInformation: Symbol('AccessoryInformation') },
      Characteristic: {
        Manufacturer: Symbol('Manufacturer'),
        Model: Symbol('Model'),
        SerialNumber: Symbol('SerialNumber'),
      },
      CameraController,
    },
    registerPlatformAccessories: vi.fn(),
    updatePlatformAccessories: vi.fn(),
  } as unknown as API;
  return {
    api,
    emit: (event) => listeners.get(event)?.(),
  };
}

function getLaunchPromise(platform: UniFiProtectPersonTrackerPlatform): Promise<void> {
  return Reflect.get(platform, 'launchPromise') as Promise<void>;
}

describe('UniFiProtectPersonTrackerPlatform lifecycle', () => {
  it('cancels and cleans a server still binding when shutdown begins', async () => {
    const bind = deferred<number>();
    const httpServer = {
      start: vi.fn(() => bind.promise),
      stop: vi.fn(async () => undefined),
    };
    const protectAdapter = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    const dependencies: PlatformDependencies = {
      loadMapConfig: vi.fn(async () => map),
      createHttpServer: vi.fn(() => httpServer),
      createProtectAdapter: vi.fn(() => protectAdapter),
    };
    const { api, emit } = createApi();
    const platform = new UniFiProtectPersonTrackerPlatform(createLogger(), config, api, dependencies);
    platform.configureAccessory(createAccessory());

    emit(APIEvent.DID_FINISH_LAUNCHING);
    await vi.waitFor(() => expect(httpServer.start).toHaveBeenCalledOnce());
    emit(APIEvent.SHUTDOWN);
    bind.resolve(4321);

    await expect(getLaunchPromise(platform)).resolves.toBeUndefined();
    expect(httpServer.stop).toHaveBeenCalledOnce();
    expect(dependencies.createProtectAdapter).not.toHaveBeenCalled();
  });

  it('closes a bound server when accessory setup fails', async () => {
    const httpServer = {
      start: vi.fn(async () => 4321),
      stop: vi.fn(async () => undefined),
    };
    const protectAdapter = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    const dependencies: PlatformDependencies = {
      loadMapConfig: vi.fn(async () => map),
      createHttpServer: vi.fn(() => httpServer),
      createProtectAdapter: vi.fn(() => protectAdapter),
    };
    const { api, emit } = createApi();
    const configureController = vi.fn(() => {
      throw new Error('controller setup failed');
    });
    const accessory = createAccessory(configureController);
    const platform = new UniFiProtectPersonTrackerPlatform(createLogger(), config, api, dependencies);
    platform.configureAccessory(accessory);

    emit(APIEvent.DID_FINISH_LAUNCHING);

    await expect(getLaunchPromise(platform)).rejects.toThrow('controller setup failed');
    expect(httpServer.stop).toHaveBeenCalledOnce();
    expect(protectAdapter.start).toHaveBeenCalledOnce();
    expect(protectAdapter.stop).toHaveBeenCalledOnce();
    expect(api.updatePlatformAccessories).not.toHaveBeenCalled();
  });

  it('stops a partially started adapter when its startup fails', async () => {
    const httpServer = {
      start: vi.fn(async () => 4321),
      stop: vi.fn(async () => undefined),
    };
    const protectAdapter = {
      start: vi.fn(() => {
        throw new Error('adapter startup failed');
      }),
      stop: vi.fn(),
    };
    const dependencies: PlatformDependencies = {
      loadMapConfig: vi.fn(async () => map),
      createHttpServer: vi.fn(() => httpServer),
      createProtectAdapter: vi.fn(() => protectAdapter),
    };
    const { api, emit } = createApi();
    const accessory = createAccessory();
    const platform = new UniFiProtectPersonTrackerPlatform(createLogger(), config, api, dependencies);
    platform.configureAccessory(accessory);

    emit(APIEvent.DID_FINISH_LAUNCHING);

    await expect(getLaunchPromise(platform)).rejects.toThrow('adapter startup failed');
    expect(protectAdapter.stop).toHaveBeenCalledOnce();
    expect(httpServer.stop).toHaveBeenCalledOnce();
    expect(accessory.configureController).not.toHaveBeenCalled();
    expect(api.updatePlatformAccessories).not.toHaveBeenCalled();
  });
});
