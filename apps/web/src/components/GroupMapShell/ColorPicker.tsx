import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { setMenuOpen } from '../../lib/menuState';
import {
  clamp01,
  hexToHsv,
  hsvToHex,
  isHex,
  type Hsv,
} from '../../lib/colorPicker';
import { clampAxis } from '../../lib/viewportClamp';

type ColorPickerProps = {
  color: string;
  /** The button the popover hangs off; also counts as "inside" for dismissal. */
  anchorRef: RefObject<HTMLElement | null>;
  onChange: (hex: string) => void;
  onClose: () => void;
};

const WIDTH = 232;
const GAP = 6;
const EDGE = 8;

/** Below the anchor when there is room, otherwise above it, always on screen. */
function place(anchor: DOMRect, height: number): CSSProperties {
  const left = clampAxis(anchor.right - WIDTH, WIDTH, window.innerWidth, EDGE);
  const below = anchor.bottom + GAP + height <= window.innerHeight - EDGE;
  const top = below
    ? anchor.bottom + GAP
    : Math.max(EDGE, anchor.top - GAP - height);
  return { left, top };
}

/**
 * Saturation/value square, hue strip and a hex field, from the handoff's
 * 36-colour-picker.
 *
 * Portalled to the body and positioned from the anchor's rect. As a child of
 * the member card it was painted over by the next card along — a sibling later
 * in the DOM wins regardless of z-index — and any scrolling ancestor would
 * have clipped it.
 *
 * Hue is held in state rather than read back from the colour: black and grey
 * have no hue, so dragging into a corner would snap the strip to red.
 */
export function ColorPicker({ color, anchorRef, onChange, onClose }: ColorPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<'sv' | 'hue' | null>(null);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(color));
  const [draft, setDraft] = useState(color.toUpperCase());
  const [style, setStyle] = useState<CSSProperties>({ left: 0, top: 0, opacity: 0 });

  useLayoutEffect(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const height = rootRef.current?.getBoundingClientRect().height ?? 0;
    if (!anchor) return;
    setStyle({ ...place(anchor, height), opacity: 1 });
  }, [anchorRef]);

  // Dismissal is handled here rather than with useDismiss: the anchor lives
  // outside the portal, so a plain "contains" test would treat the toggle's
  // own click as an outside click and close the popover as it opened.
  useEffect(() => {
    function onPointerDown(e: globalThis.PointerEvent) {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchorRef, onClose]);

  // Counted globally so tooltips underneath stay quiet while this is open.
  useEffect(() => {
    setMenuOpen(true);
    return () => setMenuOpen(false);
  }, []);

  const commit = useCallback(
    (next: Hsv) => {
      setHsv(next);
      const hex = hsvToHex(next);
      setDraft(hex.toUpperCase());
      onChange(hex);
    },
    [onChange],
  );

  const onSv = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    commit({
      h: hsv.h,
      s: clamp01((e.clientX - r.left) / r.width),
      v: 1 - clamp01((e.clientY - r.top) / r.height),
    });
  };

  const onHue = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    commit({ ...hsv, h: clamp01((e.clientX - r.left) / r.width) * 359.9 });
  };

  const capture = (e: PointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no pointer capture: dragging still works inside the element */
    }
  };

  return createPortal(
    <div
      className="gms-picker"
      style={style}
      role="dialog"
      aria-label="Pick a colour"
      ref={rootRef}
    >
      <div
        className="gms-picker-sv"
        style={{ '--hue': hsvToHex({ h: hsv.h, s: 1, v: 1 }) } as CSSProperties}
        onPointerDown={(e) => {
          capture(e);
          dragRef.current = 'sv';
          onSv(e);
        }}
        onPointerMove={(e) => dragRef.current === 'sv' && onSv(e)}
        onPointerUp={() => (dragRef.current = null)}
      >
        <span
          className="gms-picker-knob"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: color }}
        />
      </div>

      <div
        className="gms-picker-hue"
        onPointerDown={(e) => {
          capture(e);
          dragRef.current = 'hue';
          onHue(e);
        }}
        onPointerMove={(e) => dragRef.current === 'hue' && onHue(e)}
        onPointerUp={() => (dragRef.current = null)}
      >
        <span
          className="gms-picker-knob"
          style={{
            left: `${(hsv.h / 360) * 100}%`,
            top: '50%',
            background: hsvToHex({ h: hsv.h, s: 1, v: 1 }),
          }}
        />
      </div>

      <div className="gms-picker-foot">
        <span className="gms-picker-preview" style={{ background: color }} />
        <input
          className="gms-picker-hex"
          value={draft}
          maxLength={7}
          spellCheck={false}
          aria-label="Hex colour"
          onChange={(e) => {
            // Typed freely so a half-entered value is not rejected mid-edit;
            // only a complete one is pushed up.
            const next = e.target.value.trim();
            const withHash = next && !next.startsWith('#') ? `#${next}` : next;
            setDraft(withHash.toUpperCase());
            if (isHex(withHash)) {
              setHsv(hexToHsv(withHash));
              onChange(withHash.toLowerCase());
            }
          }}
        />
        <button type="button" className="gms-picker-done" onClick={onClose}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}
