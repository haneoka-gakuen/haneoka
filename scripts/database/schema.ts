import { DatabaseSync } from "node:sqlite";

export interface SchemaObject {
  name: string;
  sql: string;
  tableName: string;
  type: "index" | "table" | "trigger" | "view";
}

export const schemaObjectKey = (object: Pick<SchemaObject, "name" | "type">): string => `${object.type}:${object.name}`;

export const canonicalSql = (sql: string): string => {
  let output = "";
  let quote: "'" | '"' | "`" | "]" | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (!character) continue;

    if (quote) {
      output += character;
      if (quote === "]") {
        if (character === "]") quote = null;
        continue;
      }
      if (character !== quote) continue;
      if (sql[index + 1] === quote) {
        output += quote;
        index += 1;
      } else {
        quote = null;
      }
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      output += character;
    } else if (character === "[") {
      quote = "]";
      output += character;
    } else if (!/\s/.test(character)) {
      output += character.toLocaleLowerCase("en-US");
    }
  }

  return output
    .replace(/^createtableifnotexists/, "createtable")
    .replace(/^createviewifnotexists/, "createview")
    .replace(/^createindexifnotexists/, "createindex")
    .replace(/^createuniqueindexifnotexists/, "createuniqueindex")
    .replace(/^createtriggerifnotexists/, "createtrigger");
};

const d1InfrastructureTables = new Set(["_cf_KV", "_cf_METADATA", "d1_migrations"]);

export const isApplicationSchemaObject = (object: SchemaObject): boolean =>
  !d1InfrastructureTables.has(object.name) && !d1InfrastructureTables.has(object.tableName);

export const readSchemaObjects = (database: DatabaseSync): SchemaObject[] =>
  database
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
       ORDER BY rowid`,
    )
    .all()
    .map((row) => {
      if (
        typeof row.type !== "string" ||
        !["index", "table", "trigger", "view"].includes(row.type) ||
        typeof row.name !== "string" ||
        typeof row.tableName !== "string" ||
        typeof row.sql !== "string"
      ) {
        throw new Error("SQLite returned an invalid schema object");
      }
      return {
        type: row.type as SchemaObject["type"],
        name: row.name,
        tableName: row.tableName,
        sql: row.sql,
      };
    });

export const createDatabase = (statements: readonly string[]): DatabaseSync => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const statement of statements) database.exec(statement);
  const violations = database.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) throw new Error(`Schema produced ${violations.length} foreign-key violation(s)`);
  return database;
};
