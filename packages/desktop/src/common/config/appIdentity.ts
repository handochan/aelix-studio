export const APP_NAME = 'Aelix Studio';
export const APP_ID = 'ai.aelix.studio';
export const APP_SLUG = 'aelix-studio';

/** Standalone WebUI shares this directory with its offline password reset command. */
export function getStandaloneWebDataFolder(production: boolean, multiInstance = false): string {
  const suffix = production ? '' : multiInstance ? '-dev-2' : '-dev';
  return `.${APP_SLUG}-web${suffix}`;
}
