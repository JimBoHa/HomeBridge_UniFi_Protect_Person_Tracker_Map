import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

class FakeCanvasContext {
  constructor() {
    this.fillStyle = '';
    this.renders = [];
  }

  arc() {}
  beginPath() {}
  closePath() {}
  drawImage() {}
  fill() { this.renders.at(-1)?.push(this.fillStyle); }
  fillRect() { this.renders.push([]); }
  fillText() {}
  lineTo() {}
  moveTo() {}
  stroke() {}
}

class FakeElement {
  constructor(id = '', context = undefined) {
    this.id = id;
    this.context = context;
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

  append(...children) { this.children.push(...children); }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  getContext() { return this.context; }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.width, height: this.height };
  }

  set textContent(value) {
    this._textContent = value;
    if (value === '') this.children = [];
  }

  get textContent() { return this._textContent; }
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('UI did not reach expected state');
}

describe('Homebridge field-of-view editor', () => {
  it('previews and stages only an explicitly configured wedge', async () => {
    const html = await readFile(new URL('../homebridge-ui/public/index.html', import.meta.url), 'utf8');
    const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
    expect(script).toBeTruthy();

    const canvasContext = new FakeCanvasContext();
    const elements = new Map();
    const element = (id) => {
      if (!elements.has(id)) elements.set(id, new FakeElement(id, id === 'map' ? canvasContext : undefined));
      return elements.get(id);
    };
    const stagedBlocks = [];
    const homebridge = {
      getPluginConfig: async () => [{
        platform: 'UniFiProtectPersonTrackerMap',
        name: 'Map',
        mapConfig: {
          width: 640,
          height: 480,
          cameras: [{ id: 'front', name: 'Front Door', position: { x: 40, y: 60 }, headingDegrees: 90 }],
        },
      }],
      hideSpinner() {},
      request: async (route) => { throw new Error(`Unexpected request: ${route}`); },
      showSpinner() {},
      toast: { error() {}, success() {} },
      updatePluginConfig: async (blocks) => {
        stagedBlocks.push(structuredClone(blocks));
        return structuredClone(blocks);
      },
    };
    const window = { addEventListener() {}, clearTimeout, setTimeout };
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
    expect(canvasContext.renders.at(-1)).not.toContain('rgba(220, 38, 38, 0.14)');

    const cameraRow = element('camera-list').children[0];
    const fovInput = cameraRow.children[0].children[5].children[1];
    fovInput.value = '120';
    fovInput.dispatch('input');

    expect(canvasContext.renders.at(-1)).toContain('rgba(220, 38, 38, 0.14)');
    await waitFor(() => stagedBlocks.length === 1);
    expect(stagedBlocks[0][0].mapConfig.cameras[0].fovDegrees).toBe(120);

    fovInput.value = '';
    fovInput.dispatch('input');

    expect(canvasContext.renders.at(-1)).not.toContain('rgba(220, 38, 38, 0.14)');
    await waitFor(() => stagedBlocks.length === 2);
    expect(stagedBlocks[1][0].mapConfig.cameras[0]).not.toHaveProperty('fovDegrees');
  });
});
