import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, Mail, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useT } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Mode = 'signin' | 'signup';

export default function Login() {
  const t = useT();
  const { user, signInWithGoogle, signInWithEmail, signUpWithEmail } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [mode, setMode] = useState<Mode>('signin');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** Non-error notice (e.g. "no account found, switched to sign-up"). */
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmSentTo, setConfirmSentTo] = useState<string | null>(null);

  // Google button only shows once you've enabled the provider in Supabase.
  const googleEnabled = import.meta.env.VITE_ENABLE_GOOGLE_AUTH === 'true';

  useEffect(() => {
    if (user) {
      const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/';
      navigate(from, { replace: true });
    }
  }, [user, navigate, location.state]);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setNotice(null);
    setConfirmSentTo(null);
  };

  const onGoogle = async () => {
    setError(null);
    setNotice(null);
    const { error: err } = await signInWithGoogle();
    if (err) setError(err);
    // On success the browser redirects to Google; no further handling needed.
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);

    if (mode === 'signin') {
      const { error: err } = await signInWithEmail(email, password);
      if (err) {
        // Supabase returns a generic "Invalid login credentials" for both a
        // wrong password AND a non-existent account (anti-enumeration). Treat
        // it as "maybe no account" → bounce to sign-up, keep what they typed.
        if (/invalid login credentials/i.test(err)) {
          setMode('signup');
          setNotice(t('login.no_account_switch'));
        } else {
          setError(err);
        }
      }
      setPending(false);
      return;
    }

    // Sign up flow
    if (password.length < 8) {
      setError(t('login.password_min'));
      setPending(false);
      return;
    }
    const { error: err, needsConfirmation } = await signUpWithEmail(email, password, fullName);
    if (err) {
      setError(err);
      setPending(false);
      return;
    }
    if (needsConfirmation) {
      setConfirmSentTo(email);
      setPending(false);
    }
    // else: useEffect above will redirect once `user` populates
  };

  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-2">
      {/* ─── Brand panel ─── */}
      <div className="relative hidden flex-col justify-between bg-foreground p-12 text-background lg:flex">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <span className="text-lg font-bold">M</span>
          </div>
          <span className="text-lg font-bold">Medstocksy Connect</span>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="space-y-6"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">
            {t('login.eyebrow')}
          </p>
          <h1 className="text-5xl font-bold leading-[1.05] tracking-tight">
            {t('login.headline_1')}
            <br />
            <span className="text-primary">{t('login.headline_2')}</span>
          </h1>
          <p className="max-w-md text-base text-muted-foreground">{t('login.tagline')}</p>
        </motion.div>

        <div className="rounded-lg bg-card/10 p-5 backdrop-blur-sm">
          <p className="text-sm leading-relaxed text-muted-foreground">{t('login.testimonial')}</p>
          <div className="mt-4 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
              RA
            </div>
            <div>
              <div className="text-sm font-medium">{t('login.testimonial_author')}</div>
              <div className="text-xs text-muted-foreground">{t('login.testimonial_pharmacy')}</div>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Form panel ─── */}
      <div className="flex items-center justify-center p-6 lg:p-12">
        <AnimatePresence mode="wait">
          {confirmSentTo ? (
            <ConfirmEmailPanel
              email={confirmSentTo}
              onBack={() => {
                setConfirmSentTo(null);
                switchMode('signin');
              }}
            />
          ) : (
            <motion.div
              key="form"
              className="w-full max-w-sm space-y-6"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              {/* Mode tabs */}
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/60 p-1">
                {(['signin', 'signup'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => switchMode(m)}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                      mode === m
                        ? 'bg-background text-foreground shadow-card'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {m === 'signin' ? t('login.tab.signin') : t('login.tab.signup')}
                  </button>
                ))}
              </div>

              <div className="text-center">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {mode === 'signin' ? t('login.welcome_back') : ''}
                </p>
                <h2 className="mt-1 text-2xl font-semibold tracking-tight">
                  {mode === 'signin' ? t('login.title') : t('login.signup_title')}
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {mode === 'signin' ? t('login.subtitle') : t('login.signup_subtitle')}
                </p>
              </div>

              {googleEnabled && (
                <>
                  <Button
                    variant="outline"
                    size="lg"
                    className="w-full gap-3"
                    onClick={onGoogle}
                    disabled={pending}
                    type="button"
                  >
                    <GoogleIcon />
                    {t('login.continue_google')}
                  </Button>

                  <div className="flex items-center gap-3">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-xs text-muted-foreground">{t('login.or_email')}</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                </>
              )}

              {/* Info notice (e.g. auto-switched to sign-up) */}
              {notice && (
                <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
                  {notice}
                </div>
              )}

              <form onSubmit={onSubmit} className="space-y-3">
                {mode === 'signup' && (
                  <div>
                    <label className="mb-1 block text-sm font-medium">{t('login.full_name')}</label>
                    <Input
                      type="text"
                      placeholder="Vaibhav Singh"
                      required
                      autoComplete="name"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      disabled={pending}
                    />
                  </div>
                )}
                <div>
                  <label className="mb-1 block text-sm font-medium">{t('login.email')}</label>
                  <Input
                    type="email"
                    placeholder="you@pharmacy.com"
                    required
                    autoComplete={mode === 'signin' ? 'email' : 'username'}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={pending}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">{t('login.password')}</label>
                  <Input
                    type="password"
                    placeholder={mode === 'signin' ? '••••••••' : 'min. 8 characters'}
                    required
                    minLength={mode === 'signup' ? 8 : undefined}
                    autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={pending}
                  />
                </div>
                {error && (
                  <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
                )}
                <Button type="submit" size="lg" className="w-full" disabled={pending}>
                  {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {pending
                    ? mode === 'signin'
                      ? t('btn.signing_in')
                      : t('login.creating')
                    : mode === 'signin'
                      ? t('login.signin')
                      : t('login.signup')}
                </Button>
              </form>

              <p className="text-center text-xs text-muted-foreground">{t('login.terms')}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function ConfirmEmailPanel({ email, onBack }: { email: string; onBack: () => void }) {
  const t = useT();
  return (
    <motion.div
      key="confirm"
      className="w-full max-w-sm space-y-5 text-center"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
    >
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
        <Mail className="h-6 w-6 text-primary" />
      </div>
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">{t('login.signup_check_email_title')}</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {t('login.signup_check_email_desc').split('{email}').map((part, i, arr) =>
            i < arr.length - 1
              ? [<span key={i}>{part}</span>, <span key={`e${i}`} className="font-mono font-medium text-foreground">{email}</span>]
              : <span key={i}>{part}</span>
          )}
        </p>
      </div>
      <div className="flex items-center justify-center gap-2 rounded-md bg-emerald-500/10 px-4 py-2 text-xs text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Confirmation email sent.
      </div>
      <button
        onClick={onBack}
        className="text-sm font-medium text-primary hover:underline"
      >
        {t('login.back_to_signin')}
      </button>
    </motion.div>
  );
}

function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.5-5.9 7.5-11.3 7.5-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.7 1.1 7.8 2.9l5.7-5.7C34 5.1 29.3 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.2-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 16 19 12 24 12c3 0 5.7 1.1 7.8 2.9l5.7-5.7C34 5.1 29.3 3 24 3 16.3 3 9.7 7.4 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 45c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.4 0-9.9-3.4-11.3-8.1l-6.5 5C9.5 40.5 16.2 45 24 45z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.7 2-2 3.7-3.7 4.9l6.2 5.2c-.4.4 6.6-4.8 6.6-14.1 0-1.2-.1-2.3-.4-3.5z" />
    </svg>
  );
}
