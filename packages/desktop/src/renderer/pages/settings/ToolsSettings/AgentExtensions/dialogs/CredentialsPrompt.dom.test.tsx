/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import CredentialsPrompt from './CredentialsPrompt';

describe('the credentials dialog', () => {
  it('shows nothing typed for one question in the question that takes its place', () => {
    const props = { visible: true, reason: 'required' as const, mode: 'memory-only' as const, onDone: vi.fn() };
    const view = render(<CredentialsPrompt {...props} question={{ id: 1 }} proxy='http://old.proxy:3128' />);
    fireEvent.change(screen.getByTestId('credentials-username'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByTestId('credentials-password'), { target: { value: 'old-secret' } });
    expect((screen.getByTestId('credentials-password') as HTMLInputElement).value).toBe('old-secret');
    // The proxy changed: a new question, still in the same open dialog.
    view.rerender(<CredentialsPrompt {...props} reason='changed' question={{ id: 2 }} proxy='http://new.proxy:3128' />);
    expect((screen.getByTestId('credentials-password') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('credentials-username') as HTMLInputElement).value).toBe('');
  });

  it('keeps nothing typed for a question once another took its place, even if it comes back', () => {
    const props = { visible: true, reason: 'required' as const, mode: 'memory-only' as const, onDone: vi.fn() };
    const first = { id: 11 };
    const view = render(<CredentialsPrompt {...props} question={first} proxy='http://old.proxy:3128' />);
    fireEvent.change(screen.getByTestId('credentials-password'), { target: { value: 'old-secret' } });
    view.rerender(<CredentialsPrompt {...props} question={{ id: 12 }} proxy='http://new.proxy:3128' />);
    // Shown again with the first question's id: had its typing stayed in state, it would be back.
    view.rerender(<CredentialsPrompt {...props} question={first} proxy='http://old.proxy:3128' />);
    expect((screen.getByTestId('credentials-password') as HTMLInputElement).value).toBe('');
  });
});
