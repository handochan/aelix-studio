import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserViewer from '@/renderer/pages/conversation/Preview/browser/BrowserViewer';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), info: vi.fn(), getOfflineMode: vi.fn() }));
vi.mock('@/common', () => ({ ipcBridge: { systemSettings: { getOfflineMode: { invoke: mocks.getOfflineMode } } } }));

let resolveInput: (raw: string) => string | null;
vi.mock('@arco-design/web-react', () => ({ Modal: { confirm: mocks.confirm }, Message: { info: mocks.info } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/components/media/WebviewHost', () => ({
  default: ({ resolveUrlInput, url }: { resolveUrlInput: typeof resolveInput; url: string }) => {
    resolveInput = resolveUrlInput;
    return <div data-testid='browser-guest'>{url}</div>;
  },
}));
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.getOfflineMode.mockResolvedValue(false);
});
afterEach(cleanup);
const setup = () => {
  const navigate = vi.fn();
  const props = {
    tabId: 'tab',
    url: 'about:blank',
    onUrlChange: navigate,
    onTitleChange: vi.fn(),
    onFaviconChange: vi.fn(),
  };
  const view = render(<BrowserViewer {...props} />);
  return { navigate, view, props };
};
describe('first-use Bing permission', () => {
  it('keeps explicit URLs and IPv6 endpoints usable without a search prompt', () => {
    setup();
    expect(resolveInput('https://[::1]:8080/path')).toBe('https://[::1]:8080/path');
    expect(resolveInput('example.com')).toBe('https://example.com');
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('does not navigate or save consent when a search is declined and explains why', () => {
    const { navigate } = setup();
    expect(resolveInput('private question')).toBeNull();
    mocks.confirm.mock.calls[0][0].onCancel();
    expect(navigate).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith('preview.browser.searchDeclined');
    expect(localStorage.getItem('studio.bingSearchConsent')).toBeNull();
  });
  it('sends a query only after approval and remembers it for the next view', () => {
    const { navigate, view } = setup();
    expect(resolveInput('hello world')).toBeNull();
    mocks.confirm.mock.calls[0][0].onOk();
    expect(navigate).toHaveBeenCalledWith('tab', 'https://www.bing.com/search?q=hello%20world');
    view.unmount();
    setup();
    expect(resolveInput('again')).toBe('https://www.bing.com/search?q=again');
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });
  it('does not navigate a stale query after the user chose a URL', () => {
    const { navigate } = setup();
    resolveInput('old question');
    resolveInput('https://intranet.example');
    mocks.confirm.mock.calls[0][0].onOk();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('saved browser addresses', () => {
  it.each([true, false])('checks policy before trying a saved page (offline mode %s)', async (offline) => {
    mocks.getOfflineMode.mockResolvedValue(offline);
    render(
      <BrowserViewer
        url='http://127.0.0.1/possibly-redirects'
        restoreAddress
        tabId='saved'
        onUrlChange={vi.fn()}
        onTitleChange={vi.fn()}
        onFaviconChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('browser-guest')).toHaveTextContent('about:blank');
    await waitFor(() =>
      expect(screen.getByTestId('browser-guest')).toHaveTextContent(
        offline ? 'about:blank' : 'http://127.0.0.1/possibly-redirects'
      )
    );
    expect(resolveInput('http://127.0.0.1/explicit')).toBe('http://127.0.0.1/explicit');
  });
});
