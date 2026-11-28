export type MenuAnchor = { top: number; bottom: number; left: number };
export type MenuSize = { width: number; height: number };
export type Viewport = { width: number; height: number };
export type MenuPosition = { side: "above" | "below"; top: number; left: number; maxHeight: number };

export const MENU_GAP = 6;
export const MENU_EDGE = 8;

export function menuKeyTarget(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return current < 0 ? 0 : (current + 1) % count;
  if (key === "ArrowUp") return current < 0 ? count - 1 : (current - 1 + count) % count;
  return null;
}

/** Viewport coordinates for a `position: fixed` menu, so no scrolling ancestor can clip it. */
export function menuPosition(anchor: MenuAnchor, menu: MenuSize, viewport: Viewport): MenuPosition {
  const roomBelow = Math.max(0, viewport.height - anchor.bottom - MENU_GAP - MENU_EDGE);
  const roomAbove = Math.max(0, anchor.top - MENU_GAP - MENU_EDGE);
  const below = roomBelow >= menu.height || roomBelow >= roomAbove;
  const maxHeight = below ? roomBelow : roomAbove;
  const height = Math.min(menu.height, maxHeight);
  const left = Math.max(MENU_EDGE, Math.min(anchor.left, viewport.width - MENU_EDGE - menu.width));
  return below
    ? { side: "below", top: anchor.bottom + MENU_GAP, left, maxHeight }
    : { side: "above", top: anchor.top - MENU_GAP - height, left, maxHeight };
}
