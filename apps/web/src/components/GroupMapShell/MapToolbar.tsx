import { DEFAULT_MIN_ZOOM, findMapMode, MAP_MODES, type MapMode } from '../Map';
import type { useFullscreen } from '../../hooks/useFullscreen';
import { ActionsMenu } from './ActionsMenu';
import { FullscreenIcon, LayersIcon, MinusIcon, PlusIcon } from './icons';

const MAX_ZOOM = 5;

export function MapToolbar({
  mapMode,
  onSelectMapMode,
  zoom,
  onZoomChange,
  fullscreen,
}: {
  mapMode: MapMode;
  onSelectMapMode: (next: MapMode) => void;
  zoom: number;
  onZoomChange: (next: number) => void;
  fullscreen: ReturnType<typeof useFullscreen>;
}) {
  return (
    <div className="gms-maptools">
      <ActionsMenu
        label={findMapMode(mapMode).label}
        title="Map style"
        icon={<LayersIcon />}
        placement="top"
        items={MAP_MODES.map((style) => ({
          key: style.id,
          label: style.label,
          hint: style.hint,
          active: style.id === mapMode,
          onSelect: () => onSelectMapMode(style.id),
        }))}
      />
      <button
        type="button"
        className="gms-action gms-action--icon"
        title="Zoom out"
        aria-label="Zoom out"
        disabled={zoom <= DEFAULT_MIN_ZOOM}
        onClick={() => onZoomChange(Math.max(DEFAULT_MIN_ZOOM, zoom - 1))}
      >
        <MinusIcon />
      </button>
      <button
        type="button"
        className="gms-action gms-action--icon"
        title="Zoom in"
        aria-label="Zoom in"
        disabled={zoom >= MAX_ZOOM}
        onClick={() => onZoomChange(Math.min(MAX_ZOOM, zoom + 1))}
      >
        <PlusIcon />
      </button>
      {fullscreen.supported && (
        <button
          type="button"
          className="gms-action gms-action--icon"
          aria-pressed={fullscreen.active}
          title={fullscreen.active ? 'Exit full screen' : 'Full screen'}
          aria-label={fullscreen.active ? 'Exit full screen' : 'Full screen'}
          onClick={fullscreen.toggle}
        >
          <FullscreenIcon exit={fullscreen.active} />
        </button>
      )}
    </div>
  );
}
