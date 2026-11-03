// L3 — GEB
// Input: 编辑器命令、Bestdori 常用单键、浏览器按键及用户键位覆盖。
// Output: 统一键位显示、命令匹配与冲突检查。
// Pos: [Map](../L2-2.md)；创作工作区快捷键配置。
// Effects/Dependencies: 本地 localStorage 保存覆盖；不捕获输入框或注册全局事件。
export const chartCreationTools = ["select", "tap", "flick", "trace", "hold", "guide", "erase", "pan", "brush", "node"] as const;
export const chartSnapDivisions = [4, 8, 12, 16, 24, 32, 48, 64] as const;
const toolLetters: Partial<Record<typeof chartCreationTools[number], string[]>> = {
  select: ["KeyR"], tap: ["KeyF"], flick: ["KeyG"], erase: ["KeyT"],
};
interface ShortcutCommand { id: string; label: string; defaults: readonly string[] }
export const chartShortcutCommands: readonly ShortcutCommand[] = [
  { id: "save", label: "creation.save", defaults: ["Mod+KeyS"] },
  { id: "undo", label: "undo", defaults: ["KeyZ", "Mod+KeyZ"] },
  { id: "redo", label: "redo", defaults: ["KeyY", "Mod+Shift+KeyZ", "Mod+KeyY"] },
  { id: "play", label: "shortcuts.play", defaults: ["Space"] },
  { id: "cancel", label: "shortcuts.cancel", defaults: ["Escape"] },
  { id: "confirm", label: "help.place_at_pointer", defaults: ["Enter"] },
  { id: "select_all", label: "shortcuts.select_all", defaults: ["Mod+KeyA"] },
  { id: "cut", label: "creation.cut", defaults: ["KeyX", "Mod+KeyX"] },
  { id: "copy", label: "creation.copy", defaults: ["KeyC", "Mod+KeyC"] },
  { id: "copy_segments", label: "creation.copy_segments", defaults: [] },
  { id: "paste", label: "creation.paste", defaults: ["KeyV", "Mod+KeyV"] },
  { id: "paste_mirrored", label: "creation.paste_mirrored", defaults: ["Mod+Shift+KeyV"] },
  { id: "duplicate", label: "creation.duplicate", defaults: ["Mod+KeyD"] },
  { id: "duplicate_mirrored", label: "creation.duplicate_mirrored", defaults: ["Mod+Shift+KeyD"] },
  { id: "delete", label: "deleteSelection", defaults: ["Delete", "Backspace"] },
  { id: "flip", label: "creation.flip", defaults: ["KeyQ", "Mod+KeyF"] },
  { id: "flick_left", label: "shortcuts.flick_left", defaults: ["KeyS"] },
  { id: "flick_right", label: "shortcuts.flick_right", defaults: ["KeyD"] },
  { id: "help", label: "help.title", defaults: ["F1", "Shift+Slash"] },
  { id: "join", label: "creation.join_lines", defaults: [] },
  { id: "split", label: "creation.split_line", defaults: [] },
  { id: "repeat", label: "creation.repeat_nodes", defaults: [] },
  { id: "generate_nodes", label: "creation.generate_nodes", defaults: [] },
  { id: "remove_nodes", label: "creation.remove_nodes", defaults: [] },
  { id: "generate_traces", label: "creation.generate_traces", defaults: [] },
  { id: "convert_traces", label: "creation.convert_traces", defaults: [] },
  { id: "compress_first", label: "patterns.compress_first", defaults: [] },
  { id: "compress_last", label: "patterns.compress_last", defaults: [] },
  { id: "nudge_up", label: "shortcuts.nudge_up", defaults: ["Alt+ArrowUp"] },
  { id: "nudge_down", label: "shortcuts.nudge_down", defaults: ["Alt+ArrowDown"] },
  { id: "tick_up", label: "shortcuts.tick_up", defaults: [] },
  { id: "tick_down", label: "shortcuts.tick_down", defaults: [] },
  { id: "width_up", label: "shortcuts.width_up", defaults: ["BracketRight"] },
  { id: "width_down", label: "shortcuts.width_down", defaults: ["BracketLeft"] },
  { id: "width_up_large", label: "shortcuts.width_up_large", defaults: ["Shift+BracketRight"] },
  { id: "width_down_large", label: "shortcuts.width_down_large", defaults: ["Shift+BracketLeft"] },
  { id: "zoom_in", label: "shortcuts.zoom_in", defaults: ["Equal", "Shift+Equal", "NumpadAdd"] },
  { id: "zoom_out", label: "shortcuts.zoom_out", defaults: ["Minus", "NumpadSubtract"] },
  { id: "pan_up", label: "shortcuts.pan_up", defaults: ["ArrowUp"] },
  { id: "pan_down", label: "shortcuts.pan_down", defaults: ["ArrowDown"] },
  { id: "pan_left", label: "shortcuts.pan_left", defaults: ["ArrowLeft"] },
  { id: "pan_right", label: "shortcuts.pan_right", defaults: ["ArrowRight"] },
  { id: "page_up", label: "shortcuts.page_up", defaults: ["PageUp"] },
  { id: "page_down", label: "shortcuts.page_down", defaults: ["PageDown"] },
  { id: "home", label: "shortcuts.home", defaults: ["Home"] },
  { id: "end", label: "shortcuts.end", defaults: ["End"] },
  { id: "previous_waypoint", label: "creation.previous_waypoint", defaults: [] },
  { id: "next_waypoint", label: "creation.next_waypoint", defaults: [] },
  { id: "audio_settings", label: "audio.title", defaults: [] },
  { id: "note_sounds", label: "labels.noteSound", defaults: [] },
  { id: "metronome", label: "audio.metronome", defaults: [] },
  ...chartCreationTools.map((tool, index) => ({ id: `tool:${tool}`, label: tool === "brush" ? "creation.brush" : tool,
    defaults: [...(toolLetters[tool] ?? []), `Digit${(index + 1) % 10}`] })),
  ...chartSnapDivisions.map((division, index) => ({ id: `grid:${division}`, label: `1/${division}`, defaults: [`Shift+Digit${index + 1}`] })),
];
export type ChartShortcutOverrides = Record<string, string[]>;
const storageKey = "haneoka-chart-shortcuts-v1";
const validBinding = /^(?:Mod\+)?(?:Alt\+)?(?:Shift\+)?(?:Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|Space|Enter|Escape|Tab|Backspace|Delete|Home|End|PageUp|PageDown|BracketLeft|BracketRight|Equal|Minus|Comma|Period|Slash|Backslash|Semicolon|Quote|Backquote)$/u;
export function shortcutForEvent(event: KeyboardEvent): string | undefined {
  const binding = `${event.ctrlKey || event.metaKey ? "Mod+" : ""}${event.altKey ? "Alt+" : ""}${event.shiftKey ? "Shift+" : ""}${event.code}`;
  return validBinding.test(binding) ? binding : undefined;
}
export function chartShortcutBindings(overrides: ChartShortcutOverrides, id: string): readonly string[] {
  return overrides[id] ?? (chartShortcutCommands.find(command => command.id === id)?.defaults ?? [])
    .filter(binding => !Object.entries(overrides).some(([other, bindings]) => other !== id && bindings.includes(binding)));
}
export function matchChartShortcut(overrides: ChartShortcutOverrides, event: KeyboardEvent): string | undefined {
  const binding = shortcutForEvent(event);
  return binding ? chartShortcutCommands.find(command => chartShortcutBindings(overrides, command.id).includes(binding))?.id : undefined;
}
export function displayChartShortcut(binding: string): string {
  return binding.replace("Mod+", "Ctrl/⌘+").replace(/Key(?=[A-Z])/u, "").replace(/Digit(?=[0-9])/u, "")
    .replace("BracketLeft", "[").replace("BracketRight", "]").replace("Equal", "+").replace("Minus", "−")
    .replace("ArrowUp", "↑").replace("ArrowDown", "↓").replace("ArrowLeft", "←").replace("ArrowRight", "→")
    .replace("NumpadSubtract", "Num −").replace("NumpadMultiply", "Num ×").replace("NumpadDivide", "Num ÷")
    .replace("NumpadAdd", "Num +").replace("NumpadDecimal", "Num .").replace("NumpadEnter", "Num ↵")
    .replace("Backspace", "⌫").replace("Delete", "⌦").replace("Escape", "Esc").replace("Space", "␣");
}
export function readChartShortcuts(): ChartShortcutOverrides {
  if (typeof window === "undefined") return {};
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (value?.version !== 1 || !value.bindings || typeof value.bindings !== "object") return {};
    const result: ChartShortcutOverrides = {};
    for (const command of chartShortcutCommands) {
      const bindings = value.bindings[command.id];
      if (Array.isArray(bindings) && bindings.length <= 4 && bindings.every(binding => typeof binding === "string" && validBinding.test(binding)))
        result[command.id] = bindings;
    }
    return result;
  } catch { return {}; }
}
export function writeChartShortcuts(overrides: ChartShortcutOverrides) {
  localStorage.setItem(storageKey, JSON.stringify({ version: 1, bindings: overrides }));
}
