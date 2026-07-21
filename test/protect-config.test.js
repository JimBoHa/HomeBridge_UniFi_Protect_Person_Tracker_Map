import { describe, expect, it } from 'vitest';
import { applyProtectControllerFallback, sanitizeProtect } from '../homebridge-ui/protect-config.js';

const controller = {
  address: 'protect.local',
  username: 'stored-user',
  password: 'stored-password',
};

describe('Protect discovery config', () => {
  it('uses the stored-controller TLS fallback when the inline flag is absent', () => {
    const direct = sanitizeProtect(undefined);

    expect(direct.ignoreTls).toBeUndefined();
    expect(applyProtectControllerFallback(direct, controller)).toEqual({
      host: 'protect.local',
      username: 'stored-user',
      password: 'stored-password',
      ignoreTls: true,
    });
  });

  it('preserves an explicit false TLS setting', () => {
    const direct = sanitizeProtect({ ignoreTls: false });

    expect(applyProtectControllerFallback(direct, controller).ignoreTls).toBe(false);
  });

  it('does not coerce non-boolean TLS settings', () => {
    const direct = sanitizeProtect({ ignoreTls: 'false' });

    expect(direct.ignoreTls).toBeUndefined();
    expect(applyProtectControllerFallback(direct, controller).ignoreTls).toBe(true);
  });
});
