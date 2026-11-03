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
