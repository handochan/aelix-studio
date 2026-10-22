type AdminCredentials = { username: string; initialPassword?: string };

/** Provision credentials while the setup backend is private; fail before any public listener opens. */
export async function ensureStudioAdmin(port: number, request: typeof fetch = fetch): Promise<AdminCredentials> {
  async function getJson<T>(route: string, method = 'GET'): Promise<T> {
    const response = await request(`http://127.0.0.1:${port}${route}`, {
      method,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Studio admin setup ${route}: HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }
  const status = await getJson<{ needs_setup?: boolean }>('/api/auth/status');
  let initialPassword: string | undefined;
  if (status.needs_setup === true) {
    const reset = await getJson<{ data?: { new_password?: string } }>('/api/webui/reset-password', 'POST');
    initialPassword = reset.data?.new_password;
    if (!initialPassword) throw new Error('Studio admin setup did not return initial credentials');
  }
  const account = await getJson<{ data?: { username?: string } }>('/api/auth/internal/users/system');
  const username = account.data?.username;
  if (!username) throw new Error('Studio admin setup did not return an account');
  return { username, ...(initialPassword ? { initialPassword } : {}) };
}
