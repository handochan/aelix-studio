import { describe, expect, it, vi } from 'vitest';

const { setPreference } = vi.hoisted(() => ({ setPreference: vi.fn() }));
vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { get: vi.fn().mockResolvedValue(undefined), set: setPreference },
}));
import mainI18n, { getRecoveryNoticeTranslator, i18nReady } from '@/process/services/i18n';

describe('recovery notice language', () => {
  it.each([
    [undefined, 'ko-KR', '설정을 복구하지 못해 초기화했습니다.'],
    [undefined, 'ko_KR', '설정을 복구하지 못해 초기화했습니다.'],
    [undefined, 'it-IT', 'Your settings could not be recovered and were reset.'],
    ['ja-JP', 'ko-KR', '設定を復元できなかったため、初期化しました。'],
  ] as const)(
    'selects the notice for saved=%s and OS=%s without saving the OS hint',
    async (saved, system, message) => {
      await i18nReady;
      const previousLanguage = mainI18n.language;
      const translate = await getRecoveryNoticeTranslator(saved, system);
      expect(translate('common.configurationRecovery.message')).toBe(message);
      expect(mainI18n.language).toBe(previousLanguage);
      expect(setPreference).not.toHaveBeenCalled();
    }
  );
});
