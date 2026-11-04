import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { fetchGroupInfo } from '../api/groupClient';
import { AuthError, AuthHeader, CountedField } from '../components/AuthFields';
import { DiscoverLink } from '../components/DiscoverLink';
import { LegalFooter } from '../components/LegalFooter';
import { MarketingLayout, useFormTheme } from '../components/MarketingLayout';
import { ThemeToggle } from '../components/ThemeToggle';
import { MAX_GROUP_NAME, PAGE_SEO } from '../lib/constants';
import { writeGroupSession } from '../lib/groupSession';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function LoginPage() {
  useDocumentTitle(PAGE_SEO.login.title, {
    canonicalPath: '/login',
    description: PAGE_SEO.login.description,
  });
  const navigate = useNavigate();
  const formTheme = useFormTheme();
  const [params] = useSearchParams();
  const prefilled = (params.get('name') ?? '').slice(0, MAX_GROUP_NAME);
  const [name, setName] = useState(prefilled);
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const { isBusy, error, setError, run } = useAsyncAction('Could not log in');

  const ready = name.trim().length > 0 && token.trim().length > 0;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const groupName = name.trim();
    const groupToken = token.trim();

    if (groupName.length < 1 || groupName.length > MAX_GROUP_NAME) {
      setError(`Group name must be 1–${MAX_GROUP_NAME} characters`);
      return;
    }
    if (!groupToken) {
      setError('Group token is required');
      return;
    }

    await run('login', async () => {
      const info = await fetchGroupInfo(groupName, groupToken);
      writeGroupSession({ name: info.name, token: info.token ?? groupToken });
      navigate('/group', { replace: true });
    });
  }

  return (
    <MarketingLayout
      topRight={
        <>
          <DiscoverLink />
          <ThemeToggle />
        </>
      }
    >
      <div className="hero-col hero-stagger">
        <AuthHeader />

        <h1 className="hero-title">Login</h1>
        <p className="hero-lead">
          Enter your group name and token to continue.
        </p>

        <div className={formTheme}>
          <form className="hero-card" onSubmit={(e) => void onSubmit(e)}>
            <CountedField
              label="GROUP NAME"
              value={name}
              max={MAX_GROUP_NAME}
              disabled={isBusy}
              autoFocus={!prefilled}
              autoComplete="username"
              placeholder={`1–${MAX_GROUP_NAME} characters`}
              onChange={setName}
            />

            <CountedField
              label="GROUP TOKEN"
              value={token}
              max={200}
              type={showToken ? 'text' : 'password'}
              disabled={isBusy}
              autoFocus={Boolean(prefilled)}
              autoComplete="current-password"
              spellCheck={false}
              placeholder="Paste your group token"
              onChange={setToken}
              trailing={
                <button
                  type="button"
                  className="hero-reveal"
                  aria-pressed={showToken}
                  aria-label={showToken ? 'Hide token' : 'Show token'}
                  onClick={() => setShowToken((v) => !v)}
                >
                  {showToken ? 'Hide' : 'Show'}
                </button>
              }
            />

            {error && <AuthError>{error}</AuthError>}

            <button
              type="submit"
              className={
                ready ? 'hero-submit hero-submit--ready' : 'hero-submit'
              }
              disabled={!ready || isBusy}
            >
              {isBusy ? 'Signing in…' : 'Go to group'}
            </button>
          </form>
        </div>

        <p className="hero-foot">
          New here? <Link to="/get-started">Create a group</Link>
        </p>

        <LegalFooter />
      </div>
    </MarketingLayout>
  );
}
