import loginLogo from '@renderer/assets/logos/brand/app.png';
import { Alert, Button, Checkbox, Input, Select } from '@arco-design/web-react';
import { Lock, User } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import i18nConfig from '@/common/config/i18n-config.json';
import { changeLanguage } from '@/renderer/services/i18n';
import AppLoader from '@renderer/components/layout/AppLoader';
import { useAuth } from '../../hooks/context/AuthContext';
import styles from './LoginPage.module.css';

type MessageState = { type: 'error' | 'success'; text: string };

const LoginPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { status, login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [message, setMessage] = useState<MessageState | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Earlier builds stored reversible passwords. Remove them without reading or decoding them.
    localStorage.removeItem('rememberedPassword');
    localStorage.removeItem('rememberedUsername');
    localStorage.removeItem('rememberMe');
  }, []);

  useEffect(() => {
    document.documentElement.lang = i18n.language;
  }, [i18n.language]);

  useEffect(() => {
    if (status === 'authenticated') void navigate('/guid', { replace: true });
  }, [navigate, status]);

  const supportedLanguages = useMemo(
    () =>
      i18nConfig.supportedLanguages.map((code) => ({
        value: code,
        label: new Intl.DisplayNames([code], { type: 'language' }).of(code) || code,
      })),
    []
  );

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (loading) return;
      const trimmedUsername = username.trim();
      if (!trimmedUsername || !password) {
        setMessage({ type: 'error', text: t('login.errors.empty') });
        return;
      }
      setLoading(true);
      setMessage(null);
      try {
        // Remember controls the server session lifetime; credentials never enter browser storage.
        const result = await login({ username: trimmedUsername, password, remember: rememberMe });
        if (result.success) {
          setPassword('');
          setMessage({ type: 'success', text: t('login.success') });
          void navigate('/guid', { replace: true });
        } else {
          const errors = {
            invalidCredentials: t('login.errors.invalidCredentials'),
            tooManyAttempts: t('login.errors.tooManyAttempts'),
            networkError: t('login.errors.networkError'),
            serverError: t('login.errors.serverError'),
            csrfError: t('login.errors.unknown'),
            unknown: t('login.errors.unknown'),
          };
          setMessage({ type: 'error', text: errors[result.code || 'unknown'] });
        }
      } catch {
        setMessage({ type: 'error', text: t('login.errors.networkError') });
      } finally {
        setLoading(false);
      }
    },
    [loading, login, navigate, password, rememberMe, t, username]
  );

  if (status === 'checking') return <AppLoader />;

  return (
    <main className='min-h-100vh box-border flex items-center justify-center bg-base text-t-primary p-20px'>
      <section className={styles.card} aria-labelledby='login-title'>
        <Select
          aria-label={t('login.languageToggle')}
          value={i18n.language}
          options={supportedLanguages}
          onChange={(language: string) => {
            void changeLanguage(language);
          }}
        />
        <header className='text-center my-24px'>
          <img src={loginLogo} alt={t('login.brand')} className='w-64px h-64px object-contain' />
          <h1 id='login-title' className='text-24px font-600'>
            {t('login.brand')}
          </h1>
          <p className='text-14px text-t-secondary'>{t('login.subtitle')}</p>
        </header>
        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          className='flex flex-col gap-16px'
        >
          <label htmlFor='username'>{t('login.username')}</label>
          <Input
            id='username'
            name='username'
            prefix={<User />}
            autoFocus
            autoComplete='username'
            value={username}
            onChange={setUsername}
            placeholder={t('login.usernamePlaceholder')}
            aria-required='true'
          />
          <label htmlFor='password'>{t('login.password')}</label>
          <Input.Password
            id='password'
            name='password'
            prefix={<Lock />}
            autoComplete='current-password'
            value={password}
            onChange={setPassword}
            placeholder={t('login.passwordPlaceholder')}
            aria-required='true'
          />
          <Checkbox checked={rememberMe} onChange={setRememberMe}>
            {t('login.rememberMe')}
          </Checkbox>
          <Button type='primary' htmlType='submit' long loading={loading}>
            {loading ? t('login.submitting') : t('login.submit')}
          </Button>
          {message && <Alert type={message.type} content={message.text} />}
        </form>
        <footer className='text-center text-12px text-t-tertiary mt-24px'>
          <p>{t('login.footerPrimary')}</p>
          <p>{t('login.footerSecondary')}</p>
        </footer>
      </section>
    </main>
  );
};

export default LoginPage;
