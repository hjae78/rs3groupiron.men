import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  AdminAuthError,
  cancelAdminGroupDeletion,
  deleteAdminGroup,
  fetchAdminOverview,
  pingAdmin,
  scheduleAdminGroupDeletion,
  type AdminGroup,
  type AdminOverview,
} from '../api/adminClient';
import { AdminDailyChart } from './AdminDailyChart';
import { AdminGroupsTable } from './AdminGroupsTable';
import { AdminOverviewTiles } from './AdminOverviewTiles';
import { ThemeToggle } from '../components/ThemeToggle';
import { clearAdminToken, readAdminToken, writeAdminToken } from '../lib/adminSession';
import { DELETION_GRACE_DAYS } from '../lib/constants';
import { errorMessage } from '../lib/errors';
import { formatDate, formatDateTime } from '../lib/format';
import { useAdminGroupsTable } from '../hooks/useAdminGroupsTable';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useResolvedTheme, useUiPrefs } from '../hooks/useUiPrefs';
import '../styles/admin.css';

export function AdminPage() {
  useDocumentTitle('Admin', { noindex: true });
  const { prefs } = useUiPrefs();
  const theme = useResolvedTheme(prefs.themePref) === 'light' ? 'theme-light' : 'theme-dark';
  const [token, setToken] = useState(readAdminToken);

  function signOut() {
    clearAdminToken();
    setToken('');
  }

  return (
    <div className={`adm ${theme}`}>
      {token ? (
        <Dashboard token={token} onSignOut={signOut} />
      ) : (
        <TokenGate
          onToken={(value) => {
            writeAdminToken(value);
            setToken(value);
          }}
        />
      )}
    </div>
  );
}

function TokenGate({ onToken }: { onToken: (token: string) => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const candidate = value.trim();
    if (!candidate) return;
    setBusy(true);
    setError(null);
    try {
      await pingAdmin(candidate);
      onToken(candidate);
    } catch (err) {
      setError(errorMessage(err, 'Could not reach the admin API'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="adm-gate">
      <form className="adm-gate-card" onSubmit={(e) => void onSubmit(e)}>
        <span className="adm-eyebrow">RESTRICTED</span>
        <h1>Admin</h1>
        <p className="adm-note">This area is for the site operator. It needs the admin token.</p>

        <label className="adm-field">
          ADMIN TOKEN
          <input
            type="password"
            value={value}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the admin token"
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>

        {error && <p className="adm-error">{error}</p>}

        <button
          type="submit"
          className="adm-btn adm-btn--primary"
          disabled={busy || !value.trim()}
        >
          {busy ? 'Checking…' : 'Unlock'}
        </button>

        <Link className="adm-note" to="/">
          ← Back to the site
        </Link>
      </form>
    </div>
  );
}

type DashboardProps = {
  token: string;
  onSignOut: () => void;
};

function Dashboard({ token, onSignOut }: DashboardProps) {
  const [days, setDays] = useState<number>(30);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<AdminGroup | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const onFailure = useCallback(
    (err: unknown, fallback: string, setter: (message: string) => void) => {
      if (err instanceof AdminAuthError) {
        clearAdminToken();
        onSignOut();
        return;
      }
      setter(errorMessage(err, fallback));
    },
    [onSignOut],
  );

  const groupsTable = useAdminGroupsTable({ token, reloadKey, onFailure });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setOverview(await fetchAdminOverview(token, days, controller.signal));
        setOverviewError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        onFailure(err, 'Could not load the overview', setOverviewError);
      }
    })();
    return () => controller.abort();
  }, [token, days, reloadKey, onFailure]);

  const runAction = useCallback(
    async (group: AdminGroup, action: () => Promise<unknown>, done: string) => {
      setPendingId(group.id);
      setActionError(null);
      setNotice(null);
      try {
        await action();
        setNotice(done);
        reload();
      } catch (err) {
        onFailure(err, 'That action failed', setActionError);
      } finally {
        setPendingId(null);
      }
    },
    [onFailure, reload],
  );

  const onSchedule = useCallback(
    (group: AdminGroup) =>
      void runAction(
        group,
        () => scheduleAdminGroupDeletion(token, group.id),
        `“${group.name}” is scheduled for erasure in ${DELETION_GRACE_DAYS} days.`,
      ),
    [token, runAction],
  );

  const onCancel = useCallback(
    (group: AdminGroup) =>
      void runAction(
        group,
        () => cancelAdminGroupDeletion(token, group.id),
        `Erasure of “${group.name}” called off.`,
      ),
    [token, runAction],
  );

  return (
    <div className="adm-shell">
      <header className="adm-head">
        <div className="adm-head-text">
          <span className="adm-eyebrow">RS3 GROUP IRONMAN</span>
          <h1 className="adm-h1">Admin</h1>
        </div>
        <div className="adm-head-actions">
          <span className="adm-stamp">Updated {formatDateTime(overview?.at ?? null)}</span>
          <ThemeToggle />
          <button type="button" className="adm-btn" onClick={reload}>
            Refresh
          </button>
          <button type="button" className="adm-btn" onClick={onSignOut}>
            Lock
          </button>
        </div>
      </header>

      {overviewError && <p className="adm-error">{overviewError}</p>}

      <AdminOverviewTiles overview={overview} />

      <AdminDailyChart daily={overview?.daily ?? []} days={days} onDaysChange={setDays} />

      <AdminGroupsTable
        query={groupsTable.query}
        search={groupsTable.search}
        onSearchChange={groupsTable.setSearch}
        filter={groupsTable.filter}
        onFilterChange={groupsTable.onFilterChange}
        sort={groupsTable.sort}
        dir={groupsTable.dir}
        onSort={groupsTable.onSort}
        table={groupsTable.table}
        tableError={groupsTable.tableError}
        loading={groupsTable.loading}
        actionError={actionError}
        notice={notice}
        page={groupsTable.page}
        pages={groupsTable.pages}
        total={groupsTable.total}
        pageSize={groupsTable.pageSize}
        onPageChange={groupsTable.setPage}
        pendingId={pendingId}
        onSchedule={onSchedule}
        onCancel={onCancel}
        onDeleteRequest={setConfirming}
      />

      {confirming && (
        <DeleteDialog
          group={confirming}
          busy={pendingId === confirming.id}
          onClose={() => setConfirming(null)}
          onConfirm={async () => {
            const group = confirming;
            setConfirming(null);
            await runAction(
              group,
              () => deleteAdminGroup(token, group.id),
              `“${group.name}” and everything it held have been erased.`,
            );
          }}
          onSchedule={async () => {
            const group = confirming;
            setConfirming(null);
            await runAction(
              group,
              () => scheduleAdminGroupDeletion(token, group.id),
              `“${group.name}” is scheduled for erasure in ${DELETION_GRACE_DAYS} days.`,
            );
          }}
        />
      )}
    </div>
  );
}

