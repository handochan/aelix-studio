import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/renderer/services/i18n', () => ({ changeLanguage: vi.fn() }));
vi.mock('@renderer/components/layout/AppLoader', () => ({ default: () => null }));
vi.mock('@/renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ status: 'unauthenticated', login: vi.fn() }),
}));

import LoginPage from '@/renderer/pages/login';

describe('Login page brand', () => {
  it('shows the official Aelix lockup for each appearance and keeps the product heading', () => {
    render(<LoginPage />);

    const lockups = screen.getAllByAltText('login.brand') as HTMLImageElement[];
    expect(lockups.map((img) => img.className)).toEqual(['aelix-lockup--light', 'aelix-lockup--dark']);
    // Vitest inlines the SVGs: the light lockup carries ink letters, the dark one paper letters.
    const [lightSrc, darkSrc] = lockups.map((img) => decodeURIComponent(img.getAttribute('src') ?? ''));
    expect(lightSrc).toContain("viewBox='0 0 952 272'");
    expect(lightSrc).toContain('#0B1220');
    expect(darkSrc).toContain('#F6FAFB');
    expect(screen.getByRole('heading', { level: 1, name: 'login.brand' })).toBeInTheDocument();
  });
});
