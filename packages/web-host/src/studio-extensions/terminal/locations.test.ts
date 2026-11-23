/** Where the terminal CLI is looked for: uv's and pipx's documented defaults, from Studio's environment. */
import { describe, expect, it } from 'vitest';
import { PATH_ENTRY_LIMIT, searchLocations } from './locations';

const roots = (locations: ReturnType<typeof searchLocations>) =>
  locations.toolRoots.map((root) => `${root.foundBy} ${root.directory}`);

describe('where the terminal CLI is looked for', () => {
  it('uses the Linux defaults of uv and pipx, and the launcher directories', () => {
    const locations = searchLocations({ PATH: '/usr/bin:relative/bin:/opt/tools/bin' }, '/home/u', 'linux');
    expect(roots(locations)).toEqual([
      'uv_tool /home/u/.local/share/uv/tools',
      'pipx /home/u/.local/share/pipx/venvs',
      'pipx /home/u/.local/pipx/venvs',
    ]);
    expect(locations.launcherDirectories).toEqual([
      '/home/u/.local/bin',
      '/home/linuxbrew/.linuxbrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/opt/tools/bin',
    ]);
    expect(locations.agentDirectory).toBe('/home/u/.aelix/agent');
  });

  it('adds the macOS application-support directories uv and pipx have used', () => {
    const locations = searchLocations({}, '/Users/u', 'darwin');
    expect(roots(locations)).toEqual([
      'uv_tool /Users/u/.local/share/uv/tools',
      'uv_tool /Users/u/Library/Application Support/uv/tools',
      'pipx /Users/u/Library/Application Support/pipx/venvs',
      'pipx /Users/u/.local/pipx/venvs',
    ]);
    expect(locations.launcherDirectories).toEqual([
      '/Users/u/.local/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
    ]);
  });

  it('follows the variables Studio sees, first, and ignores relative XDG values', () => {
    const locations = searchLocations(
      {
        UV_TOOL_DIR: '/srv/uv-tools',
        PIPX_HOME: '~/pipx-home',
        XDG_DATA_HOME: '/data/xdg',
        XDG_BIN_HOME: 'relative/bin',
        UV_TOOL_BIN_DIR: '/srv/bin',
        PIPX_BIN_DIR: '~/pipx-bin',
        AELIX_CODING_AGENT_DIR: '~/agent-dir',
      },
      '/home/u',
      'linux'
    );
    expect(roots(locations)).toEqual([
      'uv_tool /srv/uv-tools',
      'uv_tool /data/xdg/uv/tools',
      'uv_tool /home/u/.local/share/uv/tools',
      'pipx /home/u/pipx-home/venvs',
      'pipx /data/xdg/pipx/venvs',
      'pipx /home/u/.local/share/pipx/venvs',
      'pipx /home/u/.local/pipx/venvs',
    ]);
    expect(locations.launcherDirectories.slice(0, 4)).toEqual([
      '/srv/bin',
      '/data/bin',
      '/home/u/pipx-bin',
      '/home/u/.local/bin',
    ]);
    expect(locations.agentDirectory).toBe('/home/u/agent-dir');
  });

  it('looks only in the tool directories on Windows, where launchers are binary', () => {
    const locations = searchLocations(
      { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', PATH: 'C:\\bin' },
      'C:\\Users\\u',
      'win32'
    );
    expect(roots(locations)).toEqual([
      'uv_tool C:\\Users\\u\\AppData\\Roaming\\uv\\data\\tools',
      'uv_tool C:\\Users\\u\\AppData\\Roaming\\uv\\tools',
      'pipx C:\\Users\\u\\AppData\\Local\\pipx\\pipx\\venvs',
      'pipx C:\\Users\\u\\.local\\pipx\\venvs',
      'pipx C:\\Users\\u\\pipx\\venvs',
    ]);
    expect(locations.launcherDirectories).toEqual([]);
    expect(locations.agentDirectory).toBe('C:\\Users\\u\\.aelix\\agent');
  });

  it('looks at no more than the first entries of a long PATH, and says it stopped short', () => {
    const path = Array.from({ length: PATH_ENTRY_LIMIT + 10 }, (_, index) => `/p${index}`).join(':');
    const locations = searchLocations({ PATH: path }, '/home/u', 'linux');
    expect(locations.launcherDirectories).toContain(`/p${PATH_ENTRY_LIMIT - 1}`);
    expect(locations.launcherDirectories).not.toContain(`/p${PATH_ENTRY_LIMIT}`);
    expect(locations.truncated).toBe(true);
    expect(searchLocations({ PATH: '/a:/b' }, '/home/u', 'linux').truncated).toBe(false);
  });

  it('ignores relative locations, which uv and pipx take from a working directory Studio does not know', () => {
    const locations = searchLocations(
      { UV_TOOL_DIR: 'tools', PIPX_HOME: 'pipx-home', AELIX_CODING_AGENT_DIR: 'agent' },
      '/home/u',
      'linux'
    );
    expect(roots(locations)).toEqual([
      'uv_tool /home/u/.local/share/uv/tools',
      'pipx /home/u/.local/share/pipx/venvs',
      'pipx /home/u/.local/pipx/venvs',
    ]);
    expect(locations.agentDirectory).toBeUndefined();
  });

  it('refuses Windows UNC and device paths from every variable, and falls back to the usual app data folders', () => {
    const locations = searchLocations(
      {
        UV_TOOL_DIR: '\\\\server\\tools',
        PIPX_HOME: '\\\\?\\C:\\pipx',
        AELIX_CODING_AGENT_DIR: '//server/agent',
      },
      'C:\\Users\\u',
      'win32'
    );
    expect(roots(locations)).toEqual([
      'uv_tool C:\\Users\\u\\AppData\\Roaming\\uv\\data\\tools',
      'uv_tool C:\\Users\\u\\AppData\\Roaming\\uv\\tools',
      'pipx C:\\Users\\u\\AppData\\Local\\pipx\\pipx\\venvs',
      'pipx C:\\Users\\u\\.local\\pipx\\venvs',
      'pipx C:\\Users\\u\\pipx\\venvs',
    ]);
    expect(locations.agentDirectory).toBeUndefined();
    // Drive-relative and root-relative paths depend on a current drive or directory.
    expect(
      roots(
        searchLocations(
          { UV_TOOL_DIR: '\\tools', PIPX_HOME: 'C:pipx', LOCALAPPDATA: '/local', APPDATA: 'D:roaming' },
          'C:\\Users\\u',
          'win32'
        )
      )
    ).toEqual([
      'uv_tool C:\\Users\\u\\AppData\\Roaming\\uv\\data\\tools',
      'uv_tool C:\\Users\\u\\AppData\\Roaming\\uv\\tools',
      'pipx C:\\Users\\u\\AppData\\Local\\pipx\\pipx\\venvs',
      'pipx C:\\Users\\u\\.local\\pipx\\venvs',
      'pipx C:\\Users\\u\\pipx\\venvs',
    ]);
    // A UNC home gives nothing to search.
    expect(searchLocations({}, '\\\\server\\home\\u', 'win32').toolRoots).toEqual([]);
  });
});
