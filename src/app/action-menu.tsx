"use client";

import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { type MenuPosition, menuKeyTarget, menuPosition } from "@/lib/action-menu-ui";

export type ActionMenuItem = { label: string; description: string };

export type ActionMenuProps<T extends ActionMenuItem> = {
  label: string;
  items: readonly T[];
  disabled: boolean;
  onSelect: (item: T) => void;
};

type InitialFocus = "first" | "last";

function menuItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
}

export function ActionMenu<T extends ActionMenuItem>({ label, items, disabled, onSelect }: ActionMenuProps<T>) {
  const [openWith, setOpenWith] = useState<InitialFocus | null>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const menuId = `${baseId}-menu`;

  if (disabled && openWith !== null) setOpenWith(null);
  const open = openWith !== null;

  useLayoutEffect(() => {
    if (!openWith) return;
    const place = () => {
      const menu = menuRef.current;
      const trigger = triggerRef.current;
      if (!menu || !trigger) return;
      const root = document.documentElement;
      setPosition(
        menuPosition(
          trigger.getBoundingClientRect(),
          { width: menu.offsetWidth, height: menu.scrollHeight + menu.offsetHeight - menu.clientHeight },
          { width: root.clientWidth, height: root.clientHeight },
        ),
      );
    };
    const closeIfOutside = (event: Event) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpenWith(null);
    };
    place();
    const items = menuItems(menuRef.current);
    items[openWith === "last" ? items.length - 1 : 0]?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, { capture: true, passive: true });
    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("focusin", closeIfOutside);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, { capture: true });
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("focusin", closeIfOutside);
    };
  }, [openWith]);

  function close(returnFocus: boolean) {
    setOpenWith(null);
    if (returnFocus) triggerRef.current?.focus();
  }

  function choose(item: T) {
    close(true);
    onSelect(item);
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setOpenWith(event.key === "ArrowUp" ? "last" : "first");
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    // Tab continues from the trigger, so focus lands on the control after (or before) the menu button.
    if (event.key === "Tab") {
      triggerRef.current?.focus();
      return;
    }
    const items = menuItems(menuRef.current);
    const target = menuKeyTarget(event.key, items.indexOf(document.activeElement as HTMLButtonElement), items.length);
    if (target === null) return;
    event.preventDefault();
    items[target]?.focus();
  }

  return (
    <div className="action-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        id={triggerId}
        className="quick-action action-menu-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => (open ? close(true) : setOpenWith("first"))}
        onKeyDown={onTriggerKeyDown}
      >
        {label}
        <svg className="action-menu-chevron" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className="action-menu-list"
          role="menu"
          aria-labelledby={triggerId}
          data-side={position?.side}
          style={position ? { top: position.top, left: position.left, maxHeight: position.maxHeight } : undefined}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              className="action-menu-item"
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-labelledby={`${baseId}-label-${index}`}
              aria-describedby={`${baseId}-description-${index}`}
              onClick={() => choose(item)}
            >
              <span className="action-menu-item-label" id={`${baseId}-label-${index}`}>
                {item.label}
              </span>
              <span className="action-menu-item-description" id={`${baseId}-description-${index}`}>
                {item.description}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
