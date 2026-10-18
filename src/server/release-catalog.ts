// L3 — GEB
// Input: 本地项目／release 路径、server 与选择环境。
// Output: 经身份、清单和路径校验的 ReleaseCatalog 或带边界的错误。
// Pos: [Map](L2-2.md)；构建期不可变 release 读取器。
// Effects/Dependencies: Node 文件系统、JSON 和摘要；本文件读取本地来源，HTTP 回退由上层决定。
import { projectUiMarks } from "../lib/ui-marks.ts";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const CURRENT_POINTER_SCHEMA = "haneoka-resource-pointer-v1";
const RELEASE_IDENTITY_SCHEMA = "haneoka-resource-release-identity-v1";
const CATALOG_STORAGE_SCHEMA = "haneoka-catalog-storage-v2";
const CATALOG_PARTITION_ALGORITHM = "fnv1a32-mod-256";
const CATALOG_PARTITION_SHARDS = 256;
const RELEASE_ID_PATTERN = /^r-[a-f0-9]{20}$/u;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SERVER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CATALOG_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const CATALOG_ROUTE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,255}$/u;
const SHARD_PATTERN = /^[a-f0-9]{2}$/u;

export type CatalogJson = null | boolean | number | string | CatalogJson[] | { [key: string]: CatalogJson };
export type CatalogRecord = { [key: string]: CatalogJson };

export interface ReleaseCatalogIdentity {
  readonly server: string;
  readonly releaseId: string;
  readonly sourceId: string;
}

export interface ReleaseCatalogOptions {
  /** Project root containing `data/servers`; defaults to `process.cwd()`. */
  readonly projectRoot?: string;
  /** Explicit immutable release root, useful for a pinned build or a verifier. */
  readonly releaseRoot?: string;
  /** Environment used for RESOURCE_RELEASE_ROOT and project-root selection. */
  readonly env?: NodeJS.ProcessEnv;
}

export type ReleaseCatalogErrorCode =
  | "release_unavailable"
  | "release_identity_invalid"
  | "release_manifest_invalid"
  | "catalog_manifest_invalid"
  | "catalog_path_missing"
  | "catalog_resource_missing"
  | "catalog_view_missing"
  | "catalog_relation_missing"
  | "catalog_entity_not_found"
  | "catalog_entity_invalid";

/**
 * A typed local-source failure. Callers may use `status`/`code` when falling
 * back to the pinned HTTP API, while `fallbackToHttp` prevents an unpinned
 * current release from being mixed into a failed local identity.
 */
export class ReleaseCatalogError extends Error {
  readonly name = "ReleaseCatalogError";

  constructor(
    readonly code: ReleaseCatalogErrorCode,
    readonly status: 404 | 502 | 503,
    message: string,
    readonly path?: string,
    readonly fallbackToHttp = false,
  ) {
    super(message);
  }
}

export interface CatalogShardStorage {
  readonly count: number;
  readonly prefix: string;
  readonly shards: ReadonlySet<string>;
}

export interface CatalogRelationStorage extends CatalogShardStorage {
  readonly entityCount: number;
  readonly valueMode: "ids" | "records";
}

export interface CatalogViewStorage {
  readonly count: number;
  readonly entities: CatalogShardStorage;
  readonly index: string;
  readonly path: readonly string[];
  readonly shape: "array" | "object";
}

export interface CatalogResourceStorage {
  readonly count: number;
  readonly dependencies: ReadonlySet<string>;
  readonly entities: CatalogShardStorage | null;
  readonly index: string;
  readonly kind: string;
  readonly relations: Readonly<Record<string, CatalogRelationStorage>>;
  readonly views: Readonly<Record<string, CatalogViewStorage>>;
}

export interface CatalogStorageManifest {
  readonly document: CatalogRecord;
  readonly resources: Readonly<Record<string, CatalogResourceStorage>>;
  readonly summary: string;
}

export interface CatalogEntityBatch {
  readonly items: ReadonlyMap<string, CatalogRecord>;
  readonly missing: readonly string[];
}

interface ReleaseEntry {
  readonly bytes: number;
  readonly mediaType: string;
  readonly path: string;
  readonly role: string;
  readonly sha256: string;
}

interface ReleaseManifest {
  readonly entries: ReadonlyMap<string, ReleaseEntry>;
}

