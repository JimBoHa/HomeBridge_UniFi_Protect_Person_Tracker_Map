import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBootstrap } from '../homebridge-ui/protect-client.js';

const config = {
  host: 'protect.example.test',
  username: 'person-tracker',
  password: 'secret',
  ignoreTls: true,
};

function response({ statusCode = 200, headers = {}, json = {} } = {}) {
  return {
    statusCode,
    headers,
    body: {
      dump: vi.fn().mockResolvedValue(undefined),
      json: vi.fn().mockResolvedValue(json),
      destroy: vi.fn(),
    },
  };
}

function dispatcher() {
  return { close: vi.fn().mockResolvedValue(undefined) };
}

describe('Protect UI discovery client', () => {
  afterEach(() => vi.useRealTimers());

  it('drains login, consumes bootstrap, and closes its insecure TLS dispatcher', async () => {
    const login = response({ headers: { 'set-cookie': 'TOKEN=abc; Path=/; Secure' } });
    const bootstrap = response({ json: { cameras: [{ id: 'camera-1' }] } });
    const request = vi.fn()
      .mockResolvedValueOnce(login)
      .mockResolvedValueOnce(bootstrap);
    const ownedDispatcher = dispatcher();

    await expect(fetchBootstrap(config, {
      request,
      createDispatcher: () => ownedDispatcher,
    })).resolves.toEqual({ cameras: [{ id: 'camera-1' }] });

    expect(login.body.dump).toHaveBeenCalledOnce();
    expect(bootstrap.body.json).toHaveBeenCalledOnce();
    expect(bootstrap.body.dump).not.toHaveBeenCalled();
    expect(bootstrap.body.destroy).not.toHaveBeenCalled();
    expect(ownedDispatcher.close).toHaveBeenCalledOnce();
    expect(request).toHaveBeenNthCalledWith(1, 'https://protect.example.test/api/auth/login', expect.objectContaining({
      dispatcher: ownedDispatcher,
      signal: expect.any(AbortSignal),
    }));
    expect(request).toHaveBeenNthCalledWith(2, 'https://protect.example.test/proxy/protect/api/bootstrap', expect.objectContaining({
      dispatcher: ownedDispatcher,
      headers: { cookie: 'TOKEN=abc' },
      signal: expect.any(AbortSignal),
    }));
  });

  it('drains failure bodies before reporting a Protect error', async () => {
    const login = response({ headers: { 'set-cookie': 'TOKEN=abc' } });
    const bootstrap = response({ statusCode: 503 });
    const request = vi.fn()
      .mockResolvedValueOnce(login)
      .mockResolvedValueOnce(bootstrap);
    const ownedDispatcher = dispatcher();

    await expect(fetchBootstrap(config, {
      request,
      createDispatcher: () => ownedDispatcher,
    })).rejects.toThrow('Protect bootstrap failed: 503');

    expect(login.body.dump).toHaveBeenCalledOnce();
    expect(bootstrap.body.dump).toHaveBeenCalledOnce();
    expect(ownedDispatcher.close).toHaveBeenCalledOnce();
  });

  it('cancels an unreadable login failure body', async () => {
    const login = response({ statusCode: 401 });
    login.body.dump.mockRejectedValue(new Error('body read failed'));
    const ownedDispatcher = dispatcher();

    await expect(fetchBootstrap(config, {
      request: vi.fn().mockResolvedValue(login),
      createDispatcher: () => ownedDispatcher,
    })).rejects.toThrow('Protect login failed: 401');

    expect(login.body.destroy).toHaveBeenCalledOnce();
    expect(ownedDispatcher.close).toHaveBeenCalledOnce();
  });

  it('aborts a stalled request at the deadline and closes its dispatcher', async () => {
    vi.useFakeTimers();
    const ownedDispatcher = dispatcher();
    const request = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));

    const pending = fetchBootstrap(config, {
      request,
      createDispatcher: () => ownedDispatcher,
      timeoutMs: 25,
    });
    const rejection = expect(pending).rejects.toThrow('Protect request timed out.');
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(ownedDispatcher.close).toHaveBeenCalledOnce();
  });

  it('does not create or close a dispatcher for verified TLS', async () => {
    const login = response({ headers: { 'set-cookie': 'TOKEN=abc' } });
    const bootstrap = response({ json: { cameras: [] } });
    const request = vi.fn()
      .mockResolvedValueOnce(login)
      .mockResolvedValueOnce(bootstrap);
    const createDispatcher = vi.fn();

    await fetchBootstrap({ ...config, ignoreTls: false }, { request, createDispatcher });

    expect(createDispatcher).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][1].dispatcher).toBeUndefined();
    expect(request.mock.calls[1][1].dispatcher).toBeUndefined();
  });
});
