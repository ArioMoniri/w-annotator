/** Addresses of a room hosted by the desktop app itself. */

export interface HostedRoom {
  /** Where the host connects: always this computer, so no firewall or network setting is in the way. */
  connect: string;
  /** What goes into the invite link. */
  share: string;
  /** True when the computer has no network address, so the link only works on this computer. */
  localOnly: boolean;
}

const LOOPBACK = '127.0.0.1';

export function hostedRoom(info: { port: number; addresses: string[] }): HostedRoom {
  const address = info.addresses.map((a) => a.trim()).find(Boolean);
  return {
    connect: `ws://${LOOPBACK}:${info.port}`,
    share: `ws://${address ?? LOOPBACK}:${info.port}`,
    localOnly: !address,
  };
}

/** Why an invite could not be used, in words for the join form. */
export function joinProblem(input: string, defaultServer: string): string {
  const bareCode = /^[a-z0-9]{4,16}$/i.test(input.replace(/[\s-]/g, ''));
  if (bareCode && !defaultServer) return 'A code alone needs a room server. Paste the invite link instead.';
  return 'Enter the room code or paste the invite link.';
}
