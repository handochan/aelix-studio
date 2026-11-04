import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const localModule = '@/renderer/pages/conversation/Preview/components/editors/localMonaco';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => vi.resetModules());
afterEach(() => {
  cleanup();
  vi.doUnmock(localModule);
});
describe('local Monaco editor', () => {
  it('loads the local component and forwards editor contents', async () => {
    vi.doMock(localModule, () => ({
      default: ({ value }: { value: string }) => <div data-testid='local-editor'>{value}</div>,
    }));
    const { default: Editor } =
      await import('@/renderer/pages/conversation/Preview/components/editors/OfflineMonacoEditor');
    render(<Editor value='<h1>offline</h1>' />);
    expect(await screen.findByTestId('local-editor')).toHaveTextContent('<h1>offline</h1>');
  });
  it('explains an unavailable local bundle without falling back to a CDN', async () => {
    vi.doMock(localModule, () => {
      throw new Error('missing local chunk');
    });
    const { default: Editor } =
      await import('@/renderer/pages/conversation/Preview/components/editors/OfflineMonacoEditor');
    render(<Editor />);
    expect(await screen.findByRole('alert')).toHaveTextContent('preview.localEditorUnavailable');
  });
});
