import type { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { writeFrameWithBackpressure } from './cameraDelegate.js';

describe('writeFrameWithBackpressure', () => {
  it('keeps only one frame in flight until stdin drains', () => {
    let onDrain: (() => void) | undefined;
    const write = vi.fn(() => false);
    const stdin = {
      writable: true,
      write,
      once: vi.fn((event: string, listener: () => void) => {
        if (event === 'drain') {
          onDrain = listener;
        }
        return stdin;
      }),
    } as unknown as Writable;
    const state = { blocked: false };
    const frame = Buffer.alloc(16);

    writeFrameWithBackpressure(stdin, frame, state);
    writeFrameWithBackpressure(stdin, frame, state);

    expect(write).toHaveBeenCalledTimes(1);
    expect(state.blocked).toBe(true);

    onDrain?.();
    write.mockReturnValue(true);
    writeFrameWithBackpressure(stdin, frame, state);

    expect(write).toHaveBeenCalledTimes(2);
    expect(state.blocked).toBe(false);
  });
});
