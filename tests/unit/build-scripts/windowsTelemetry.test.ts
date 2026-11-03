import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('installer telemetry removal', () => {
  it('has no reporting HTTP client, endpoint or device identity in the local exporter', () => {
    const source = readFileSync('resources/windows/support/report-installer-failure.ps1', 'utf8');
    expect(source).not.toMatch(/Invoke-(?:RestMethod|WebRequest)|Sentry|AnalyticsId|\$Dsn/);
    expect(source).toContain('Compress-Archive');
  });
  it('does not pass an endpoint to the installer failure exporter', () => {
    const source = readFileSync('resources/windows/installer-errors-sentry.nsh', 'utf8');
    expect(source).not.toContain('-Dsn');
    expect(source).not.toContain('_sentry-dsn.generated.nsh');
  });
});

describe('installer report localization', () => {
  it('ships the current report strings for every configured locale', () => {
    const config = JSON.parse(readFileSync('packages/desktop/src/common/config/i18n-config.json', 'utf8')) as {
      supportedLanguages: string[];
    };
    const copy = JSON.parse(readFileSync('resources/windows/support/report-localization.json', 'utf8')) as Record<
      string,
      Record<string, string>
    >;
    expect(Object.keys(copy).sort()).toEqual([...config.supportedLanguages].sort());
    for (const language of config.supportedLanguages) {
      const settings = JSON.parse(
        readFileSync(`packages/desktop/src/renderer/services/i18n/locales/${language}/settings.json`, 'utf8')
      ) as Record<string, string>;
      expect(copy[language]).toEqual({
        'settings.bugReportSuccess': settings.bugReportSuccess,
        'settings.bugReportError': settings.bugReportError,
      });
    }
  });
  it('bundles the localized keys beside the standalone helper', () => {
    expect(readFileSync('resources/windows/installer-errors-sentry.nsh', 'utf8')).toContain(
      'File /oname=$PLUGINSDIR\\report-localization.json'
    );
  });
});
