/** UIDefaultTalkWindow/TalkText and native Chat message/typing sizes. */
export const NATIVE_TALK_FONT_SIZE = 36;
export const NATIVE_CHAT_FONT_SIZE = 24;

const NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?";
const PIXELS = `calc\\((${NUMBER}) \\* var\\(--vega-adv-pixel, 1px\\)\\)`;
const ABSOLUTE = new RegExp(`^${PIXELS}$`, "u");
const RELATIVE = new RegExp(`^calc\\(1em \\+ ${PIXELS}\\)$`, "u");
const SIMPLE = new RegExp(`^(${NUMBER})(px|em|%)?$`, "u");

/** Resolve TMP size against its original component, then scale the web host. */
export function advTextFontSizeCss(value: string, nativeBase: number): string {
  if (!Number.isFinite(nativeBase) || nativeBase <= 0) {
    throw new RangeError("ADV text font baseline must be positive");
  }
  const absolute = ABSOLUTE.exec(value);
  const relative = absolute ? null : RELATIVE.exec(value);
  const simple = absolute || relative ? null : SIMPLE.exec(value);
  if (!absolute && !relative && !simple) return value;
  const number = Number((absolute || relative || simple)![1]);
  if (!Number.isFinite(number)) return value;
  const scale = relative
    ? (nativeBase + number) / nativeBase
    : simple?.[2] === "em"
      ? number
      : simple?.[2] === "%"
        ? number / 100
        : number / nativeBase;
  return `calc(var(--adv-text-base-font-size) * ${Math.max(0, scale)})`;
}
