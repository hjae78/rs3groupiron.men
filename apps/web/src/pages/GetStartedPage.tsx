import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  createGroup,
  type GroupShares,
  type GroupVisibility,
} from '../api/groupClient';
import { AuthError, AuthHeader, CountedField } from '../components/AuthFields';
import { DiscoverLink } from '../components/DiscoverLink';
import { LegalFooter } from '../components/LegalFooter';
import { MarketingLayout, useFormTheme } from '../components/MarketingLayout';
import { SetupVideoFrame } from '../components/SetupVideoFrame';
import { ThemeToggle } from '../components/ThemeToggle';
import { TokenReveal } from '../components/TokenReveal';
import { MAX_GROUP_NAME, MAX_NAME, MAX_SLOTS, MIN_SLOTS, PAGE_SEO, TOKEN_HINT } from '../lib/constants';
import { DEFAULT_SHARES, SHARE_FIELDS } from '../lib/groupShares';
import { writeGroupSession } from '../lib/groupSession';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

type MemberField = { id: number; name: string };

let nextFieldId = 0;
function emptyMembers(size: number): MemberField[] {
  return Array.from({ length: size }, () => ({ id: ++nextFieldId, name: '' }));
}

const SLOT_OPTIONS = Array.from({ length: MAX_SLOTS - MIN_SLOTS + 1 }, (_, i) => MIN_SLOTS + i);

const VISIBILITIES: Array<{
  id: GroupVisibility;
  label: string;
  sub: string;
  next: string;
}> = [
  {
    id: 'private',
    label: 'Private',
    sub: 'Only people with your group token can open it.',
    next: 'Change this any time in settings.',
  },
  {
    id: 'public',
    label: 'Public',
    sub: 'Anyone can find your group by name and watch along.',
    next: 'Configure what’s visible next.',
  },
];

const TOKEN_CLASSES = {
  root: 'hero-field',
  label: '',
  row: 'hero-token',
  button: '',
  hint: 'hero-hint',
};

export function GetStartedPage() {
  useDocumentTitle(PAGE_SEO.getStarted.title, {
    canonicalPath: '/get-started',
    description: PAGE_SEO.getStarted.description,
  });
  const navigate = useNavigate();
  const formTheme = useFormTheme();
  const [name, setName] = useState('');
  const [slots, setSlots] = useState(MIN_SLOTS);
  const [visibility, setVisibility] = useState<GroupVisibility>('private');
  const [shares, setShares] = useState<GroupShares>(DEFAULT_SHARES);
  const [members, setMembers] = useState(() => emptyMembers(MIN_SLOTS));
  const [onShares, setOnShares] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const { isBusy, error, setError, run } = useAsyncAction('Could not create group');

  const detailsReady =
    name.trim().length > 0 && members.every((m) => m.name.trim().length > 0);

  function setSlotCount(next: number) {
    setSlots(next);
    setMembers((prev) => {
      if (next === prev.length) return prev;
      if (next > prev.length) return [...prev, ...emptyMembers(next - prev.length)];
      return prev.slice(0, next);
    });
  }

  function setMemberName(id: number, value: string) {
    setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, name: value } : m)));
  }

  function validateDetails(): string[] | null {
    const groupName = name.trim();
    if (groupName.length < 1 || groupName.length > MAX_GROUP_NAME) {
      setError(`Group name must be 1–${MAX_GROUP_NAME} characters`);
      return null;
    }

    const memberNames = members.map((m) => m.name.trim());
    if (memberNames.some((m) => m.length < 1 || m.length > MAX_NAME)) {
      setError(`Each player username must be 1–${MAX_NAME} characters`);
      return null;
    }
    if (new Set(memberNames.map((m) => m.toLowerCase())).size !== memberNames.length) {
      setError('Player usernames must be unique');
      return null;
    }
    return memberNames;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();

    const memberNames = validateDetails();
    if (!memberNames) {
      setOnShares(false);
      return;
    }

    if (visibility === 'public' && !onShares) {
      setError(null);
      setOnShares(true);
      return;
    }

    await run('create', async () => {
      const result = await createGroup({
        name: name.trim(),
        member_slots: slots,
        member_names: memberNames,
        visibility,
        shares,
      });
      setCreated({ name: result.name, token: result.token });
    });
  }

  function goToGroup() {
    if (!created) return;
    writeGroupSession({ name: created.name, token: created.token });
    navigate('/group', { replace: true });
  }

  if (created) {
    return (
      <MarketingLayout
        topRight={
          <>
            <DiscoverLink />
            <ThemeToggle />
          </>
        }
      >
        <div className="hero-col hero-col--wide hero-stagger">
          <AuthHeader />

          <div className={formTheme}>
            <div className="hero-card">
              <h1>You&apos;re set</h1>
              <p className="hero-card-lead">
                Save your token and watch the setup video, then jump into{' '}
                <strong>{created.name}</strong>.
              </p>

              {error && <AuthError>{error}</AuthError>}

              <TokenReveal
                token={created.token}
                label="GROUP TOKEN"
                classNames={TOKEN_CLASSES}
                onCopyError={setError}
                hint={TOKEN_HINT}
              />

              <div className="hero-field">
                HOW TO SET UP
                <div className="hero-video">
                  <SetupVideoFrame />
                </div>
              </div>

              <button
                type="button"
                className="hero-submit hero-submit--ready"
                onClick={goToGroup}
              >
                Go to group
              </button>
            </div>
          </div>
        </div>
      </MarketingLayout>
    );
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
      <div className="hero-col hero-col--wide hero-stagger">
        <AuthHeader />

        <h1 className="hero-title">{onShares ? 'What to share' : 'Create your group'}</h1>
        <p className="hero-lead">
          {onShares
            ? `“${name.trim()}” will be public. Choose what visitors can see.`
            : 'Name it, size it, add your crew.'}
        </p>

        <div className={formTheme}>
          <form className="hero-card" onSubmit={(e) => void onSubmit(e)}>
            {onShares ? (
              <SharesPage
                busy={isBusy}
                error={error}
                shares={shares}
                onToggle={(key, on) => setShares((prev) => ({ ...prev, [key]: on }))}
                onBack={() => {
                  setError(null);
                  setOnShares(false);
                }}
              />
            ) : (
              <DetailsPage
                busy={isBusy}
                error={error}
                name={name}
                slots={slots}
                visibility={visibility}
                members={members}
                ready={detailsReady}
                onName={setName}
                onSlots={setSlotCount}
                onVisibility={setVisibility}
                onMemberName={setMemberName}
              />
            )}
          </form>
        </div>

        <p className="hero-consent">
          By creating a group you accept our <Link to="/terms">terms of use</Link> and{' '}
          <Link to="/privacy">privacy notice</Link>, and you confirm that every player you
          added has agreed to their in-game data being tracked. Any member can stop sharing
          their location, and you can erase everything from Settings at any time.
        </p>

        <p className="hero-foot">
          Already have a group? <Link to="/login">Log in</Link>
        </p>

        <LegalFooter />
      </div>
    </MarketingLayout>
  );
}

