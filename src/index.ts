import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { APIEvent, H264Level, H264Profile, SRTPCryptoSuites } from 'homebridge';
import { MapCameraDelegate } from './cameraDelegate.js';
import { loadMapConfig, resolvePluginConfig } from './config.js';
import { TrackerHttpServer } from './httpServer.js';
import { MotionSensorController } from './motionSensor.js';
import { UniFiProtectAdapter } from './protectAdapter.js';
import { MapRenderer } from './renderer.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { PersonTracker } from './tracker.js';
import type { Logger, MapConfig, PluginConfig, ProtectConfig, ProtectPersonEvent } from './types.js';

type HttpServerLifecycle = Pick<TrackerHttpServer, 'start' | 'stop'>;
type ProtectAdapterLifecycle = Pick<UniFiProtectAdapter, 'start' | 'stop'>;

export type PlatformDependencies = {
  loadMapConfig(configPath?: string, inlineConfig?: MapConfig): Promise<MapConfig>;
  createHttpServer(tracker: PersonTracker, renderer: MapRenderer, adminToken: string, logger: Logger): HttpServerLifecycle;
  createProtectAdapter(
    config: ProtectConfig | undefined,
    sink: (event: ProtectPersonEvent) => void,
    logger: Logger,
    initialLookbackMs: number,
  ): ProtectAdapterLifecycle;
};

const defaultDependencies: PlatformDependencies = {
  loadMapConfig,
  createHttpServer: (tracker, renderer, adminToken, logger) => new TrackerHttpServer(tracker, renderer, adminToken, logger),
  createProtectAdapter: (config, sink, logger, initialLookbackMs) => new UniFiProtectAdapter(
    config,
    sink,
    logger,
    undefined,
    initialLookbackMs,
  ),
};

export default function initializer(api: API): void {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, UniFiProtectPersonTrackerPlatform);
}

export class UniFiProtectPersonTrackerPlatform implements DynamicPlatformPlugin {
  private accessory?: PlatformAccessory;
  private httpServer?: HttpServerLifecycle;
  private protectAdapter?: ProtectAdapterLifecycle;
  private launchPromise?: Promise<void>;
  private shutdownRequested = false;
  private motionSensor?: MotionSensorController;

