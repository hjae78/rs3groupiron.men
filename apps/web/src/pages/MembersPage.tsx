import { useEffect, useState, type FormEvent } from 'react';
import {
  cancelPlayerDeletion,
  downloadMyDataArchive,
  fetchMe,
  listSessions,
  logoutPlayer,
  redeemVerificationToken,
  requestPlayerDeletion,
  revokeSession,
  rotateToken,
  type PlayerProfile,
  type PlayerSession,
} from '../api/playerClient';
import { AuthError, AuthHeader, CountedField } from '../components/AuthFields';
import { LegalFooter } from '../components/LegalFooter';
import { MarketingLayout, useFormTheme } from '../components/MarketingLayout';
import { ThemeToggle } from '../components/ThemeToggle';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { MAX_NAME } from '../lib/constants';
import {
  clearPlayerSession,
  readPlayerSession,
  writePlayerSession,
} from '../lib/playerSession';

const CODE_LENGTH = 36;

const DELETE_WIPES = [
  'Your membership in every group — not just this one',
  'All skills, XP history, inventories, quests and achievements tied to you',
  'Your verification status and access sessions',
];

export function MembersPage() {
  useDocumentTitle('Your account', {
    canonicalPath: '/members',
    description: 'Manage your verified RuneScape account and your group.',
    noindex: true,
  });
  const formTheme = useFormTheme();

  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [sessions, setSessions] = useState<PlayerSession[]>([]);
  const [restoring, setRestoring] = useState(true);
  const { isBusy, error, setError, run } = useAsyncAction(
    'Could not verify that code',
  );

  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);
  const [confirmUsername, setConfirmUsername] = useState('');
  const {
    isBusy: deleteBusy,
    error: deleteError,
    run: runDelete,
  } = useAsyncAction('Could not request deletion');
  const {
    isBusy: cancelDeleteBusy,
    error: cancelDeleteError,
    run: runCancelDelete,
  } = useAsyncAction('Could not cancel deletion');

  const {
    isBusy: dataBusy,
    error: dataError,
    run: runDownloadData,
  } = useAsyncAction('Could not download your data');

  const { run: runRevoke } = useAsyncAction('Could not revoke that session');
  const {
    isBusy: rotateBusy,
    error: rotateError,
    run: runRotate,
  } = useAsyncAction('Could not regenerate your token');

  const [tab, setTab] = useState<'sessions' | 'data'>('sessions');

  const ready = code.trim().length > 0 && username.trim().length > 0;
  const deleteReady =
    confirmUsername.trim().toLowerCase() ===
    profile?.current_username.trim().toLowerCase();

  async function loadPortal(token: string) {
    const [me, mySessions] = await Promise.all([
      fetchMe(token),
      listSessions(token),
    ]);
    setProfile(me);
    setSessions(mySessions);
    setAccessToken(token);
  }

  useEffect(() => {
    const session = readPlayerSession();
    if (!session) {
      setRestoring(false);
      return;
    }
    loadPortal(session.token)
      .catch(() => clearPlayerSession())
      .finally(() => setRestoring(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedCode = code.trim();
    const trimmedName = username.trim();
    if (!trimmedCode) {
      setError('Paste the code shown in the plugin.');
      return;
    }
    if (!trimmedName) {
      setError('Enter the RuneScape username the code was issued for.');
      return;
    }

    await run('verify', async () => {
      const verified = await redeemVerificationToken(trimmedCode, trimmedName);
      writePlayerSession({
        token: verified.access_token,
        expiresAt: verified.access_token_expires_at,
      });
      await loadPortal(verified.access_token);
    });
  }

  async function onConfirmDelete(e: FormEvent) {
    e.preventDefault();
    if (!deleteReady) return;

    await runDelete('delete', async () => {
      const deletion = await requestPlayerDeletion(
        accessToken,
        confirmUsername.trim(),
      );
      setProfile((prev) => (prev ? { ...prev, deletion } : prev));
      setDeleteStep(0);
      setConfirmUsername('');
    });
  }

  async function onCancelDeletion() {
    await runCancelDelete('cancel-delete', async () => {
      const deletion = await cancelPlayerDeletion(accessToken);
      setProfile((prev) => (prev ? { ...prev, deletion } : prev));
    });
  }

  async function onDownloadData() {
    await runDownloadData('data', async () => {
      await downloadMyDataArchive(accessToken);
    });
  }

  async function onRevokeSession(id: string, isCurrent: boolean) {
    await runRevoke('revoke', async () => {
      await revokeSession(accessToken, id);
      if (isCurrent) {
        clearPlayerSession();
        setProfile(null);
        setSessions([]);
        setAccessToken('');
        return;
      }
      setSessions((prev) => prev.filter((s) => s.id !== id));
    });
  }

  async function onRotateToken() {
    await runRotate('rotate', async () => {
      const next = await rotateToken(accessToken);
      writePlayerSession({
        token: next.access_token,
        expiresAt: next.access_token_expires_at,
      });
      setAccessToken(next.access_token);
      setSessions(await listSessions(next.access_token));
    });
  }

  async function onSignOut() {
    await logoutPlayer(accessToken).catch(() => {});
    clearPlayerSession();
    setProfile(null);
    setSessions([]);
    setAccessToken('');
  }

  return (
    <MarketingLayout topRight={<ThemeToggle />}>
      <div className="hero-col hero-col--wide hero-stagger">
        <AuthHeader />

        <h1 className="hero-title">Your account</h1>
        <p className="hero-lead">
          {profile
            ? 'Manage your verified RuneScape account across every group.'
            : 'Paste the code the plugin showed you after selecting Verify from its Settings icon.'}
        </p>

        <div className={formTheme}>
          {restoring ? (
            <div className="hero-card">
              <p>Loading…</p>
            </div>
          ) : profile ? (
            <div className="hero-card">
              <div className="hero-tabs">
                <button
                  type="button"
                  className={
                    tab === 'sessions'
                      ? 'hero-tab hero-tab--active'
                      : 'hero-tab'
                  }
                  onClick={() => setTab('sessions')}
                >
                  Sessions
                </button>
                <button
                  type="button"
                  className={
                    tab === 'data' ? 'hero-tab hero-tab--active' : 'hero-tab'
                  }
                  onClick={() => setTab('data')}
                >
                  Your data
                </button>
              </div>

              {tab === 'sessions' && (
                <div>
                  <p className="hero-center hero-username">
                    {profile.current_username}
                  </p>
                  <p className="hero-center hero-hint">
                    Verified RuneScape account owner.
                  </p>
                  <p className="hero-hint">
                    This confirms you held a group&rsquo;s token and ran the
                    plugin while logged in as this character — it is not proof
                    of RuneScape account ownership beyond that.
                  </p>

                  <dl className="hero-hint">
                    <dt>Verified</dt>
                    <dd className="hero-accent">
                      {profile.verified_at
                        ? new Date(profile.verified_at).toLocaleString()
                        : 'unknown'}
                    </dd>
                    {profile.previous_usernames.length > 0 && (
                      <>
                        <dt>Previous usernames</dt>
                        <dd>{profile.previous_usernames.join(', ')}</dd>
                      </>
                    )}
                  </dl>

                  <hr className="hero-divider" />

                  <p className="hero-hint">
                    Every device currently signed in to your account. Revoking a
                    session signs that device out immediately.
                  </p>
                  <ul className="hero-session-list">
                    {sessions.map((s) => (
                      <li key={s.id} className="hero-session-item">
                        <p className="hero-hint">
                          {s.current ? 'This device' : 'Other device'} — issued{' '}
                          {new Date(s.created_at).toLocaleString()}, expires{' '}
                          {new Date(s.expires_at).toLocaleString()}
                        </p>
                        <button
                          type="button"
                          className="hero-session-revoke"
                          onClick={() => void onRevokeSession(s.id, s.current)}
                        >
                          Revoke
                        </button>
                      </li>
                    ))}
                  </ul>

                  <hr className="hero-divider" />

                  <p className="hero-hint">
                    Regenerating replaces the session you&rsquo;re using right
                    now with a new one — use this if this device&rsquo;s token
                    may have leaked, or you just want a fresh one.
                  </p>
                  {rotateError && <AuthError>{rotateError}</AuthError>}
                  <div className="hero-inline-actions">
                    <button
                      type="button"
                      className="hero-submit"
                      onClick={() => void onSignOut()}
                    >
                      Sign out
                    </button>
                    <button
                      type="button"
                      className="hero-submit"
                      onClick={() => void onRotateToken()}
                      disabled={rotateBusy}
                    >
                      {rotateBusy ? 'Regenerating…' : 'Regenerate token'}
                    </button>
                  </div>
                </div>
              )}

              {tab === 'data' && (
                <div>
                  <p className="hero-hint">
                    Everything we hold on you — your current group, plus any
                    you've previously left.
                  </p>
                  {dataError && <AuthError>{dataError}</AuthError>}
                  <button
                    type="button"
                    className="hero-submit"
                    onClick={() => void onDownloadData()}
                    disabled={dataBusy}
                  >
                    {dataBusy ? 'Preparing…' : 'Download data (.zip)'}
                  </button>

                  <hr className="hero-divider" />

                  {profile.deletion.pending ? (
                    <div className="hero-pending-banner">
                      <p>
                        Your data will be deleted on{' '}
                        {profile.deletion.delete_after
                          ? new Date(
                              profile.deletion.delete_after,
                            ).toLocaleString()
                          : 'unknown'}
                        . You can still use your account until then.
                      </p>
                      {cancelDeleteError && (
                        <AuthError>{cancelDeleteError}</AuthError>
                      )}
                      <button
                        type="button"
                        className="hero-submit"
                        onClick={() => void onCancelDeletion()}
                        disabled={cancelDeleteBusy}
                      >
                        {cancelDeleteBusy ? 'Cancelling…' : 'Cancel deletion'}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="hero-submit hero-submit--danger"
                      onClick={() => setDeleteStep(1)}
                    >
                      Delete my data
                    </button>
                  )}
                </div>
              )}

              {deleteStep > 0 && (
                <div className="hero-overlay-backdrop">
                  <div className="hero-card hero-overlay-card">
                    {deleteStep === 1 && (
                      <>
                        <h2 className="hero-title">Delete my data</h2>
                        <p>This erases, across every group you belong to:</p>
                        <ul>
                          {DELETE_WIPES.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                        <p className="hero-hint">
                          The account keeps working for 24 hours after you
                          confirm, then everything is purged. You can cancel
                          from this page at any point before then.
                        </p>
                        <div className="hero-inline-actions">
                          <button
                            type="button"
                            className="hero-submit"
                            onClick={() => setDeleteStep(0)}
                          >
                            Keep my data
                          </button>
                          <button
                            type="button"
                            className="hero-submit hero-submit--danger"
                            onClick={() => setDeleteStep(2)}
                          >
                            I understand, continue
                          </button>
                        </div>
                      </>
                    )}

                    {deleteStep === 2 && (
                      <form onSubmit={(e) => void onConfirmDelete(e)}>
                        <h2 className="hero-title">Confirm deletion</h2>
                        <CountedField
                          label={`RETYPE "${profile.current_username}" TO CONFIRM`}
                          value={confirmUsername}
                          max={MAX_NAME}
                          disabled={deleteBusy}
                          autoFocus
                          autoComplete="off"
                          spellCheck={false}
                          onChange={setConfirmUsername}
                        />
                        {deleteError && <AuthError>{deleteError}</AuthError>}
                        <div className="hero-inline-actions">
                          <button
                            type="button"
                            className="hero-submit"
                            onClick={() => setDeleteStep(1)}
                          >
                            ← Back
                          </button>
                          <button
                            type="submit"
                            className={
                              deleteReady
                                ? 'hero-submit hero-submit--danger'
                                : 'hero-submit'
                            }
                            disabled={!deleteReady || deleteBusy}
                          >
                            {deleteBusy ? 'Deleting…' : 'Start 24h deletion'}
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <form className="hero-card" onSubmit={(e) => void onSubmit(e)}>
              <CountedField
                label="RUNESCAPE USERNAME"
                value={username}
                max={MAX_NAME}
                disabled={isBusy}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder="The account the code was issued for"
                onChange={setUsername}
              />

              <CountedField
                label="VERIFICATION CODE"
                value={code}
                max={CODE_LENGTH}
                disabled={isBusy}
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste the code from the plugin"
                onChange={setCode}
              />

              {error && <AuthError>{error}</AuthError>}

              <button
                type="submit"
                className={
                  ready ? 'hero-submit hero-submit--ready' : 'hero-submit'
                }
                disabled={!ready || isBusy}
              >
                {isBusy ? 'Verifying…' : 'Verify'}
              </button>

              <p className="hero-hint">
                Don&rsquo;t have a code, or did yours expire? Open the plugin
                in-game, select the Settings icon, then Verify — it generates a
                fresh code every time, with no limit on retries.
              </p>
            </form>
          )}
        </div>

        <LegalFooter />
      </div>
    </MarketingLayout>
  );
}