type DetailsPageProps = {
  busy: boolean;
  error: string | null;
  name: string;
  slots: number;
  visibility: GroupVisibility;
  members: MemberField[];
  ready: boolean;
  onName: (value: string) => void;
  onSlots: (value: number) => void;
  onVisibility: (visibility: GroupVisibility) => void;
  onMemberName: (id: number, value: string) => void;
};

function DetailsPage({
  busy,
  error,
  name,
  slots,
  visibility,
  members,
  ready,
  onName,
  onSlots,
  onVisibility,
  onMemberName,
}: DetailsPageProps) {
  return (
    <>
      <div className="hero-field">
        GROUP NAME
        <div className="hero-row">
          <CountedField
            label=""
            className="hero-field--grow"
            value={name}
            max={MAX_GROUP_NAME}
            disabled={busy}
            autoFocus
            autoComplete="off"
            aria-label="Group name"
            placeholder={`1–${MAX_GROUP_NAME} characters`}
            onChange={onName}
          />
        </div>
      </div>

      <div className="hero-field">
        GROUP SIZE
        <div className="hero-sizes" role="radiogroup" aria-label="Group size">
          {SLOT_OPTIONS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              className="hero-size"
              aria-checked={slots === value}
              aria-label={`${value} players`}
              disabled={busy}
              onClick={() => onSlots(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <div className="hero-field">
        WHO CAN SEE IT
        <div className="hero-choices" role="radiogroup" aria-label="Who can see it">
          {VISIBILITIES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={visibility === option.id}
              className={
                visibility === option.id ? 'hero-choice hero-choice--active' : 'hero-choice'
              }
              disabled={busy}
              onClick={() => onVisibility(option.id)}
            >
              <span className="hero-choice-radio" aria-hidden />
              <span className="hero-choice-text">
                <strong>{option.label}</strong>
                <em>{option.sub}</em>
                <em className="hero-choice-next">{option.next}</em>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="hero-field">
        MEMBERS
        <span className="hero-hint">
          RuneScape usernames — {slots} players, 1–{MAX_NAME} chars each.
        </span>
        <div className="hero-players">
          {members.map((member, index) => (
            <CountedField
              key={member.id}
              label={`PLAYER ${index + 1}`}
              value={member.name}
              max={MAX_NAME}
              disabled={busy}
              autoComplete="off"
              placeholder="Username"
              onChange={(value) => onMemberName(member.id, value)}
            />
          ))}
        </div>
      </div>

      {error && <AuthError>{error}</AuthError>}

      <button
        type="submit"
        className={ready ? 'hero-submit hero-submit--ready' : 'hero-submit'}
        disabled={!ready || busy}
      >
        {visibility === 'public' ? 'Continue' : busy ? 'Creating…' : 'Create group'}
      </button>
    </>
  );
}

type SharesPageProps = {
  busy: boolean;
  error: string | null;
  shares: GroupShares;
  onToggle: (key: keyof GroupShares, on: boolean) => void;
  onBack: () => void;
};

function SharesPage({ busy, error, shares, onToggle, onBack }: SharesPageProps) {
  return (
    <>
      <div className="hero-field">
        <span className="hero-hint">
          Untick anything you would rather keep to the group. The live map starts off
          because it shows where each member is standing right now, while the rest is a
          record of what they have done. All of this can be changed later in settings.
        </span>
        <div className="hero-shares">
          {SHARE_FIELDS.map((field) => (
            <label key={field.key} className="hero-share">
              <input
                type="checkbox"
                checked={shares[field.key]}
                disabled={busy}
                onChange={(e) => onToggle(field.key, e.target.checked)}
              />
              <span className="hero-share-text">
                <strong>{field.label}</strong>
                <em>{field.hint}</em>
              </span>
            </label>
          ))}
        </div>
      </div>

      {error && <AuthError>{error}</AuthError>}

      <div className="hero-steps">
        <button type="button" className="hero-step-back" disabled={busy} onClick={onBack}>
          ← Back
        </button>
        <button type="submit" className="hero-submit hero-submit--ready" disabled={busy}>
          {busy ? 'Creating…' : 'Create group'}
        </button>
      </div>
    </>
  );
}