type DeleteDialogProps = {
  group: AdminGroup;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onSchedule: () => void;
};

function DeleteDialog({ group, busy, onClose, onConfirm, onSchedule }: DeleteDialogProps) {
  const [typed, setTyped] = useState('');
  const ready = typed.trim().toLowerCase() === group.name.toLowerCase();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, busy]);

  return (
    <div
      className="adm-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="adm-dialog adm-dialog--danger"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="adm-delete-title"
        aria-describedby="adm-delete-warning"
      >
        <h2 id="adm-delete-title">
          <span className="adm-warn-glyph" aria-hidden>
            !
          </span>
          Delete “{group.name}” for good?
        </h2>

        <div className="adm-warn" id="adm-delete-warning">
          <strong>This happens immediately and cannot be undone.</strong>
          <span>There is no grace period and no recycle bin. It erases:</span>
          <ul>
            <li>
              the group and all {group.member_count} member
              {group.member_count === 1 ? '' : 's'}
              {group.member_names.length > 0 ? ` (${group.member_names.join(', ')})` : ''}
            </li>
            <li>every inventory, bank and shared-bank ledger entry</li>
            <li>the full XP history behind the graphs</li>
            <li>the achievement feed, quest progress and kill counts</li>
            <li>any uploaded screenshots, deleted from storage too</li>
          </ul>
          <span>
            Their group token stops working the moment you confirm. Nightly backups are the only
            remaining copy, and they age out within 30 days.
          </span>
        </div>

        {group.deletion.pending ? (
          <p>
            This group is already scheduled for{' '}
            <strong>{formatDate(group.deletion.delete_after)}</strong>. Deleting now skips the rest
            of that notice period.
          </p>
        ) : (
          <p>
            Prefer the reversible option? <strong>Schedule instead</strong> — the group keeps working
            for {DELETION_GRACE_DAYS} days, the members can see the date, and either of you can call
            it off.
          </p>
        )}

        <label className="adm-field">
          TYPE “{group.name}” TO CONFIRM
          <input
            value={typed}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder={group.name}
            disabled={busy}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>

        <div className="adm-dialog-actions">
          <button type="button" className="adm-btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {!group.deletion.pending && (
            <button type="button" className="adm-btn" disabled={busy} onClick={onSchedule}>
              Schedule instead
            </button>
          )}
          <button
            type="button"
            className="adm-btn adm-btn--danger adm-btn--solid"
            disabled={busy || !ready}
            onClick={onConfirm}
          >
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}
