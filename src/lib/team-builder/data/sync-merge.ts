/** Three-way document merge: server revisions identify the base; timestamps do not. */
export interface SyncBase<T> { revision: number; document: T }
export interface SyncMerge<T> { value: T; conflicts: string[] }
const missing = Symbol("missing");
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keyField = (path: string) => /\/(members|snapshots)$/.test(path) ? "cardId" : /\/(profiles|teams)$/.test(path) ? "id" : null;

export function sameSyncDocument(a: unknown, b: unknown, path = ""): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const field = keyField(path);
    if (field) {
      const rows = new Map(b.map(row => [object(row) ? row[field] : missing, row]));
      if (rows.size !== b.length) return false;
      return a.every(row => object(row) && rows.has(row[field]) && sameSyncDocument(row, rows.get(row[field]), `${path}/${row[field]}`));
    }
    return a.every((v, i) => sameSyncDocument(v, b[i], `${path}/${i}`));
  }
  if (!object(a) || !object(b)) return false;
  // Native card ID identifies ownership; generated instance IDs remain local locators.
  const fields = (v: Record<string, unknown>) => Object.keys(v).filter(k => !(k === "instanceId" && /\/(members|snapshots)\/[^/]+$/.test(path)));
  return fields(a).length === fields(b).length && fields(a).every(k => Object.hasOwn(b, k) && sameSyncDocument(a[k], b[k], `${path}/${k}`));
}

export function mergeSyncDocuments<T>(base: T, local: T, remote: T, priority?: "local" | "remote"): SyncMerge<T> {
  const conflicts: string[] = [];
  const clone = (v: unknown) => v === missing ? missing : structuredClone(v);
  const merge = (b: unknown, l: unknown, r: unknown, path: string): unknown => {
    if (sameSyncDocument(l, r, path)) return clone(l);
    if (sameSyncDocument(l, b, path)) return clone(r);
    if (sameSyncDocument(r, b, path)) return clone(l);
    const field = keyField(path);
    if (field && Array.isArray(l) && Array.isArray(r) && (Array.isArray(b) || b === missing)) {
      const index = (rows: unknown[]) => new Map(rows.map(row => {
        if (!object(row) || row[field] === undefined) throw new TypeError("sync-invalid-collection-identity");
        return [row[field], row] as const;
      }));
      const bm = index(b === missing ? [] : b as unknown[]), lm = index(l), rm = index(r);
      if (lm.size !== l.length || rm.size !== r.length || (Array.isArray(b) && bm.size !== b.length))
        throw new TypeError("sync-duplicate-collection-identity");
      const result: unknown[] = [];
      for (const id of new Set([...lm.keys(), ...rm.keys(), ...bm.keys()])) {
        const row = merge(bm.get(id) ?? missing, lm.get(id) ?? missing, rm.get(id) ?? missing, `${path}/${id}`);
        if (row !== missing) result.push(row);
      }
      return result;
    }
    if (/\/formation\/(memberCardIds|snapshotCardIds)$/.test(path) && Array.isArray(b) &&
        Array.isArray(l) && Array.isArray(r) && b.length === l.length && b.length === r.length)
      return b.map((value, index) => merge(value, l[index], r[index], `${path}/${index}`));
    if (object(l) && object(r) && (object(b) || b === missing)) {
      const result: Record<string, unknown> = {}, original = object(b) ? b : {};
      for (const field of new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(original)])) {
        const value = field === "instanceId" && /\/(members|snapshots)\/[^/]+$/.test(path)
          ? original[field] ?? r[field] ?? l[field]
          : merge(Object.hasOwn(original, field) ? original[field] : missing,
            Object.hasOwn(l, field) ? l[field] : missing, Object.hasOwn(r, field) ? r[field] : missing, `${path}/${field}`);
        if (value !== missing) result[field] = value;
      }
      return result;
    }
    conflicts.push(path || "/");
    return clone(priority === "remote" ? r : l);
  };
  const value = merge(base, local, remote, "") as T;
  const preserveLocators = (result: unknown, current: unknown, path: string): void => {
    if (Array.isArray(result) && Array.isArray(current)) {
      const field = keyField(path), rows = field ? new Map(current.filter(object).map(row => [row[field], row])) : null;
      result.forEach((row, i) => preserveLocators(row, rows && object(row) ? rows.get(row[field!]) : current[i], `${path}/${field && object(row) ? row[field] : i}`));
    } else if (object(result) && object(current)) {
      if (/\/(members|snapshots)\/[^/]+$/.test(path) && typeof current.instanceId === "string") result.instanceId = current.instanceId;
      for (const key of Object.keys(result)) if (Object.hasOwn(current, key)) preserveLocators(result[key], current[key], `${path}/${key}`);
    }
  };
  preserveLocators(value, local, "");
  return { value, conflicts };
}
