import { describe, expect, it } from 'vitest';
import { frameIntervalMs } from './cameraDelegate.js';

describe('frameIntervalMs', () => {
  it('matches the negotiated frame rate', () => {
    expect(frameIntervalMs(10)).toBe(100);
    expect(frameIntervalMs(5)).toBe(200);
    expect(frameIntervalMs(1)).toBe(1000);
  });
});