  public constructor(
    private readonly log: Logging,
    private readonly rawConfig: PlatformConfig,
    private readonly api: API,
    private readonly dependencies: PlatformDependencies = defaultDependencies,
  ) {
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.startLaunch();
    });
    this.api.on(APIEvent.SHUTDOWN, () => {
      void this.shutdown().catch((error: unknown) => {
        this.log.warn(`Person tracker map shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  public configureAccessory(accessory: PlatformAccessory): void {
    this.accessory = accessory;
  }

  private startLaunch(): void {
    if (this.launchPromise) {
      return;
    }
    this.launchPromise = this.launch();
    void this.launchPromise.catch((error: unknown) => {
      this.log.error(`Person tracker map failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async launch(): Promise<void> {
    let httpServer: HttpServerLifecycle | undefined;
    let protectAdapter: ProtectAdapterLifecycle | undefined;
    let started = false;
    try {
      const config = resolvePluginConfig(this.rawConfig as PluginConfig);
      const map = await this.dependencies.loadMapConfig(config.mapConfigPath, config.mapConfig);
      if (this.shutdownRequested) {
        return;
      }

      const tracker = new PersonTracker(map, config.peopleTtlSeconds * 1000, Date.now, config.trailPoints);
      const renderer = new MapRenderer({ path: config.mapImagePath, dataUrl: config.mapImageData });
      httpServer = this.dependencies.createHttpServer(tracker, renderer, config.adminToken, this.log);
      const actualPort = await httpServer.start(config.bindHost, config.port);
      if (this.shutdownRequested) {
        return;
      }

      protectAdapter = this.dependencies.createProtectAdapter(config.protect, (event) => {
        try {
          tracker.ingest(event);
        } catch (error) {
          this.log.warn(`Protect event ignored: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, this.log, config.peopleTtlSeconds * 1000);
      protectAdapter.start();
      if (this.shutdownRequested) {
        return;
      }

      const snapshotUrl = `http://${config.bindHost}:${actualPort}/snapshot.png`;
      const { accessory, isNew } = this.getOrCreateAccessory(config.name);
      accessory.getService(this.api.hap.Service.AccessoryInformation)
        ?.setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'JimBoHa')
        .setCharacteristic(this.api.hap.Characteristic.Model, 'UniFi Protect Person Tracker Map')
        .setCharacteristic(this.api.hap.Characteristic.SerialNumber, 'person-tracker-map');

      const delegate = new MapCameraDelegate(tracker, renderer, config.ffmpegPath, this.log);
      const motionService = this.configureMotionSensor(accessory, tracker, config.motionSensor, config.motionResetSeconds);
      accessory.configureController(new this.api.hap.CameraController({
        cameraStreamCount: 2,
        delegate,
        sensors: motionService ? { motion: motionService } : undefined,
        streamingOptions: {
          supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
          video: {
            codec: {
              profiles: [H264Profile.BASELINE],
              levels: [H264Level.LEVEL3_1],
            },
            resolutions: [
              [320, 180, 10],
              [640, 360, 10],
              [1280, 720, 10],
            ],
          },
        },
      }));
      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }

      this.log.info(`Map snapshot available at ${snapshotUrl}`);
      this.log.info('Use Bearer admin token for /events, /state, and /map-config write/read endpoints.');
      this.httpServer = httpServer;
      this.protectAdapter = protectAdapter;
      started = true;
    } finally {
      if (!started) {
        await this.cleanupPartialResources(protectAdapter, httpServer);
      }
    }
  }

  private configureMotionSensor(
    accessory: PlatformAccessory,
    tracker: PersonTracker,
    enabled: boolean,
    resetSeconds: number,
  ): Service | undefined {
    const { Service, Characteristic } = this.api.hap;
    const existing = accessory.getService(Service.MotionSensor);
    if (!enabled) {
      if (existing) {
        accessory.removeService(existing);
      }
      return undefined;
    }

    const service = existing ?? accessory.addService(Service.MotionSensor, 'Person Detected');
    service.updateCharacteristic(Characteristic.MotionDetected, false);
    this.motionSensor = new MotionSensorController(resetSeconds * 1000, (detected) => {
      service.updateCharacteristic(Characteristic.MotionDetected, detected);
    });
    tracker.onPersonSeen((person) => {
      this.motionSensor?.personSeen(person);
    });
    return service;
  }

  private getOrCreateAccessory(name: string): { accessory: PlatformAccessory; isNew: boolean } {
    if (this.accessory) {
      this.accessory.updateDisplayName(name);
      return { accessory: this.accessory, isNew: false };
    }

    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${name}`);
    const accessory = new this.api.platformAccessory(name, uuid, this.api.hap.Categories.CAMERA);
    accessory.context.device = 'person-tracker-map';
    this.accessory = accessory;
    return { accessory, isNew: true };
  }

  private async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    try {
      await this.launchPromise;
    } catch {
      // Startup failures are logged by startLaunch; shutdown still cleans committed resources.
    }

    const protectAdapter = this.protectAdapter;
    const httpServer = this.httpServer;
    this.protectAdapter = undefined;
    this.httpServer = undefined;
    this.motionSensor?.stop();
    this.motionSensor = undefined;

    let shutdownError: unknown;
    try {
      await protectAdapter?.stop();
    } catch (error) {
      shutdownError = error;
    }
    try {
      await httpServer?.stop();
    } catch (error) {
      shutdownError ??= error;
    }
    if (shutdownError) {
      throw shutdownError;
    }
  }

  private async cleanupPartialResources(
    protectAdapter: ProtectAdapterLifecycle | undefined,
    httpServer: HttpServerLifecycle | undefined,
  ): Promise<void> {
    this.motionSensor?.stop();
    this.motionSensor = undefined;
    try {
      await protectAdapter?.stop();
    } catch (error) {
      this.log.warn(`Protect adapter cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await httpServer?.stop();
    } catch (error) {
      this.log.warn(`Tracker HTTP server cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
