import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ login: vi.fn(), status: 'unauthenticated' }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@/renderer/hooks/context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('@/renderer/services/i18n', () => ({ changeLanguage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/renderer/components/layout/AppLoader', () => ({ default: () => <span>loading</span> }));

import LoginPage from '@/renderer/pages/login';

beforeEach(() => {
  localStorage.clear();
  auth.status = 'unauthenticated';
  auth.login.mockReset();
  navigate.mockClear();
});
afterEach(() => localStorage.clear());

describe('self-hosted login', () => {
  it('removes reversible credentials saved by older builds without refilling the password', () => {
    localStorage.setItem('rememberedPassword', 'legacy-obfuscated-password');
    localStorage.setItem('rememberedUsername', 'legacy-user');
    localStorage.setItem('rememberMe', 'true');
    render(<LoginPage />);
    expect(localStorage.getItem('rememberedPassword')).toBeNull();
    expect(screen.getByLabelText('login.password')).toHaveValue('');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('keeps remember-me on the server session and stores no browser password', async () => {
    auth.login.mockResolvedValue({ success: true });
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText('login.username'), { target: { value: 'operator' } });
    fireEvent.change(screen.getByLabelText('login.password'), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'login.submit' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/guid', { replace: true }));
    expect(auth.login).toHaveBeenCalledWith({ username: 'operator', password: 'test-password', remember: true });
    expect(localStorage.getItem('rememberedPassword')).toBeNull();
  });

  it('shows a failed sign-in and retains the login gate', async () => {
    auth.login.mockResolvedValue({ success: false, code: 'invalidCredentials' });
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText('login.username'), { target: { value: 'operator' } });
    fireEvent.change(screen.getByLabelText('login.password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.submit' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('login.errors.invalidCredentials'));
    expect(navigate).not.toHaveBeenCalled();
  });
});
