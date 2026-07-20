import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.listeners = new Map();
    this.children = [];
    this.value = '';
    this.checked = false;
    this.files = [];
    this.width = 1280;
    this.height = 720;
    this._textContent = '';
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  append(...children) {
    this.children.push(...children);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  getContext() {
    return {
      arc() {},
      beginPath() {},
      drawImage() {},
      fill() {},
      fillRect() {},
      fillText() {},
      lineTo() {},
      moveTo() {},
      stroke() {},
    };
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.width, height: this.height };
  }

  set textContent(value) {
    this._textContent = value;
    if (value === '') this.children = [];
  }

  get textContent() {
    return this._textContent;
  }
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('UI did not reach expected state');
}

describe('Homebridge map editor UI', () => {
  it('loads a path-backed map and preserves it when credentials are staged', async () => {
    const html = await readFile(new URL('../homebridge-ui/public/index.html', import.meta.url), 'utf8');
    const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
    expect(script).toBeTruthy();

    const elements = new Map();
    const element = (id) => {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    };
    const requestCalls = [];
    const stagedBlocks = [];
    const pluginConfig = {
      platform: 'UniFiProtectPersonTrackerMap',
      name: 'Map',
      mapConfigPath: '/srv/homebridge/placements.json',
      protect: { host: 'protect.local', username: 'old-user', password: 'existing-password', pollSeconds: 5 },
    };
    const mapConfig = {
      width: 640,
      height: 480,
      cameras: [{ id: 'front', name: 'Front Door', position: { x: 40, y: 60 } }],
    };
    const homebridge = {
      getPluginConfig: async () => [structuredClone(pluginConfig)],
      hideSpinner() {},
      request: async (...args) => {
        requestCalls.push(args);
        if (args[0] === '/load-map-config') return { mapConfig: structuredClone(mapConfig) };
        throw new Error(`Unexpected request: ${args[0]}`);
      },
      showSpinner() {},
      toast: { error() {}, success() {} },
      updatePluginConfig: async (blocks) => {
        stagedBlocks.push(structuredClone(blocks));
        return structuredClone(blocks);
      },
    };
    const windowListeners = new Map();
    const window = {
      addEventListener(type, listener) { windowListeners.set(type, listener); },
      clearTimeout,
      setTimeout,
    };
    const document = {
      createElement: () => new FakeElement(),
      getElementById: element,
    };

    vm.runInNewContext(script, {
      document,
      FileReader: class {},
      homebridge,
      Image: class {},
      structuredClone,
      window,
    });

    await waitFor(() => element('status').textContent.startsWith('Ready.'));
    expect(requestCalls).toEqual([['/load-map-config']]);
    expect(element('camera-list').children).toHaveLength(1);

    element('protect-username').value = 'new-user';
    element('protect-username').dispatch('input');
    await waitFor(() => stagedBlocks.length === 1);

    const credentialsStage = stagedBlocks[0][0];
    expect(credentialsStage.protect.username).toBe('new-user');
    expect(credentialsStage.mapConfigPath).toBe('/srv/homebridge/placements.json');
    expect(credentialsStage).not.toHaveProperty('mapConfig');

    const cameraRow = element('camera-list').children[0];
    const nameInput = cameraRow.children[0].children[1].children[1];
    nameInput.value = 'Updated Front Door';
    nameInput.dispatch('input');
    await waitFor(() => stagedBlocks.length === 2);

    expect(stagedBlocks[1][0].mapConfig).toMatchObject({
      width: 640,
      height: 480,
      cameras: [{ id: 'front', name: 'Updated Front Door', position: { x: 40, y: 60 } }],
    });
  });
});
