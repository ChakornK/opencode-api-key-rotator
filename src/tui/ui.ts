import { Input, Select } from "@opentui/core";
import type { VNode } from "@opentui/core";
import {
  applySelectColors,
  getActiveTheme,
  inputColors,
  selectColors,
} from "../themes.js";
import type { RotatorTheme } from "../themes.js";
import { state } from "./state.js";
import type { SelectOption } from "./types.js";

type EventHandler = (...args: any[]) => void;

interface EventTarget {
  on(
    event: "itemSelected" | "selectionChanged" | "enter",
    handler: EventHandler,
  ): void;
  on(event: string, handler: EventHandler): void;
}

export function events(vnode: VNode): EventTarget {
  return vnode as unknown as EventTarget;
}

export function asRenderable(id: string): any {
  return state.renderer?.root.findDescendantById(id);
}

export function maskKey(key: string): string {
  return key.length <= 8 ? "****" : `${key.slice(0, 5)}****`;
}

export function themedSelect(
  id: string,
  width: number,
  height: number,
  options: SelectOption[],
  index: number,
  onItemSelected: (_index: number, option: SelectOption) => void,
  colors?: ReturnType<typeof selectColors>,
): VNode {
  const theme = getActiveTheme();
  const c = colors ?? selectColors(theme);
  const sel = Select({
    id,
    width,
    height,
    options,
    selectedIndex: index,
    backgroundColor: c.backgroundColor,
    focusedBackgroundColor: c.focusedBackgroundColor,
    focusedTextColor: c.focusedTextColor,
    selectedBackgroundColor: c.selectedBackgroundColor,
    selectedTextColor: c.selectedTextColor,
    textColor: c.textColor,
    descriptionColor: c.descriptionColor,
    selectedDescriptionColor: c.selectedDescriptionColor,
  });
  events(sel).on("itemSelected", onItemSelected);
  state.focusTargetId = id;
  return sel;
}

export function themedInput(
  id: string,
  placeholder: string,
  width: number,
  value?: string,
): VNode {
  const c = inputColors(getActiveTheme());
  state.focusTargetId = id;
  return Input({
    id,
    placeholder,
    width,
    value,
    backgroundColor: c.backgroundColor,
    focusedBackgroundColor: c.focusedBackgroundColor,
    textColor: c.textColor,
    cursorColor: c.cursorColor,
  });
}

export function applyThemeToScreen(theme: RotatorTheme): void {
  if (!state.renderer) return;

  state.renderer.setBackgroundColor(theme.background);

  const sel = asRenderable("theme-selector");
  if (sel) applySelectColors(sel, selectColors(theme));

  const screenRoot = asRenderable("screen-root");
  if (screenRoot) screenRoot.backgroundColor = theme.background;

  const panel = asRenderable("panel");
  if (panel) {
    panel.backgroundColor = theme.backgroundPanel;
    panel.borderColor = theme.border;
  }

  for (const [id, color] of [
    ["title-text", theme.primary],
    ["keys-count", theme.textMuted],
    ["active-count", theme.success],
    ["status-text", state.statusColor],
    ["help-text", theme.textMuted],
    ["theme-label", theme.primary],
  ] as const) {
    const el = asRenderable(id);
    if (el) el.fg = color;
  }
}
