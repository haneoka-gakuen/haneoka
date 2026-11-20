/** Supports named game placeholders and older positional mission text. */
export function missionDescription(template: string, values: Record<string, string>): string {
  const positional = [values.CharacterId, values.AchievementCount, values.Value];
  return template.replace(/\{(\w+)\}/gu, (token, name: string) =>
    /^\d$/u.test(name) ? (positional[Number(name)] ?? token) : (values[name] ?? token),
  );
}
