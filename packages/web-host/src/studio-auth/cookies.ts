export const STUDIO_CSRF_COOKIE_NAME = 'aelix-studio-csrf-token';

const cookies = [
  { hostName: 'aionui-session', studioName: 'aelix-studio-session', path: '/', httpOnly: true },
  { hostName: 'aionui-refresh', studioName: 'aelix-studio-refresh', path: '/api/auth/refresh', httpOnly: true },
  { hostName: 'aionui-csrf-token', studioName: STUDIO_CSRF_COOKIE_NAME, path: '/', httpOnly: false },
] as const;

/** The ordinary IPv4 loopback authorities AionUi also accepts. */
export function usesSharedLoopbackHost(authority: string | undefined): boolean {
  return /^(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(authority ?? '');
}

/** Translate only Studio credentials. Duplicate names never authenticate. */
export function toHostCookieHeader(
  authority: string | undefined,
  header: string | undefined,
  requestUrl: string
): string | undefined {
  if (!authority || !header) return undefined;
  const fields = header.split(';').map((field) => field.trim());
  const pathname = requestUrl.split('?', 1)[0];
  const translated = cookies.flatMap(({ hostName, studioName, path }) => {
    if (path !== '/' && path !== pathname) return [];
    const name = studioName + '=';
    const entries = fields.filter((field) => field.startsWith(name));
    return entries.length === 1 ? [hostName + '=' + entries[0].slice(name.length)] : [];
  });
  return translated.length ? translated.join('; ') : undefined;
}

/** Publish host-only Studio cookies with the pinned host's lifetimes and paths. */
export function toStudioSetCookie(
  authority: string | undefined,
  values: readonly string[],
  secureOrigin: boolean
): string[] {
  if (!authority) return [];
  return values.flatMap((value) => {
    const [pair, ...attributes] = value.split(';').map((field) => field.trim());
    const separator = pair.indexOf('=');
    if (separator < 1) return [];
    const spec = cookies.find(({ hostName }) => hostName === pair.slice(0, separator));
    if (!spec) return [];
    const secure = secureOrigin || attributes.some((attribute) => /^secure$/i.test(attribute));
    const lifetime = attributes.filter((attribute) => /^(max-age|expires)=/i.test(attribute));
    return [
      [
        spec.studioName + pair.slice(separator),
        'Path=' + spec.path,
        ...(spec.httpOnly ? ['HttpOnly'] : []),
        secure ? 'SameSite=Strict' : 'SameSite=Lax',
        ...(secure ? ['Secure'] : []),
        ...lifetime,
      ].join('; '),
    ];
  });
}
