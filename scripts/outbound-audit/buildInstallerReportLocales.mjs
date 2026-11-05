/** Mirror existing translated report keys for the standalone Windows installer helper. */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const config = JSON.parse(
  fs.readFileSync(path.join(root, 'packages/desktop/src/common/config/i18n-config.json'), 'utf8')
);
const keys = ['bugReportSuccess', 'bugReportError'];
const output = Object.fromEntries(
  config.supportedLanguages.map((language) => {
    const settings = JSON.parse(
      fs.readFileSync(
        path.join(root, 'packages/desktop/src/renderer/services/i18n/locales', language, 'settings.json'),
        'utf8'
      )
    );
    return [language, Object.fromEntries(keys.map((key) => [`settings.${key}`, settings[key]]))];
  })
);
fs.writeFileSync(
  path.join(root, 'resources/windows/support/report-localization.json'),
  JSON.stringify(output, null, 2) + '\n'
);
