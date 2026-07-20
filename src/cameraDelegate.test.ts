import { describe, expect, it } from 'vitest';
import { buildSrtpOutputUrl, udpSocketTypeForAddressVersion } from './cameraDelegate.js';

describe('stream network address handling', () => {
  it.each([
    ['ipv4', 'udp4'],
    ['ipv6', 'udp6'],
  ] as const)('allocates an %s socket with the %s family', (addressVersion, socketType) => {
    expect(udpSocketTypeForAddressVersion(addressVersion)).toBe(socketType);
  });

  it('preserves an IPv4 SRTP destination', () => {
    expect(buildSrtpOutputUrl('10.0.0.12', 'ipv4', 50_000, 1_376)).toBe(
      'srtp://10.0.0.12:50000?rtcpport=50000&pkt_size=1376',
    );
  });

  it('brackets an IPv6 SRTP destination', () => {
    expect(buildSrtpOutputUrl('fd00::12', 'ipv6', 50_000, 1_376)).toBe(
      'srtp://[fd00::12]:50000?rtcpport=50000&pkt_size=1376',
    );
  });

  it('does not double-bracket a normalized IPv6 destination', () => {
    expect(buildSrtpOutputUrl('[fd00::12]', 'ipv6', 50_000, 1_376)).toBe(
      'srtp://[fd00::12]:50000?rtcpport=50000&pkt_size=1376',
    );
  });
});
