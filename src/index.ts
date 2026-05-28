import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { APIEvent, H264Level, H264Profile, SRTPCryptoSuites } from 'homebridge';
import { MapCameraDelegate } from './cameraDelegate.js';
import { loadMapConfig, resolvePluginConfig } from './config.js';
import { TrackerHttpServer } from './httpServer.js';
import { UniFiProtectAdapter } from './protectAdapter.js';
import { MapRenderer } from './renderer.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { PersonTracker } from './tracker.js';
import type { PluginConfig } from './types.js';

export default function initializer(api: API): void {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, UniFiProtectPersonTrackerPlatform);
}

class UniFiProtectPersonTrackerPlatform implements DynamicPlatformPlugin {
  private accessory?: PlatformAccessory;
  private httpServer?: TrackerHttpServer;
  private protectAdapter?: UniFiProtectAdapter;

  public constructor(
    private readonly log: Logging,
    private readonly rawConfig: PlatformConfig,
    private readonly api: API,
  ) {
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      void this.launch();
    });
    this.api.on(APIEvent.SHUTDOWN, () => {
      void this.shutdown();
    });
  }

  public configureAccessory(accessory: PlatformAccessory): void {
    this.accessory = accessory;
  }

  private async launch(): Promise<void> {
    const config = resolvePluginConfig(this.rawConfig as PluginConfig);
    const map = await loadMapConfig(config.mapConfigPath, config.mapConfig);
    const tracker = new PersonTracker(map, config.peopleTtlSeconds * 1000);
    const renderer = new MapRenderer({ path: config.mapImagePath, dataUrl: config.mapImageData });
    const httpServer = new TrackerHttpServer(tracker, renderer, config.adminToken, this.log);
    const actualPort = await httpServer.start(config.bindHost, config.port);
    this.httpServer = httpServer;

    const snapshotUrl = `http://${config.bindHost}:${actualPort}/snapshot.png`;
    const { accessory, isNew } = this.getOrCreateAccessory(config.name);
    accessory.getService(this.api.hap.Service.AccessoryInformation)
      ?.setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'JimBoHa')
      .setCharacteristic(this.api.hap.Characteristic.Model, 'UniFi Protect Person Tracker Map')
      .setCharacteristic(this.api.hap.Characteristic.SerialNumber, 'person-tracker-map');

    const delegate = new MapCameraDelegate(tracker, renderer, config.ffmpegPath, this.log);
    accessory.configureController(new this.api.hap.CameraController({
      cameraStreamCount: 2,
      delegate,
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

    this.protectAdapter = new UniFiProtectAdapter(config.protect, (event) => {
      try {
        tracker.ingest(event);
      } catch (error) {
        this.log.warn(`Protect event ignored: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, this.log);
    this.protectAdapter.start();

    this.log.info(`Map snapshot available at ${snapshotUrl}`);
    this.log.info('Use Bearer admin token for /events, /state, and /map-config write/read endpoints.');
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
    this.protectAdapter?.stop();
    await this.httpServer?.stop();
  }
}