const isRecord = (value: unknown): value is CatalogRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: CatalogRecord, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function expectedKeys(value: CatalogRecord, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function jsonValue(value: unknown, file: string): CatalogJson {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, file));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry, file)]));
  }
  throw new ReleaseCatalogError("catalog_path_missing", 502, `Invalid JSON value: ${file}`, file);
}

function readJsonFile(file: string): CatalogJson {
  try {
    return jsonValue(JSON.parse(fs.readFileSync(file, "utf8")), file);
  } catch (error) {
    if (error instanceof ReleaseCatalogError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ReleaseCatalogError("catalog_path_missing", 502, `Unable to read JSON: ${file}: ${message}`, file);
  }
}

function readObjectFile(file: string, label: string): CatalogRecord {
  const value = readJsonFile(file);
  if (!isRecord(value)) {
    throw new ReleaseCatalogError("catalog_manifest_invalid", 502, `${label} must be an object: ${file}`, file);
  }
  return value;
}

function normalizeServer(value: string): string {
  if (!SERVER_ID_PATTERN.test(value)) {
    throw new ReleaseCatalogError("release_identity_invalid", 502, `Invalid release server: ${value}`);
  }
  return value;
}

function safeRelativePath(value: string, label: string): string {
  if (!value || value.includes("\\") || value.startsWith("/") || value.includes("//")) {
    throw new ReleaseCatalogError("release_manifest_invalid", 502, `Invalid ${label}: ${value}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    throw new ReleaseCatalogError("release_manifest_invalid", 502, `Invalid ${label}: ${value}`);
  }
  return value;
}

function releaseFile(root: string, relative: string): string {
  const normalized = safeRelativePath(relative, "release path");
  const file = path.resolve(root, ...normalized.split("/"));
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    throw new ReleaseCatalogError("release_manifest_invalid", 502, `Release path escapes root: ${relative}`, relative);
  }
  return file;
}

function requireSafeInteger(value: CatalogJson | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ReleaseCatalogError("catalog_manifest_invalid", 502, `Invalid catalog count: ${label}`);
  }
  return value;
}

function fnv1a32Shard(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % CATALOG_PARTITION_SHARDS).toString(16).padStart(2, "0");
}

function parseShardStorage(value: CatalogJson | undefined, label: string): CatalogShardStorage {
  if (!isRecord(value) || typeof value.prefix !== "string" || !Array.isArray(value.shards)) {
    throw new ReleaseCatalogError("catalog_manifest_invalid", 502, `Invalid catalog shard storage: ${label}`);
  }
  const count = requireSafeInteger(value.count, `${label}:count`);
  if (!value.prefix.endsWith("/")) {
    throw new ReleaseCatalogError("catalog_manifest_invalid", 502, `Catalog shard prefix must end in /: ${label}`);
  }
  const prefix = `${safeRelativePath(value.prefix.slice(0, -1), `${label}:prefix`)}/`;
  const shards = new Set<string>();
  for (const shard of value.shards) {
    if (typeof shard !== "string" || !SHARD_PATTERN.test(shard) || shards.has(shard)) {
      throw new ReleaseCatalogError("catalog_manifest_invalid", 502, `Invalid catalog shard: ${label}`);
    }
    shards.add(shard);
  }
  if ((count === 0) !== (shards.size === 0)) {
    throw new ReleaseCatalogError("catalog_manifest_invalid", 502, `Empty catalog shard storage mismatch: ${label}`);
  }
  return { count, prefix, shards };
}

function parseReleaseManifest(value: CatalogJson, server: string, releaseId: string): ReleaseManifest {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new ReleaseCatalogError("release_manifest_invalid", 502, `Invalid release manifest: ${server}/${releaseId}`);
  }
  const entries = new Map<string, ReleaseEntry>();
  for (const raw of value.entries) {
    if (
      !isRecord(raw) ||
      typeof raw.path !== "string" ||
      typeof raw.role !== "string" ||
      typeof raw.mediaType !== "string" ||
      typeof raw.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(raw.sha256) ||
      typeof raw.bytes !== "number" ||
      !Number.isSafeInteger(raw.bytes) ||
      raw.bytes < 0
    ) {
      throw new ReleaseCatalogError(
        "release_manifest_invalid",
        502,
        `Invalid release manifest entry: ${server}/${releaseId}`,
      );
    }
    const entryPath = safeRelativePath(raw.path, "release manifest path");
    if (entries.has(entryPath)) {
      throw new ReleaseCatalogError("release_manifest_invalid", 502, `Duplicate release manifest path: ${entryPath}`);
    }
    entries.set(entryPath, {
      bytes: raw.bytes,
      mediaType: raw.mediaType,
      path: entryPath,
      role: raw.role,
      sha256: raw.sha256,
    });
  }
  return { entries };
}

function parseIdentity(value: CatalogRecord, server: string, releaseId: string): ReleaseCatalogIdentity {
  if (
    !expectedKeys(value, ["releaseId", "schema", "server", "sourceId"]) ||
    value.schema !== RELEASE_IDENTITY_SCHEMA ||
    value.server !== server ||
    value.releaseId !== releaseId ||
    typeof value.sourceId !== "string" ||
    !SOURCE_ID_PATTERN.test(value.sourceId)
  ) {
    throw new ReleaseCatalogError(
      "release_identity_invalid",
      502,
      `Invalid release identity descriptor: ${server}/${releaseId}/release-identity.json`,
    );
  }
  return { releaseId, server, sourceId: value.sourceId };
}

function parseCurrentPointer(value: CatalogRecord, server: string): { releaseId: string; sourceId: string } {
  const { pipelineFingerprint, producerGitSha, ...identity } = value;
  if (
    !expectedKeys(identity, ["releaseId", "releaseIndex", "releaseManifest", "schema", "server", "sourceId"]) ||
    (hasOwn(value, "pipelineFingerprint") &&
      (typeof pipelineFingerprint !== "string" || !/^(?:[a-f0-9]{16})?$/u.test(pipelineFingerprint))) ||
    (hasOwn(value, "producerGitSha") &&
      (typeof producerGitSha !== "string" || !/^[a-f0-9]{40}$/u.test(producerGitSha))) ||
    value.schema !== CURRENT_POINTER_SCHEMA ||
    value.server !== server ||
    typeof value.releaseId !== "string" ||
    !RELEASE_ID_PATTERN.test(value.releaseId) ||
    typeof value.sourceId !== "string" ||
    !SOURCE_ID_PATTERN.test(value.sourceId) ||
    value.releaseManifest !== `servers/${server}/releases/${value.releaseId}/release.json` ||
    !isRecord(value.releaseIndex) ||
    value.releaseIndex.algorithm !== CATALOG_PARTITION_ALGORITHM ||
    value.releaseIndex.shards !== CATALOG_PARTITION_SHARDS ||
    value.releaseIndex.prefix !== `servers/${server}/releases/${value.releaseId}/index/`
  ) {
    throw new ReleaseCatalogError("release_identity_invalid", 502, `Invalid local release pointer: ${server}`);
  }
  return { releaseId: value.releaseId, sourceId: value.sourceId };
}

function parseCatalogManifest(value: CatalogRecord, identity: ReleaseCatalogIdentity): CatalogStorageManifest {
  if (
    value.schema !== CATALOG_STORAGE_SCHEMA ||
    value.server !== identity.server ||
    value.sourceId !== identity.sourceId ||
    typeof value.summary !== "string" ||
    value.summary !== "api/v1/catalog/summary.json" ||
    !isRecord(value.partition) ||
    value.partition.algorithm !== CATALOG_PARTITION_ALGORITHM ||
    value.partition.shards !== CATALOG_PARTITION_SHARDS ||
    !isRecord(value.resources)
  ) {
    throw new ReleaseCatalogError(
      "catalog_manifest_invalid",
      502,
      `Invalid catalog storage manifest: ${identity.server}`,
    );
  }

  const resources: Record<string, CatalogResourceStorage> = {};
  const resourceNames = new Set(Object.keys(value.resources));
  for (const [name, raw] of Object.entries(value.resources)) {
    if (
      !CATALOG_NAME_PATTERN.test(name) ||
      !isRecord(raw) ||
      typeof raw.kind !== "string" ||
      typeof raw.index !== "string" ||
      raw.index !== `api/v1/catalog/${name}/index.json` ||
      !Array.isArray(raw.dependencies)
    ) {
      throw new ReleaseCatalogError("catalog_manifest_invalid", 502, `Invalid catalog resource: ${name}`);
    }
    const dependencies = new Set<string>();
    for (const dependency of raw.dependencies) {
      if (typeof dependency !== "string" || !resourceNames.has(dependency) || dependency === name) {
        throw new ReleaseCatalogError("catalog_manifest_invalid", 502, `Invalid catalog dependency: ${name}`);
      }
      dependencies.add(dependency);
    }
    const entities = raw.entities === undefined ? null : parseShardStorage(raw.entities, `${name}:entities`);
    if (entities && entities.prefix !== `api/v1/catalog/${name}/entities/`) {
      throw new ReleaseCatalogError("catalog_manifest_invalid", 502, `Non-canonical entity storage: ${name}`);
    }

    const relations: Record<string, CatalogRelationStorage> = {};
    if (raw.relations !== undefined) {
      if (!isRecord(raw.relations)) {
        throw new ReleaseCatalogError("catalog_manifest_invalid", 502, `Invalid catalog relations: ${name}`);
      }
      for (const [relationName, relationValue] of Object.entries(raw.relations)) {
        if (!CATALOG_NAME_PATTERN.test(relationName) || !isRecord(relationValue)) {
          throw new ReleaseCatalogError(
            "catalog_manifest_invalid",
            502,
            `Invalid catalog relation: ${name}:${relationName}`,
          );
        }
        const storage = parseShardStorage(relationValue, `${name}:relations:${relationName}`);
        if (
          storage.prefix !== `api/v1/catalog/${name}/relations/${relationName}/` ||
          !["ids", "records"].includes(String(relationValue.valueMode))
        ) {
          throw new ReleaseCatalogError(
            "catalog_manifest_invalid",
            502,
            `Invalid catalog relation storage: ${name}:${relationName}`,
          );
        }
        relations[relationName] = {
          ...storage,
          entityCount: requireSafeInteger(relationValue.entityCount, `${name}:relations:${relationName}:entityCount`),
          valueMode: relationValue.valueMode as "ids" | "records",
        };
      }
    }

    const views: Record<string, CatalogViewStorage> = {};
    if (raw.views !== undefined) {
      if (!isRecord(raw.views)) {
        throw new ReleaseCatalogError("catalog_manifest_invalid", 502, `Invalid catalog views: ${name}`);
      }
      for (const [viewName, viewValue] of Object.entries(raw.views)) {
        if (
          !CATALOG_NAME_PATTERN.test(viewName) ||
          !isRecord(viewValue) ||
          typeof viewValue.index !== "string" ||
          viewValue.index !== `api/v1/catalog/${name}/views/${viewName}/index.json` ||
          !Array.isArray(viewValue.path) ||
          viewValue.path.some((part) => typeof part !== "string") ||
          !["array", "object"].includes(String(viewValue.shape))
        ) {
          throw new ReleaseCatalogError("catalog_manifest_invalid", 502, `Invalid catalog view: ${name}:${viewName}`);
        }
        const viewEntities = parseShardStorage(viewValue.entities, `${name}:views:${viewName}:entities`);
        const count = requireSafeInteger(viewValue.count, `${name}:views:${viewName}:count`);
        const viewPrefix = `api/v1/catalog/${name}/views/${viewName}/`;
        if (viewEntities.prefix !== `${viewPrefix}entities/` || viewEntities.count !== count) {
          throw new ReleaseCatalogError(
            "catalog_manifest_invalid",
            502,
            `Non-canonical catalog view: ${name}:${viewName}`,
          );
        }
        views[viewName] = {
          count,
          entities: viewEntities,
          index: viewValue.index,
          path: viewValue.path as string[],
          shape: viewValue.shape as "array" | "object",
        };
      }
    }
    resources[name] = {
      count: requireSafeInteger(raw.count, name),
      dependencies,
      entities,
      index: raw.index,
      kind: raw.kind,
      relations,
      views,
    };
  }
  return { document: value, resources, summary: value.summary };
}

function missingFile(file: string, fallbackToHttp: boolean): never {
  throw new ReleaseCatalogError("catalog_path_missing", 502, `Catalog file is missing: ${file}`, file, fallbackToHttp);
}

export class ReleaseCatalog {
  readonly identity: ReleaseCatalogIdentity;
  readonly releaseRoot: string;
  readonly manifest: CatalogStorageManifest;
  private readonly releaseManifest: ReleaseManifest;
  private readonly shardDocuments = new Map<string, CatalogRecord>();

  constructor(
    releaseRoot: string,
    identity: ReleaseCatalogIdentity,
    releaseManifest: ReleaseManifest,
    manifest: CatalogStorageManifest,
  ) {
    this.releaseRoot = releaseRoot;
    this.identity = identity;
    this.releaseManifest = releaseManifest;
    this.manifest = manifest;
  }

  private resource(name: string): CatalogResourceStorage {
    if (!CATALOG_NAME_PATTERN.test(name)) {
      throw new ReleaseCatalogError("catalog_resource_missing", 404, `Invalid catalog resource: ${name}`);
    }
    const value = this.manifest.resources[name];
    if (!value) {
      throw new ReleaseCatalogError("catalog_resource_missing", 404, `Catalog resource is missing: ${name}`);
    }
    return value;
  }

  private declaredApiFile(releasePath: string): string {
    const normalized = safeRelativePath(releasePath, "catalog release path");
    if (!normalized.startsWith("api/v1/catalog/")) {
      throw new ReleaseCatalogError("catalog_path_missing", 502, `Catalog path is outside API storage: ${normalized}`);
    }
    const entry = this.releaseManifest.entries.get(normalized);
    if (!entry || entry.role !== "api") {
      throw new ReleaseCatalogError(
        "catalog_path_missing",
        502,
        `Catalog path is not declared by release: ${normalized}`,
      );
    }
    const file = releaseFile(this.releaseRoot, normalized);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) missingFile(file, true);
    return file;
  }

  private readApiJson(releasePath: string): CatalogJson {
    return readJsonFile(this.declaredApiFile(releasePath));
  }

  private readShard(storage: CatalogShardStorage, key: string): CatalogRecord | null {
    if (!CATALOG_ROUTE_KEY_PATTERN.test(key)) {
      throw new ReleaseCatalogError("catalog_entity_not_found", 404, `Invalid catalog route key: ${key}`);
    }
    const shard = fnv1a32Shard(key);
    if (!storage.shards.has(shard)) return null;
    const file = `${storage.prefix}${shard}.json`;
    const cached = this.shardDocuments.get(file);
    if (cached) return cached;
    const document = this.readApiJson(file);
    if (!isRecord(document)) {
      throw new ReleaseCatalogError(
        "catalog_manifest_invalid",
        502,
        `Catalog shard must be an object: ${storage.prefix}${shard}.json`,
      );
    }
    this.shardDocuments.set(file, document);
    return document;
  }

  readCollection(resource: string): CatalogJson {
    return this.readApiJson(this.resource(resource).index);
  }

  readReleaseJson(relative: string): CatalogJson {
    if (!relative.endsWith(".json"))
      throw new ReleaseCatalogError("catalog_path_missing", 404, `Release JSON is not declared: ${relative}`);
    return jsonValue(JSON.parse(this.readReleaseBytes(relative).toString("utf8")), relative);
  }
  readReleaseBytes(relative: string): Buffer {
    const normalized = safeRelativePath(relative, "release file path");
    const entry = this.releaseManifest.entries.get(normalized);
    if (!entry)
      throw new ReleaseCatalogError("catalog_path_missing", 404, `Release file is not declared: ${normalized}`);
    const file = releaseFile(this.releaseRoot, normalized);
    if (!fs.existsSync(file)) missingFile(file, true);
    const body = fs.readFileSync(file);
    if (body.length !== entry.bytes || createHash("sha256").update(body).digest("hex") !== entry.sha256)
      throw new ReleaseCatalogError("release_manifest_invalid", 502, `Release file hash mismatch: ${normalized}`);
    return body;
  }
  releaseEntry(relative: string): Readonly<ReleaseEntry> | undefined {
    return this.releaseManifest.entries.get(safeRelativePath(relative, "release entry path"));
  }

  readSummary(): CatalogJson {
    return this.readApiJson(this.manifest.summary);
  }

  readSource(sourcePath: string): CatalogRecord {
    const source = safeRelativePath(sourcePath, "source descriptor path");
    if (!source.startsWith("Assets/") && !source.startsWith("Packages/"))
      throw new ReleaseCatalogError("catalog_path_missing", 404, "Source descriptor is outside asset storage");
    const relative = `metadata/sources/${source}.json`;
    if (!this.releaseManifest.entries.has(relative))
      throw new ReleaseCatalogError("catalog_path_missing", 404, `Source descriptor is not declared: ${source}`);
    const file = releaseFile(this.releaseRoot, relative);
    if (!fs.existsSync(file)) missingFile(file, true);
    return readObjectFile(file, "Source descriptor");
  }

  readUiMarks(): Record<string, string> {
    const relative = "metadata/sources/Assets/AddressableResources/UI/Atlas/FixUiSpriteAtlas.spriteatlasv2.json";
    if (!this.releaseManifest.entries.has(relative)) {
      throw new ReleaseCatalogError("catalog_path_missing", 502, "UI atlas descriptor is not declared by the release");
    }
    const file = releaseFile(this.releaseRoot, relative);
    if (!fs.existsSync(file)) missingFile(file, true);
    const descriptor = readObjectFile(file, "UI atlas descriptor");
    return projectUiMarks(descriptor);
  }

  readView(resource: string, view: string): CatalogJson {
    const storage = this.resource(resource).views[view];
    if (!storage) {
      throw new ReleaseCatalogError("catalog_view_missing", 404, `Catalog view is missing: ${resource}/${view}`);
    }
    return this.readApiJson(storage.index);
  }

  readEntity(resource: string, id: string): CatalogRecord | null {
    const storage = this.resource(resource).entities;
    if (!storage) return null;
    const document = this.readShard(storage, id);
    const value = document && hasOwn(document, id) ? document[id] : undefined;
    if (value === undefined) return null;
    if (!isRecord(value)) {
      throw new ReleaseCatalogError(
        "catalog_entity_invalid",
        502,
        `Catalog entity is not an object: ${resource}/${id}`,
      );
    }
    return value;
  }

  requireEntity(resource: string, id: string): CatalogRecord {
    const entity = this.readEntity(resource, id);
    if (!entity) {
      throw new ReleaseCatalogError("catalog_entity_not_found", 404, `Catalog entity not found: ${resource}/${id}`);
    }
    return entity;
  }

  readViewEntity(resource: string, view: string, id: string): CatalogRecord | null {
    const storage = this.resource(resource).views[view];
    if (!storage) {
      throw new ReleaseCatalogError("catalog_view_missing", 404, `Catalog view is missing: ${resource}/${view}`);
    }
    const document = this.readShard(storage.entities, id);
    const value = document && hasOwn(document, id) ? document[id] : undefined;
    if (value === undefined) return null;
    if (!isRecord(value)) {
      throw new ReleaseCatalogError(
        "catalog_entity_invalid",
        502,
        `Catalog view entity is not an object: ${resource}/${view}/${id}`,
      );
    }
    return value;
  }

  readEntities(resource: string, ids: readonly string[]): CatalogEntityBatch {
    const uniqueIds = [...new Set(ids)];
    const items = new Map<string, CatalogRecord>();
    const missing: string[] = [];
    for (const id of uniqueIds) {
      const entity = this.readEntity(resource, id);
      if (entity) items.set(id, entity);
      else missing.push(id);
    }
    return { items, missing };
  }

  requireEntities(resource: string, ids: readonly string[]): ReadonlyMap<string, CatalogRecord> {
    const result = this.readEntities(resource, ids);
    if (result.missing.length) {
      throw new ReleaseCatalogError(
        "catalog_entity_not_found",
        404,
        `Catalog entity batch omitted: ${resource}/${result.missing.join(",")}`,
      );
    }
    return result.items;
  }

  readRelationIds(resource: string, relation: string, key: string): readonly string[] {
    const storage = this.resource(resource).relations[relation];
    if (!storage) {
      throw new ReleaseCatalogError(
        "catalog_relation_missing",
        404,
        `Catalog relation is missing: ${resource}/${relation}`,
      );
    }
    const document = this.readShard(storage, key);
    const value = document && hasOwn(document, key) ? document[key] : undefined;
    if (value === undefined) return [];
    if (storage.valueMode !== "ids" || !Array.isArray(value) || value.some((id) => typeof id !== "string")) {
      throw new ReleaseCatalogError(
        "catalog_entity_invalid",
        502,
        `Catalog relation is not an id list: ${resource}/${relation}/${key}`,
      );
    }
    return value as string[];
  }

  readRelation(resource: string, relation: string, key: string): CatalogRecord {
    const storage = this.resource(resource).relations[relation];
    if (!storage) {
      throw new ReleaseCatalogError(
        "catalog_relation_missing",
        404,
        `Catalog relation is missing: ${resource}/${relation}`,
      );
    }
    const document = this.readShard(storage, key);
    const value = document && hasOwn(document, key) ? document[key] : undefined;
    if (value === undefined) return {};
    if (storage.valueMode === "records") {
      if (!isRecord(value)) {
        throw new ReleaseCatalogError(
          "catalog_entity_invalid",
          502,
          `Catalog relation records are invalid: ${resource}/${relation}/${key}`,
        );
      }
      return value;
    }
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
      throw new ReleaseCatalogError(
        "catalog_entity_invalid",
        502,
        `Catalog relation ids are invalid: ${resource}/${relation}/${key}`,
      );
    }
    const entities = this.requireEntities(resource, value as string[]);
    return Object.fromEntries(entities);
  }
}

function readIdentityFromRoot(releaseRoot: string, server: string, releaseId: string): ReleaseCatalogIdentity {
  const identityFile = releaseFile(releaseRoot, "release-identity.json");
  if (!fs.existsSync(identityFile)) {
    throw new ReleaseCatalogError(
      "release_unavailable",
      503,
      `Release identity is missing: ${identityFile}`,
      identityFile,
      false,
    );
  }
  return parseIdentity(readObjectFile(identityFile, "Release identity"), server, releaseId);
}

export function openReleaseCatalog(server = "intl", options: ReleaseCatalogOptions = {}): ReleaseCatalog {
  const normalizedServer = normalizeServer(server);
  const env = options.env ?? process.env;
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  let releaseRoot = options.releaseRoot ?? env.RESOURCE_RELEASE_ROOT;
  let releaseId: string;
  let pointerSourceId: string | undefined;

  if (releaseRoot) {
    releaseRoot = path.resolve(releaseRoot);
    releaseId = path.basename(releaseRoot);
    if (!RELEASE_ID_PATTERN.test(releaseId)) {
      throw new ReleaseCatalogError("release_identity_invalid", 502, `Invalid explicit release root: ${releaseRoot}`);
    }
  } else {
    const pointerFile = path.join(projectRoot, "data", "servers", normalizedServer, "current.json");
    if (!fs.existsSync(pointerFile)) {
      throw new ReleaseCatalogError(
        "release_unavailable",
        503,
        `Local release pointer is missing: ${pointerFile}`,
        pointerFile,
        false,
      );
    }
    const pointer = readObjectFile(pointerFile, "Release pointer");
    const selected = parseCurrentPointer(pointer, normalizedServer);
    releaseId = selected.releaseId;
    pointerSourceId = selected.sourceId;
    releaseRoot = path.join(projectRoot, "data", "servers", normalizedServer, "releases", releaseId);
  }

  if (!fs.existsSync(releaseRoot) || !fs.statSync(releaseRoot).isDirectory()) {
    throw new ReleaseCatalogError(
      "release_unavailable",
      503,
      `Local release root is missing: ${releaseRoot}`,
      releaseRoot,
      false,
    );
  }
  const identity = readIdentityFromRoot(releaseRoot, normalizedServer, releaseId);
  if (pointerSourceId && pointerSourceId !== identity.sourceId) {
    throw new ReleaseCatalogError(
      "release_identity_invalid",
      502,
      `Release pointer source mismatch: ${normalizedServer}/${releaseId}`,
    );
  }
  const releaseManifestFile = releaseFile(releaseRoot, "release.json");
  if (!fs.existsSync(releaseManifestFile)) {
    throw new ReleaseCatalogError(
      "release_manifest_invalid",
      502,
      `Release manifest is missing: ${releaseManifestFile}`,
      releaseManifestFile,
    );
  }
  const releaseManifest = parseReleaseManifest(readJsonFile(releaseManifestFile), normalizedServer, releaseId);
  const catalogManifestPath = "api/v1/catalog/manifest.json";
  const catalogEntry = releaseManifest.entries.get(catalogManifestPath);
  if (!catalogEntry || catalogEntry.role !== "api") {
    throw new ReleaseCatalogError(
      "catalog_manifest_invalid",
      502,
      `Catalog manifest is not declared: ${catalogManifestPath}`,
    );
  }
  const catalogManifest = parseCatalogManifest(
    readObjectFile(releaseFile(releaseRoot, catalogManifestPath), "Catalog storage manifest"),
    identity,
  );
  return new ReleaseCatalog(releaseRoot, identity, releaseManifest, catalogManifest);
}

export function isReleaseCatalogError(value: unknown): value is ReleaseCatalogError {
  return value instanceof ReleaseCatalogError;
}
