import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import MarkdownView from '@/renderer/components/Markdown';
import RemoteImage from '@/renderer/components/Markdown/RemoteImage';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/components/Markdown/CodeBlock', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ openBrowserTab: previewOpen }),
}));
const previewOpen = vi.hoisted(() => vi.fn());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('remote chat images', () => {
  it('loads a linked image without navigating its parent link', () => {
    const view = render(
      <MarkdownView>{'[![Diagram](https://images.example/a.png)](https://other.example)'}</MarkdownView>
    );
    const markdown = within(view.container.querySelector('.markdown-shadow')!.shadowRoot! as unknown as HTMLElement);
    fireEvent.click(markdown.getByRole('button'));
    expect(previewOpen).not.toHaveBeenCalled();
    expect(markdown.getByRole('img')).toHaveAttribute('src', 'https://images.example/a.png');
  });
  it('does not create a network image before the user chooses to download it', () => {
    render(<RemoteImage src='https://images.example/a.png' alt='Diagram' />);
    expect(screen.queryByRole('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /messages.remoteImageLoad.*Diagram/ }));
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://images.example/a.png');
    expect(screen.getByRole('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
  });
  it('requires new consent when a streaming response replaces the source', () => {
    const view = render(<RemoteImage src='https://images.example/a.png' alt='Diagram' />);
    fireEvent.click(screen.getByRole('button'));
    view.rerender(<RemoteImage src='https://images.example/b.png' alt='Diagram' />);
    expect(screen.queryByRole('img')).toBeNull();
    view.rerender(<RemoteImage src='https://images.example/a.png' alt='Diagram' />);
    expect(screen.queryByRole('img')).toBeNull();
  });
  it('keeps malformed remote URLs from crashing the conversation', () => {
    render(<RemoteImage src='https://[' />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('button')).toBeVisible();
  });
  it('shows an image failure and waits for an explicit retry', () => {
    render(<RemoteImage src='//images.example/a.png' alt='Diagram' />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('status')).toHaveTextContent('messages.imageLoadFailed');
    expect(screen.queryByRole('img')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://images.example/a.png');
  });
});
