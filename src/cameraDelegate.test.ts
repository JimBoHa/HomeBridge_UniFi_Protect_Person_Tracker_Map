import { describe, expect, it } from 'vitest';
import { buildSrtpOutputUrl } from './cameraDelegate.js';

describe('buildSrtpOutputUrl', () => {
  it('binds RTCP to the port advertised to HomeKit', () => {
    expect(buildSrtpOutputUrl('10.0.0.12', 50_000, 41_234, 1_376)).toBe(
      'srtp://10.0.0.12:50000?rtcpport=50000&localrtcpport=41234&pkt_size=1376',
    );
  });
});
