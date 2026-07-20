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

async function startUi() {
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
      protect: { host: 'protect.local', username: 'user', password: 'password', pollSeconds: 5 },
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
  return { element, html, stagedBlocks };
}

describe('Homebridge trail settings UI', () => {
  it('defaults trails off and clamps staged values to integer bounds', async () => {
    const { element, html, stagedBlocks } = await startUi();

    expect(html).toMatch(/id="trail-points"[^>]*min="0"[^>]*max="64"[^>]*step="1"/);
    expect(element('trail-points').value).toBe('0');

    element('trail-points').value = '80';
    element('trail-points').dispatch('input');
    await waitFor(() => stagedBlocks.length === 1);
    expect(stagedBlocks[0][0].trailPoints).toBe(64);
    expect(element('trail-points').value).toBe('64');

    element('trail-points').value = '-2';
    element('trail-points').dispatch('input');
    await waitFor(() => stagedBlocks.length === 2);
    expect(stagedBlocks[1][0].trailPoints).toBe(0);

    element('trail-points').value = '1.5';
    element('trail-points').dispatch('input');
    await waitFor(() => stagedBlocks.length === 3);
    expect(stagedBlocks[2][0].trailPoints).toBe(0);
  });
});
