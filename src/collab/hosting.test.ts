import { describe, expect, it } from 'vitest';
import { hostedRoom } from './hosting';

describe('hostedRoom', () => {
  it('lets the host connect over loopback and shares the network address', () => {
    expect(hostedRoom({ port: 8787, addresses: ['192.168.1.20', '10.0.0.5'] })).toEqual({
      connect: 'ws://127.0.0.1:8787',
      share: 'ws://192.168.1.20:8787',
      localOnly: false,
    });
  });

  it('falls back to loopback, and says so, when the computer has no network address', () => {
    expect(hostedRoom({ port: 41000, addresses: [] })).toEqual({
      connect: 'ws://127.0.0.1:41000',
      share: 'ws://127.0.0.1:41000',
      localOnly: true,
    });
  });

  it('ignores blank addresses', () => {
    expect(hostedRoom({ port: 1, addresses: ['', ' '] }).localOnly).toBe(true);
  });
});
