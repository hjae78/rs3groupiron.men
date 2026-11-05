import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DEMO_GROUP,
  type GroupShares,
  type GroupVisibility,
} from '../../api/groupClient';
import { mergeQuestStates, useDemoActivity } from '../../hooks/useDemoActivity';
import { useAutoHide } from '../../hooks/useAutoHide';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useFullscreen } from '../../hooks/useFullscreen';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useGroupData } from '../../hooks/useGroupData';
import { useGroupQuests } from '../../hooks/useGroupQuests';
import { useUiPrefs, useResolvedTheme } from '../../hooks/useUiPrefs';
import { useUrlState } from '../../hooks/useUrlState';
import { useXpDrops } from '../../hooks/useXpDrops';
import { COFFEE_URL } from '../../lib/constants';
import { ALL_SHARED, TAB_SHARE } from '../../lib/groupShares';
import { clearGroupSession, readGroupSession, writeGroupSession } from '../../lib/groupSession';
import type { PlayerView } from '../../lib/items';
import { panelOpacityToAlpha } from '../../lib/uiPrefs';
import { POLL_MS_DEFAULT, POLL_MS_MAP } from '../../lib/polling';
import {
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  readMapMode,
  Rs3Map,
  writeMapMode,
  type MapMode,
} from '../Map';
import { AchievementsPanel } from './AchievementsPanel';
import { AppHeader, SideRail, type ChromeActions, type ChromeMenu, type NavItem } from './AppChrome';
import { DropsPanel } from './DropsPanel';
import { ItemsPanel } from './ItemsPanel';
import { LedgerPanel } from './LedgerPanel';
import { MapChips } from './MapChips';
import { MapToolbar } from './MapToolbar';
import { MembersSidebar } from './MembersSidebar';
import type { MemberBadge } from './memberOptions';
import { PanelStatus } from './PanelChrome';
import { QuestsPanel } from './QuestsPanel';
import { SettingsPanel } from './SettingsPanel';
import { SetupModal } from './SetupModal';
import './GroupMapShell.css';
import './ShellLayout.css';

// Recharts is heavy; only load it when the graphs tab is opened.
const GraphsPanel = lazy(() => import('./GraphsPanel').then((m) => ({ default: m.GraphsPanel })));

const DEFAULT_MEMBER_SLOTS = 5;

export type ShellTab =
  | 'items'
  | 'map'
  | 'graphs'
  | 'ledger'
  | 'quests'
  | 'achievements'
  | 'drops'
  | 'settings';

const NAV_TABS: Array<NavItem<ShellTab>> = [
  { id: 'items', label: 'Items' },
  { id: 'map', label: 'Map' },
  { id: 'graphs', label: 'Graphs' },
  { id: 'ledger', label: 'Bank ledger' },
  { id: 'quests', label: 'Quests' },
  { id: 'achievements', label: 'Achievements' },
  { id: 'drops', label: 'Rare drops' },
];

// 'players' was the old mobile-only profile tab; the stacked layout shows the
// members column inline instead, so saved links fall back to Items.
const SHELL_TABS: ShellTab[] = [...NAV_TABS.map((t) => t.id), 'settings'];
const LEGACY_TABS = new Set(['players']);

const STACK_QUERY = '(max-width: 719px)';

export type GroupMapShellProps = {
  /** When given, always wins over any saved session. */
  groupName?: string;
  groupToken?: string;
  initialTab?: ShellTab;
  /** Run the demo activity simulation (XP, movement, loot, achievements). */
  demoTools?: boolean;
  children?: ReactNode;
};

type MapFocus = { name: string; x: number; y: number; plane: number };

function focusFor(player: PlayerView): MapFocus | null {
  const [x, y, plane = 0] = player.coordinates;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  return { name: player.name, x, y, plane: plane ?? 0 };
}

function initialSession(name?: string, token?: string) {
  if (name) return { name, token: token ?? '' };
  return readGroupSession() ?? { name: DEMO_GROUP, token: token ?? '' };
}

