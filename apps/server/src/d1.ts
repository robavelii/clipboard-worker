/**
 * The D1 binding, on `node:sqlite`.
 *
 * Only the part of D1's API the Worker uses: `prepare().bind()` with
 * `first`/`all`/`run`, and `batch`. The semantics the routes rely on are
 * kept exactly:
 *
 *   - `batch` is one transaction: all of it commits, or none of it.
 *   - `meta.changes` counts the rows a statement changed, RETURNING or not.
 *     Conditional writes are the Worker's mutexes, so this must be exact.
 *   - `first()` is the first row or null; `first(column)` one value.
 *   - booleans bind as 1/0 and `undefined` is refused, as D1 does.
 *   - foreign keys are enforced (D1 turns them on), so ON DELETE CASCADE works.
 *
 * node:sqlite is synchronous, so a statement or a batch runs to completion
 * before any other request's code: there is no interleaving to guard against
 * within one process.
 *
 * SQLite is loaded when a database opens, not imported: the `clipsync`
 * agent's bundle carries this server, and a bundled static import would load
 * it, and print Node's experimental warning, for every command (decisions §40).
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";

type SqlValue = null | number | bigint | string | Uint8Array;

export interface D1Meta {
  changes: number;
  last_row_id: number;
  duration: number;
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
  size_after: number;
}

export interface D1Result<T = Record<string, unknown>> {
  success: true;
  results: T[];
  meta: D1Meta;
}

function toSql(value: unknown, index: number): SqlValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`D1_TYPE_ERROR: Type '${typeof value}' not supported for value at index ${index}`);
}

export class SqlitePreparedStatement {
  constructor(
    private readonly d1: SqliteD1,
    readonly sql: string,
    readonly params: SqlValue[] = [],
  ) {}

  bind(...values: unknown[]): SqlitePreparedStatement {
    return new SqlitePreparedStatement(this.d1, this.sql, values.map(toSql));
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.d1.execute<Record<string, unknown>>(this).results[0];
    if (!row) return null;
    if (column === undefined) return row as T;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.d1.execute<T>(this);
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.d1.execute<T>(this);
  }

  async raw(): Promise<never> {
    throw new Error("raw() is not implemented by the Node D1 binding");
  }
}

export class SqliteD1 {
  readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly totalChanges: StatementSync;
  private readonly lastRowId: StatementSync;

  constructor(path: string) {
    const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    this.db = new sqlite.DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.totalChanges = this.db.prepare("SELECT total_changes() AS n");
    this.lastRowId = this.db.prepare("SELECT last_insert_rowid() AS id");
  }

  prepare(sql: string): SqlitePreparedStatement {
    return new SqlitePreparedStatement(this, sql);
  }

  async batch<T = Record<string, unknown>>(statements: SqlitePreparedStatement[]): Promise<D1Result<T>[]> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((s) => this.execute<T>(s));
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Runs several statements of SQL text, as migrations are written. */
  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }

  close(): void {
    this.db.close();
  }

  /** @internal Runs one statement and describes it the way D1 does. */
  execute<T>(statement: SqlitePreparedStatement): D1Result<T> {
    const started = performance.now();
    let prepared = this.statements.get(statement.sql);
    if (!prepared) {
      prepared = this.db.prepare(statement.sql);
      this.statements.set(statement.sql, prepared);
    }
    // total_changes() before and after, rather than the statement's own
    // count: `all()` is needed to read RETURNING rows, and it reports none.
    const before = this.changeCount();
    const rows = prepared.all(...statement.params) as Record<string, unknown>[];
    const changes = this.changeCount() - before;
    const lastRowId = Number((this.lastRowId.get() as { id: number | bigint }).id);
    return {
      success: true,
      // node:sqlite rows have a null prototype; D1's are plain objects.
      results: rows.map((row) => ({ ...row }) as T),
      meta: {
        changes,
        last_row_id: lastRowId,
        duration: performance.now() - started,
        rows_read: rows.length,
        rows_written: changes,
        changed_db: changes > 0,
        size_after: 0,
      },
    };
  }

  private changeCount(): number {
    return Number((this.totalChanges.get() as { n: number | bigint }).n);
  }
}

/**
 * Applies the Worker's migrations in order, each once, recording them in the
 * same table wrangler uses, so a database copied from D1 carries on from
 * where it was.
 */
export function migrate(d1: SqliteD1, migrations: { name: string; sql: string }[]): string[] {
  const { db } = d1;
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const applied = new Set(
    (db.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const ran: string[] = [];
  for (const migration of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (applied.has(migration.name)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(migration.name);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${migration.name} failed: ${String(error)}`);
    }
    ran.push(migration.name);
  }
  return ran;
}
