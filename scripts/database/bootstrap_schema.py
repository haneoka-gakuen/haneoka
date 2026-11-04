# L3 — GEB
# Input: The complete target schema and project-local Wrangler configuration.
# Output: A fresh local D1 database bootstrapped in bounded SQL batches.
# Pos: [Map](L2-2.md); local schema bootstrap alongside migration operations.
# Effects/Dependencies: Reads repository SQL and runs local-only Wrangler; temporary SQL files are removed after execution.
from pathlib import Path
import sqlite3
import subprocess
import tempfile


def main():
    root = Path(__file__).resolve().parents[2]
    statements, current = [], ""
    for line in (root / "worker/database/schema.sql").read_text().splitlines(keepends=True):
        current += line
        if sqlite3.complete_statement(current):
            statements.append(current)
            current = ""
    if current.strip():
        raise ValueError("Incomplete SQL in database schema")
    batches, batch, size = [], [], 0
    for statement in statements:
        length = len(statement.encode())
        if batch and size + length > 64_000:
            batches.append("".join(batch))
            batch, size = [], 0
        batch.append(statement)
        size += length
    if batch:
        batches.append("".join(batch))
    with tempfile.TemporaryDirectory(prefix="haneoka-schema-") as directory:
        for index, sql in enumerate(batches):
            path = Path(directory) / f"{index}.sql"
            path.write_text(sql)
            subprocess.run(["pnpm", "exec", "wrangler", "d1", "execute", "haneoka-community", "--local", "--file", str(path)],
                           cwd=root, check=True)


if __name__ == "__main__":
    main()