export function GroupMapShell({
  groupName: initialGroupName,
  groupToken: initialGroupToken,
  initialTab = 'items',
  demoTools = false,
  children,
}: GroupMapShellProps) {
  const navigate = useNavigate();
  const [boot] = useState(() => initialSession(initialGroupName, initialGroupToken));
  const [tab, setTab] = useUrlState<ShellTab>('tab', initialTab, {
    allowed: SHELL_TABS,
    history: 'push',
    exclusive: true,
  });
  const [groupName, setGroupName] = useState(boot.name);
  const [groupToken, setGroupToken] = useState(boot.token);
  const [setupOpen, setSetupOpen] = useState(false);
  const [displayName, setDisplayName] = useState(boot.name);
  const [visibility, setVisibility] = useState<GroupVisibility>('private');
  const [shares, setShares] = useState<GroupShares>(ALL_SHARED);
  const [membersCollapsed, setMembersCollapsed] = useState(false);
  const [mapFocus, setMapFocus] = useState<MapFocus | null>(null);
  const [focusName, setFocusName] = useUrlState('player', '', { history: 'push' });
  const [mapMode, setMapMode] = useState<MapMode>(readMapMode);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [openMenu, setOpenMenu] = useState<ChromeMenu>(null);
  const fullscreen = useFullscreen();
  const stacked = useMediaQuery(STACK_QUERY);

  const { prefs, setPref } = useUiPrefs();
  const theme = useResolvedTheme(prefs.themePref);

  const isRail = prefs.dir === 'b' && !stacked;
  const isFullWidth = prefs.dir === 'a' && (prefs.navFull || stacked);
  const isInline = prefs.dir === 'a' && !isFullWidth;
  const autoHide = useAutoHide(prefs.navHide && !stacked, openMenu !== null);

  useEffect(() => {
    if (LEGACY_TABS.has(tab)) setTab('items');
  }, [tab, setTab]);

  // Switching screens closes the setup modal and any open nav menu.
  useEffect(() => {
    setSetupOpen(false);
    setOpenMenu(null);
  }, [tab]);

  const selectMapMode = useCallback((next: MapMode) => {
    writeMapMode(next);
    setMapMode(next);
  }, []);

  const pollMs = tab === 'map' ? POLL_MS_MAP : POLL_MS_DEFAULT;
  const {
    players,
    rawMembers,
    info,
    loading,
    error,
    dataRevision,
    achievementsRevision,
    questsRevision,
    refresh,
    patchPlayers,
  } = useGroupData(groupName, groupToken, pollMs);

  const { xpDropsByPlayer, dismissXpDrop } = useXpDrops(players);
  const memberSlots = info?.member_slots ?? DEFAULT_MEMBER_SLOTS;
  // Group views are private (or the demo); keep them out of search results.
  // The tab is in the title so a pile of open group tabs stays readable.
  const tabLabel = NAV_TABS.find((t) => t.id === tab)?.label;
  useDocumentTitle(
    [tabLabel, info?.name ?? groupName].filter(Boolean).join(' · '),
    { noindex: true },
  );

  useEffect(() => {
    if (!info) return;
    setDisplayName(info.name);
    setVisibility(info.visibility ?? 'private');
    setShares(info.shares ?? ALL_SHARED);
  }, [info]);

  const canManage = Boolean(groupToken) || groupName === DEMO_GROUP;

  const visible = info?.visible;
  const navTabs = useMemo(() => {
    if (!visible) return NAV_TABS;
    return NAV_TABS.filter((item) => {
      const key = TAB_SHARE[item.id];
      return !key || visible[key];
    });
  }, [visible]);

  useEffect(() => {
    if (!navTabs.length) return;
    if (tab === 'settings') {
      if (!canManage) setTab(navTabs[0].id);
      return;
    }
    if (!navTabs.some((item) => item.id === tab)) setTab(navTabs[0].id);
  }, [navTabs, tab, setTab, canManage]);

  useEffect(() => {
    // Tokenless views (e.g. the public demo) must not persist — an empty token
    // is not a valid session and would clobber a real saved one.
    if (!groupToken) return;
    writeGroupSession({ name: groupName, token: groupToken });
  }, [groupName, groupToken]);

  const demo = useDemoActivity(demoTools, patchPlayers);

  // Quest progress feeds both the Quests tab and the quest points on each
  // player's skills panel, so it lives at shell level.
  const quests = useGroupQuests(
    groupName,
    groupToken,
    questsRevision,
    visible?.quests !== false,
  );
  const questsByMember = useMemo(
    () => mergeQuestStates(quests.byMember, demo.quests),
    [quests.byMember, demo.quests],
  );
  const memberNames = useMemo(() => players.map((p) => p.name), [players]);

  const memberBadges = useMemo<MemberBadge[]>(
    () => players.map((p) => ({ name: p.name, avatarUrl: p.avatarUrl, color: p.avatarColor })),
    [players],
  );

  const mapMarkers = useMemo(
    () =>
      players.flatMap((player) => {
        const [x, y, plane = 0] = player.coordinates;
        if (typeof x !== 'number' || typeof y !== 'number') return [];
        return [
          {
            id: player.name,
            name: player.name,
            x,
            y,
            plane: plane ?? 0,
            color: player.avatarColor,
            avatarUrl: player.avatarUrl,
            online: player.online,
          },
        ];
      }),
    [players],
  );

  // Follows the focused player: every poll that moves them re-centres the map.
  // The previous object is kept when nothing moved so the map is not told to
  // re-centre on coordinates it is already showing.
  useEffect(() => {
    if (!focusName) {
      setMapFocus(null);
      return;
    }
    const player = players.find((p) => p.name === focusName);
    if (!player) return;
    const next = focusFor(player);
    // No position (hidden, in the lobby, never reported): hold the last one
    // rather than snapping back to the default centre.
    if (!next) return;
    setMapFocus((prev) =>
      prev &&
      prev.name === next.name &&
      prev.x === next.x &&
      prev.y === next.y &&
      prev.plane === next.plane
        ? prev
        : next,
    );
  }, [focusName, players]);

  function goToPlayer(player: PlayerView) {
    const focus = focusFor(player);
    if (!focus) return;
    setMapFocus(focus);
    // Tab first: it clears the other params, so the player has to be written
    // after it or the exclusive write would drop it again.
    setTab('map');
    setFocusName(player.name);
  }

  const isMap = tab === 'map';
  const showMap = isMap || prefs.mapBg;

  const panelProps = {
    groupName,
    groupToken,
    dataRevision,
    members: memberBadges,
  };

  const chromeActions: ChromeActions = {
    onBrand: () => navigate('/'),
    onSettings: () => setTab('settings'),
    onSetup: () => setSetupOpen(true),
    onToggleTheme: () => setPref('themePref', theme === 'light' ? 'dark' : 'light'),
    themeMenuLabel: theme === 'light' ? 'Dark mode' : 'Light mode',
    themeMenuHint: theme === 'light' ? '☾' : '☀',
    supportHref: COFFEE_URL,
    onLogout: () => {
      if (groupToken) clearGroupSession();
      navigate('/', { replace: true });
    },
  };

  const chromeProps = {
    tabs: navTabs,
    active: tab,
    groupName: displayName,
    canManage,
    settingsActive: tab === 'settings',
    openMenu,
    onOpenMenu: setOpenMenu,
    onSelect: setTab,
    actions: chromeActions,
    hidden: autoHide.hidden,
    onEnter: autoHide.onEnter,
    onLeave: autoHide.onLeave,
  };

  const shellClass = [
    'gms',
    `gms--dir-${prefs.dir}`,
    isFullWidth ? 'gms--hdr-full' : '',
    isRail ? 'gms--rail' : '',
    stacked ? 'gms--stacked' : '',
    isMap ? 'gms--map' : '',
    prefs.navHide && !stacked ? 'gms--autohide' : '',
    membersCollapsed ? 'gms--members-collapsed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={shellClass}
      style={
        {
          '--gms-panel-alpha': String(panelOpacityToAlpha(prefs.pa)),
          '--pa': `${prefs.pa}%`,
        } as CSSProperties
      }
    >
      {showMap && (
        <div className={isMap ? 'gms-map-layer' : 'gms-map-layer gms-map-layer--backdrop'}>
          <Rs3Map
            className="rs3-map--fullscreen"
            height="100%"
            x={mapFocus?.x ?? DEFAULT_CENTER.x}
            y={mapFocus?.y ?? DEFAULT_CENTER.y}
            plane={mapFocus?.plane ?? 0}
            zoom={zoom}
            mode={mapMode}
            markers={mapMarkers}
            activeMarkerId={focusName || null}
          />
        </div>
      )}

      {isFullWidth && <AppHeader variant="full" {...chromeProps} />}

      <div className="gms-row">
        {isRail && <SideRail {...chromeProps} />}

        <MembersSidebar
          players={players}
          error={error}
          loading={loading}
          memberSlots={memberSlots}
          membersCollapsed={membersCollapsed}
          onToggleCollapsed={() => setMembersCollapsed((open) => !open)}
          xpDropsByPlayer={xpDropsByPlayer}
          dismissXpDrop={dismissXpDrop}
          questsByMember={questsByMember}
        />

        <main className={isMap ? 'gms-main gms-main--map' : 'gms-main'}>
          {isInline && <AppHeader variant="inline" {...chromeProps} />}

          {isMap && (
            <MapChips
              players={players}
              activeName={focusName || null}
              attached={isInline}
              onSelect={goToPlayer}
            />
          )}

          {tab === 'items' && (
            <ItemsPanel rawMembers={rawMembers} members={memberBadges} />
          )}
          {tab === 'graphs' && (
            <Suspense
              fallback={
                <section className="gms-graphs gms-panel" aria-label="XP graphs" aria-busy>
                  <PanelStatus loading />
                </section>
              }
            >
              <GraphsPanel {...panelProps} injectedXp={demo.xp} />
            </Suspense>
          )}
          {tab === 'ledger' && (
            <LedgerPanel
              {...panelProps}
              createdAt={info?.created_at}
              injected={demo.ledger}
            />
          )}
          {tab === 'quests' && (
            <QuestsPanel
              memberNames={memberNames}
              members={memberBadges}
              byMember={questsByMember}
              loading={quests.loading}
              error={quests.error}
            />
          )}
          {tab === 'achievements' && (
            <AchievementsPanel
              {...panelProps}
              dataRevision={achievementsRevision}
              createdAt={info?.created_at}
              injected={demo.achievements}
            />
          )}
          {tab === 'drops' && (
            <DropsPanel
              {...panelProps}
              dataRevision={achievementsRevision}
              createdAt={info?.created_at}
              injected={demo.achievements}
            />
          )}
          {tab === 'settings' && canManage && (
            <SettingsPanel
              groupName={groupName}
              groupToken={groupToken}
              players={players}
              memberSlots={memberSlots}
              theme={prefs.themePref}
              dir={prefs.dir}
              navFull={prefs.navFull}
              navHide={prefs.navHide}
              mapBg={prefs.mapBg}
              visibility={visibility}
              shares={shares}
              deletion={info?.deletion ?? null}
              panelOpacity={prefs.pa}
              onPanelOpacityChange={(value) => setPref('pa', value)}
              onThemeChange={(next) => setPref('themePref', next)}
              onDirChange={(next) => setPref('dir', next)}
              onNavFullChange={(next) => setPref('navFull', next)}
              onNavHideChange={(next) => setPref('navHide', next)}
              onMapBgChange={(next) => setPref('mapBg', next)}
              onVisibilityChange={setVisibility}
              onSharesChange={setShares}
              onChanged={() => void refresh()}
              onOpenSetup={() => setSetupOpen(true)}
            />
          )}

          {children}
        </main>
      </div>

      {isMap && (
        <MapToolbar
          mapMode={mapMode}
          onSelectMapMode={selectMapMode}
          zoom={zoom}
          onZoomChange={setZoom}
          fullscreen={fullscreen}
        />
      )}

      <SetupModal
        open={setupOpen}
        groupName={groupName}
        groupToken={groupToken}
        onClose={() => setSetupOpen(false)}
        onSaved={({ name, token }) => {
          setGroupName(name);
          setGroupToken(token);
          setDisplayName(name);
          writeGroupSession({ name, token });
        }}
      />
    </div>
  );
}
