export function getStudioWebUILocalUrl(port: number, ipv6 = true): string {
  return `http://${ipv6 ? '[::1]' : '127.0.0.1'}:${port}`;
}

/** Studio uses a different origin from the upstream WebUI on port 25808. */
export function getStudioWebUIDefaultPort(production: boolean, multiInstance = false): number {
  if (production) return 25982;
  return multiInstance ? 25984 : 25983;
}

type SourceHeaders = {
  host?: string;
  origin?: string;
  'sec-fetch-site'?: string;
};

export function readSourceHeaders(rawHeaders: string[]): SourceHeaders | undefined {
  const source: SourceHeaders = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (name !== 'host' && name !== 'origin' && name !== 'sec-fetch-site') continue;
    if (source[name] !== undefined) return undefined;
    source[name] = rawHeaders[i + 1];
  }
  return source;
}

export function parseOrigin(value: string): URL | undefined {
  // URL alone also accepts credentials, paths, and noncanonical IPv4 spellings.
  if (!/^https?:\/\/(?:[a-z\d.-]+|\[[a-f\d:.]+\])(?::\d{1,5})?$/i.test(value)) return undefined;
  try {
    const url = new URL(value);
    const authority = value.slice(value.indexOf('://') + 3).toLowerCase();
    const defaultPort = url.protocol === 'https:' ? '443' : '80';
    if (authority !== url.host && (url.port || authority !== `${url.host}:${defaultPort}`)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function matchesOriginAuthority(origin: URL, authority: string | undefined): boolean {
  const host = authority?.toLowerCase();
  const defaultPort = origin.protocol === 'https:' ? '443' : '80';
  return host === origin.host || (!origin.port && host === `${origin.host}:${defaultPort}`);
}

/** Bind the browser origin to the Host authority received by this listener. */
export function createRequestOriginPolicy(
  port: number,
  readLanAddresses: () => string[],
  configuredOrigin?: string,
  ipv6 = false
) {
  const origins = ['127.0.0.1', 'localhost', ...(ipv6 ? ['[::1]'] : [])].map(
    (host) => new URL(`http://${host}:${port}`)
  );
  const configured = configuredOrigin && parseOrigin(configuredOrigin);
  if (configured) origins.push(configured);

  return (source: SourceHeaders | undefined, requireOrigin: boolean): boolean => {
    const host = source?.host?.toLowerCase();
    if (!host || source?.['sec-fetch-site'] === 'cross-site' || source?.['sec-fetch-site'] === 'same-site') {
      return false;
    }
    const origin = source?.origin === undefined ? undefined : parseOrigin(source.origin);
    if (!origin && (requireOrigin || source?.origin !== undefined)) return false;

    const matchesSource = (allowed: URL): boolean =>
      matchesOriginAuthority(allowed, host) && (!origin || origin.origin === allowed.origin);
    return (
      origins.some(matchesSource) ||
      readLanAddresses().some((address) => matchesSource(new URL(`http://${address}:${port}`)))
    );
  };
}
