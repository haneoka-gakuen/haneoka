export function filterDateBound(value: string | undefined, end = false): number | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return undefined;
  if (end) date.setDate(date.getDate() + 1);
  return date.getTime();
}
