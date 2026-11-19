import { describe, expect, it } from 'vitest';
import { hostedRoom, joinProblem } from './hosting';

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

describe('joinProblem', () => {
  it('asks for the full link when a bare code is given and no room server is set', () => {
    expect(joinProblem('ABC-DEF', '')).toBe('A code alone needs a room server. Paste the invite link instead.');
    expect(joinProblem(' abcdef ', '')).toBe('A code alone needs a room server. Paste the invite link instead.');
  });

  it('gives the general hint for anything else', () => {
    expect(joinProblem('', '')).toBe('Enter the room code or paste the invite link.');
    expect(joinProblem('ws://nowhere', '')).toBe('Enter the room code or paste the invite link.');
    expect(joinProblem('not a code!', 'ws://rooms.example.org')).toBe('Enter the room code or paste the invite link.');
  });
});
