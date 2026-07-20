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

async function startUi(updatePluginConfig) {
  const html = await readFile(new URL('../homebridge-ui/public/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
  expect(script).toBeTruthy();

  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  const toastErrors = [];
  const homebridge = {
    getPluginConfig: async () => [{
      platform: 'UniFiProtectPersonTrackerMap',
      name: 'Map',
      protect: { host: 'protect.local', username: 'user', password: 'password', pollSeconds: 5 },
    }],
    hideSpinner() {},
    request: async (route) => { throw new Error(`Unexpected request: ${route}`); },
    showSpinner() {},
    toast: {
      error: (...args) => toastErrors.push(args),
      success() {},
    },
    updatePluginConfig,
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
  return { element, toastErrors };
}

describe('Homebridge config staging UI', () => {
  it('queues edits made while a config stage is active', async () => {
    const stagedBlocks = [];
    let releaseFirstStage;
    const firstStage = new Promise((resolve) => { releaseFirstStage = resolve; });
    const { element } = await startUi(async (blocks) => {
      stagedBlocks.push(structuredClone(blocks));
      if (stagedBlocks.length === 1) {
        await firstStage;
      }
      return structuredClone(blocks);
    });

    element('name').value = 'Old name';
    element('name').dispatch('input');
    await waitFor(() => stagedBlocks.length === 1);

    element('name').value = 'New name';
    element('name').dispatch('input');
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(stagedBlocks).toHaveLength(1);

    releaseFirstStage();
    await waitFor(() => stagedBlocks.length === 2);

    expect(stagedBlocks[0][0].name).toBe('Old name');
    expect(stagedBlocks[1][0].name).toBe('New name');
  });

  it('reports a non-Error staging rejection without an unhandled promise', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const { element, toastErrors } = await startUi(async () => Promise.reject('bridge unavailable'));
      element('name').value = 'Changed';
      element('name').dispatch('input');

      await waitFor(() => element('status').textContent.startsWith('Staging failed:'));
      await new Promise((resolve) => setImmediate(resolve));

      expect(element('status').textContent).toBe('Staging failed: bridge unavailable');
      expect(toastErrors).toEqual([['bridge unavailable', 'Staging failed']]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
