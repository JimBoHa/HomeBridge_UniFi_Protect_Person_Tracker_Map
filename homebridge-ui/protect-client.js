import { Agent, request } from 'undici';
import { RequestError } from '@homebridge/plugin-ui-utils';

export const PROTECT_REQUEST_TIMEOUT_MS = 15_000;

export async function fetchBootstrap(config, dependencies = {}) {
  const requestFn = dependencies.request ?? request;
  const createDispatcher = dependencies.createDispatcher
    ?? (() => new Agent({ connect: { rejectUnauthorized: false } }));
  const timeoutMs = dependencies.timeoutMs ?? PROTECT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  let dispatcher;

  try {
    dispatcher = config.ignoreTls ? createDispatcher() : undefined;
    const login = await requestFn(url(config.host, '/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: config.username, password: config.password }),
      dispatcher,
      signal: controller.signal,
    });
    const cookie = login.headers['set-cookie'];
    const sessionCookie = Array.isArray(cookie) ? cookie[0]?.split(';')[0] : String(cookie ?? '').split(';')[0];
    await discardBody(login.body, controller.signal);
    if (login.statusCode < 200 || login.statusCode > 299) {
      throw new RequestError(`Protect login failed: ${login.statusCode}`, {});
    }
    if (!sessionCookie) {
      throw new RequestError('Protect login did not return a session cookie.', {});
    }

    const bootstrap = await requestFn(url(config.host, '/proxy/protect/api/bootstrap'), {
      method: 'GET',
      headers: { cookie: sessionCookie },
      dispatcher,
      signal: controller.signal,
    });
    if (bootstrap.statusCode < 200 || bootstrap.statusCode > 299) {
      await discardBody(bootstrap.body, controller.signal);
      throw new RequestError(`Protect bootstrap failed: ${bootstrap.statusCode}`, {});
    }
    try {
      return await bootstrap.body.json();
    } catch (error) {
      bootstrap.body.destroy?.();
      throw error;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new RequestError('Protect request timed out.', {});
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (dispatcher) {
      await dispatcher.close().catch(() => undefined);
    }
  }
}

async function discardBody(body, signal) {
  if (!body) {
    return;
  }
  if (signal.aborted) {
    body.destroy?.();
    return;
  }
  try {
    await body.dump({ signal });
  } catch {
    body.destroy?.();
  }
}

function url(hostValue, path) {
  const host = /^https?:\/\//.test(hostValue) ? hostValue : `https://${hostValue}`;
  const parsed = new URL(host);
  parsed.pathname = path;
  parsed.search = '';
  return parsed.toString();
}
