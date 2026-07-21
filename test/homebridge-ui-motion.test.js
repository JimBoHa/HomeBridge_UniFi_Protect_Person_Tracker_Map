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
    this.disabled = false;
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

describe('Homebridge motion settings UI', () => {
  it('defaults off and stages enabled motion settings', async () => {
    const html = await readFile(new URL('../homebridge-ui/public/index.html', import.meta.url), 'utf8');
    const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
    expect(script).toBeTruthy();

    const elements = new Map();
    const element = (id) => {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    };
    const stagedBlocks = [];
    const homebridge = {
      getPluginConfig: async () => [{
        platform: 'UniFiProtectPersonTrackerMap',
        name: 'Map',
        mapConfig: { width: 640, height: 480, cameras: [] },
      }],
      hideSpinner() {},
      request: async (path) => { throw new Error(`Unexpected request: ${path}`); },
      showSpinner() {},
      toast: { error() {}, success() {} },
      updatePluginConfig: async (blocks) => {
        stagedBlocks.push(structuredClone(blocks));
        return structuredClone(blocks);
      },
    };
    const window = {
      addEventListener() {},
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
    expect(element('motion-sensor').checked).toBe(false);
    expect(element('motion-reset').value).toBe('30');
    expect(element('motion-reset').disabled).toBe(true);

    element('motion-sensor').checked = true;
    element('motion-sensor').dispatch('change');
    element('motion-reset').value = '45';
    element('motion-reset').dispatch('input');
    await waitFor(() => stagedBlocks.length === 1);

    expect(element('motion-reset').disabled).toBe(false);
    expect(stagedBlocks[0][0]).toMatchObject({
      motionSensor: true,
      motionResetSeconds: 45,
    });
  });
});
