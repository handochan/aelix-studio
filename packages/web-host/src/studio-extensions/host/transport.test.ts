/**
 * Whether a WebUI request can carry a secret: the socket's verdict (or the listener's, for a
 * relayed connection), which the page's Origin can only lower.
 */
import type http from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  createRelayVerdicts,
  isLoopbackAddress,
  originKeepsSecure,
  requestTransport,
  secureTransport,
} from './transport';

const connection = (socket: Record<string, unknown>, headers: Record<string, string> = {}) =>
  ({ socket, headers }) as unknown as http.IncomingMessage;

describe('the transport of a WebUI request', () => {
  it('tells loopback peers apart', () => {
    for (const address of ['127.0.0.1', '127.10.0.5', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1'])
      expect(isLoopbackAddress(address)).toBe(true);
    for (const address of [undefined, '', '192.168.1.5', '10.0.0.1', '::ffff:10.0.0.1', 'fe80::1', '128.0.0.1'])
      expect(isLoopbackAddress(address)).toBe(false);
  });

  it('judges a socket by itself: TLS or a loopback peer', () => {
    expect(secureTransport(connection({ remoteAddress: '127.0.0.1' }))).toBe(true);
    expect(secureTransport(connection({ remoteAddress: '::ffff:127.0.0.1' }))).toBe(true);
    expect(secureTransport(connection({ remoteAddress: '203.0.113.7', encrypted: true }))).toBe(true);
    expect(secureTransport(connection({ remoteAddress: '192.168.1.5' }))).toBe(false);
    // Headers a client or a proxy sets change nothing.
    expect(
      secureTransport(
        connection(
          { remoteAddress: '203.0.113.7' },
          { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https', forwarded: 'for=127.0.0.1;proto=https' }
        )
      )
    ).toBe(false);
  });

  it('keeps a secure socket only for an https origin or an http origin on a loopback host name', () => {
    for (const origin of [
      'https://studio.example',
      'https://203.0.113.7:8443',
      'http://localhost:25809',
      'http://LOCALHOST:25809',
      'http://127.0.0.1:25809',
      'http://127.10.0.5',
      'http://[::1]:25809',
    ])
      expect(originKeepsSecure(origin), origin).toBe(true);
    for (const origin of [
      // A reverse proxy on this machine serving the public over plain HTTP.
      'http://studio.example',
      'http://203.0.113.7:25809',
      'http://192.168.1.5:25809',
      'http://localhost.studio.example',
      'http://[::ffff:127.0.0.1]:25809',
      // Not a web origin, or none at all.
      'ws://localhost:25809',
      'file:///index.html',
      'null',
      'not an origin',
      '',
      undefined,
    ])
      expect(originKeepsSecure(origin), String(origin)).toBe(false);
  });

  it('lowers the socket verdict by the Origin and never raises it', () => {
    const local = { remoteAddress: '127.0.0.1' };
    const remote = { remoteAddress: '192.168.1.5' };
    // A TLS-terminating proxy on this machine: the browser sent it over TLS.
    expect(requestTransport(connection(local, { origin: 'https://studio.example' }))).toBe('secure');
    // A plain-HTTP proxy on this machine in front of the public: the secret crossed in the clear.
    expect(requestTransport(connection(local, { origin: 'http://studio.example' }))).toBe('insecure');
    expect(requestTransport(connection(local, { origin: 'http://localhost:25809' }))).toBe('secure');
    expect(requestTransport(connection(local))).toBe('insecure');
    expect(requestTransport(connection(local, { origin: 'null' }))).toBe('insecure');
    // No Origin raises a remote plain-HTTP peer.
    expect(requestTransport(connection(remote, { origin: 'https://studio.example' }))).toBe('insecure');
    expect(requestTransport(connection(remote, { origin: 'http://localhost:25809' }))).toBe('insecure');
    // A verdict given by the caller (the listener's) is lowered the same way.
    const listener = () => true;
    expect(requestTransport(connection(remote, { origin: 'http://localhost:25809' }), listener)).toBe('secure');
    expect(requestTransport(connection(local, { origin: 'http://studio.example' }), listener)).toBe('insecure');
    expect(requestTransport(connection(local, { origin: 'https://studio.example' }), () => false)).toBe('insecure');
  });
});

describe('the listener verdicts on relayed connections', () => {
  const relayed = (remoteAddress: string, remotePort: number) => connection({ remoteAddress, remotePort });

  it('finds a verdict only where both the address and the port match', () => {
    const verdicts = createRelayVerdicts();
    verdicts.record('127.0.0.1', 50000, true);
    expect(verdicts.fromThisMachine(relayed('127.0.0.1', 50000))).toBe(true);
    expect(verdicts.fromThisMachine(relayed('127.0.0.2', 50000))).toBe(false);
    expect(verdicts.fromThisMachine(relayed('::ffff:127.0.0.1', 50000))).toBe(false);
    expect(verdicts.fromThisMachine(relayed('127.0.0.1', 50001))).toBe(false);
    expect(verdicts.fromThisMachine(connection({ remoteAddress: '127.0.0.1' }))).toBe(false);
    expect(verdicts.fromThisMachine(connection({ remotePort: 50000 }))).toBe(false);
    verdicts.record('127.0.0.1', 50002, false);
    expect(verdicts.fromThisMachine(relayed('127.0.0.1', 50002))).toBe(false);
  });

  it('lets a late close remove only its own record, not a newer connection on the same address and port', () => {
    const verdicts = createRelayVerdicts();
    const releaseOld = verdicts.record('127.0.0.1', 50000, false);
    // The address and port are reused before the old connection's close arrives.
    const releaseNew = verdicts.record('127.0.0.1', 50000, true);
    releaseOld();
    expect(verdicts.fromThisMachine(relayed('127.0.0.1', 50000))).toBe(true);
    releaseNew();
    expect(verdicts.fromThisMachine(relayed('127.0.0.1', 50000))).toBe(false);
    // Releasing twice changes nothing.
    const releaseThird = verdicts.record('127.0.0.1', 50000, true);
    releaseNew();
    expect(verdicts.fromThisMachine(relayed('127.0.0.1', 50000))).toBe(true);
    releaseThird();
    expect(verdicts.fromThisMachine(relayed('127.0.0.1', 50000))).toBe(false);
  });
});
