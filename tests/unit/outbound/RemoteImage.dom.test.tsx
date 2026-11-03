import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import RemoteImage from '@/renderer/components/Markdown/RemoteImage';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

describe('remote chat images', () => {
  it('does not create a network image before the user chooses to download it', () => {
    render(<RemoteImage src='https://images.example/a.png' alt='Diagram' />);
    expect(screen.queryByRole('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /common.download.*Diagram/ }));
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
