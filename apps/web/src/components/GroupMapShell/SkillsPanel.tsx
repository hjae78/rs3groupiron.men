import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { formatQty, type PlayerSkill } from '../../lib/items';
import { MAX_SKILL_XP, combatLevelFromSkills, xpForLevel } from '../../lib/skills';
import { clampAxis } from '../../lib/viewportClamp';

type SkillTip = {
  skillId: string;
  anchor: DOMRect;
};

const HIDDEN_TIP: CSSProperties = { left: 0, top: 0, opacity: 0 };

// Skill cells are <button>s for keyboard access; .gms-skill-cell already
// resets border/background, this only inherits the text style.
const CELL_BUTTON_STYLE: CSSProperties = { font: 'inherit', color: 'inherit' };

function clampSkillTipStyle(tipEl: HTMLElement, anchor: DOMRect): CSSProperties {
  const pad = 8;
  const gap = 8;
  const { width, height } = tipEl.getBoundingClientRect();
  const left = clampAxis(anchor.left + anchor.width / 2 - width / 2, width, window.innerWidth, pad);

  const above = anchor.top - height - gap;
  const below = anchor.bottom + gap;
  const top = above >= pad ? above : clampAxis(below, height, window.innerHeight, pad);

  return { left, top, opacity: 1 };
}

export function SkillsPanel({
  skills,
  totalLevel,
  questPoints = 0,
}: {
  skills: PlayerSkill[];
  totalLevel: number;
  /** Derived by the shell from the member's finished quests. */
  questPoints?: number;
}) {
  const tipRef = useRef<HTMLDivElement>(null);
  const tipId = useId();
  const [tip, setTip] = useState<SkillTip | null>(null);
  const [tipStyle, setTipStyle] = useState<CSSProperties>(HIDDEN_TIP);

  /**
   * Cell tiers, in ascending order of achievement:
   *   99   — the classic max, highlighted border
   *   120  — the virtual cap, gold border and one star
   *   200m — maximum XP, gold border and two stars
   */
  function starCount(skill: PlayerSkill) {
    if (skill.xp >= MAX_SKILL_XP) return 2;
    if (skill.baseLevel >= 120) return 1;
    return 0;
  }

  function cellClass(skill: PlayerSkill) {
    const classes = ['gms-skill-cell'];
    if (skill.baseLevel >= 99) classes.push('gms-skill-cell--max');
    if (skill.baseLevel >= 120) classes.push('gms-skill-cell--max120');
    if (skill.xp >= MAX_SKILL_XP) classes.push('gms-skill-cell--maxxp');
    return classes.join(' ');
  }

  function cellLabel(skill: PlayerSkill) {
    const base = `${skill.name}: ${skill.level} / ${skill.baseLevel}`;
    if (skill.xp >= MAX_SKILL_XP) return `${base}, 200 million XP`;
    if (skill.baseLevel >= 120) return `${base}, level 120`;
    return base;
  }

  const combatLevel = combatLevelFromSkills(
    Object.fromEntries(skills.map((s) => [s.id, s.baseLevel])),
  );
  function showTip(skill: PlayerSkill, el: HTMLElement) {
    setTipStyle(HIDDEN_TIP);
    setTip({ skillId: skill.id, anchor: el.getBoundingClientRect() });
  }

  const tipSkill = tip ? (skills.find((s) => s.id === tip.skillId) ?? null) : null;
  const tipAtCap = tipSkill ? tipSkill.baseLevel >= tipSkill.maxLevel : false;
  const tipNextXp = tipSkill
    ? tipAtCap
      ? MAX_SKILL_XP
      : xpForLevel(tipSkill.baseLevel + 1, tipSkill.curve)
    : 0;
  const tipRemainder = tipSkill ? Math.max(0, tipNextXp - tipSkill.xp) : 0;

  useLayoutEffect(() => {
    if (!tip || !tipRef.current) return;
    setTipStyle(clampSkillTipStyle(tipRef.current, tip.anchor));
  }, [tip, tipSkill?.xp, tipSkill?.level, tipSkill?.baseLevel]);

  return (
    <div className="gms-player-panel gms-skills-panel">
      <div className="gms-player-panel-title">Skills</div>
      <div className="gms-skills-grid">
        {skills.map((skill) => (
          <button
            key={skill.id}
            type="button"
            className={cellClass(skill)}
            style={CELL_BUTTON_STYLE}
            aria-label={cellLabel(skill)}
            aria-describedby={tip?.skillId === skill.id ? tipId : undefined}
            onMouseEnter={(e) => showTip(skill, e.currentTarget)}
            onFocus={(e) => showTip(skill, e.currentTarget)}
            onMouseLeave={() => setTip(null)}
            onBlur={() => setTip(null)}
          >
            {starCount(skill) > 0 && (
              <span className="gms-skill-stars" aria-hidden>
                {'★'.repeat(starCount(skill))}
              </span>
            )}
            <img
              className="gms-skill-icon"
              src={`/skills/${skill.icon}`}
              alt=""
              width={28}
              height={28}
            />
            <div className="gms-skill-levels" aria-hidden>
              <span className="gms-skill-level gms-skill-level--cur">{skill.level}</span>
              <span className="gms-skill-level gms-skill-level--base">{skill.baseLevel}</span>
            </div>
          </button>
        ))}
      </div>
      <div className="gms-skills-footer">
        <div className="gms-skills-stat" title="Total level">
          <img
            className="gms-skills-stat-icon"
            src="/sprites/skill_tab_skills.png"
            alt=""
            width={16}
            height={16}
          />
          <strong>{totalLevel}</strong>
        </div>
        <div className="gms-skills-stat" title="Combat level">
          <img
            className="gms-skills-stat-icon"
            src="/sprites/combat_icon.png"
            alt=""
            width={16}
            height={16}
          />
          <strong>{combatLevel}</strong>
        </div>
        <div className="gms-skills-stat" title="Quest points">
          <img
            className="gms-skills-stat-icon"
            src="/sprites/quest_icon_skill_tab.png"
            alt=""
            width={16}
            height={16}
          />
          <strong>{questPoints}</strong>
        </div>
      </div>
      {tipSkill
        ? createPortal(
            <div
              ref={tipRef}
              id={tipId}
              className="gms-skill-tip"
              role="tooltip"
              style={tipStyle}
            >
              <div className="gms-skill-tip-head">
                {tipSkill.name}: {tipSkill.level}/{tipSkill.baseLevel}
              </div>
              <div className="gms-skill-tip-row">
                <span>Current XP:</span>
                <span>{formatQty(tipSkill.xp)}</span>
              </div>
              <div className="gms-skill-tip-row">
                <span>Next level:</span>
                <span>{tipAtCap ? '—' : formatQty(tipNextXp)}</span>
              </div>
              <div className="gms-skill-tip-row">
                <span>Remainder:</span>
                <span>{tipAtCap ? '0' : formatQty(tipRemainder)}</span>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
