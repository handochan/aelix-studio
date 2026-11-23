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

  it('does not carry the keychain choice of one question over to the question that takes its place', () => {
    const onDone = vi.fn();
    const props = { visible: true, reason: 'required' as const, mode: 'keychain' as const, onDone };
    const view = render(<CredentialsPrompt {...props} question={{ id: 21 }} proxy='http://old.proxy:3128' />);
    fireEvent.click(screen.getByText('settings.agentExtensions.credentials.save'));
    view.rerender(<CredentialsPrompt {...props} question={{ id: 22 }} proxy='http://new.proxy:3128' />);
    fireEvent.change(screen.getByTestId('credentials-username'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByTestId('credentials-password'), { target: { value: 'new-secret' } });
    fireEvent.click(screen.getByTestId('credentials-submit'));
    expect(onDone).toHaveBeenCalledWith({ credentials: { username: 'ops', password: 'new-secret' }, save: false });
  });

  it('keeps the keychain choice the user made for the question in front of them', () => {
    const onDone = vi.fn();
    const props = { visible: true, reason: 'required' as const, mode: 'keychain' as const, onDone };
    render(<CredentialsPrompt {...props} question={{ id: 23 }} proxy='http://proxy:3128' />);
    fireEvent.click(screen.getByText('settings.agentExtensions.credentials.save'));
    fireEvent.change(screen.getByTestId('credentials-username'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByTestId('credentials-password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByTestId('credentials-submit'));
    expect(onDone).toHaveBeenCalledWith({ credentials: { username: 'ops', password: 'secret' }, save: true });
  });
});
