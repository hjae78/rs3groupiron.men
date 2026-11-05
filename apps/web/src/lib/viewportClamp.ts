/** Keeps a floating element's edge within [pad, viewport - size - pad]. */
export function clampAxis(value: number, size: number, viewport: number, pad: number): number {
  return Math.max(pad, Math.min(value, viewport - size - pad));
}
