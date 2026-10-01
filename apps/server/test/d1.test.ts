import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, SqliteD1 } from "../src/d1";

let d1: SqliteD1;

beforeEach(async () => {
  d1 = new SqliteD1(join(mkdtempSync(join(tmpdir(), "clipsync-d1-")), "test.db"));
  await d1.exec(`
    CREATE TABLE parents (id TEXT PRIMARY KEY);
    CREATE TABLE things (
      id TEXT PRIMARY KEY,
      parent TEXT REFERENCES parents(id) ON DELETE CASCADE,
      n INTEGER NOT NULL DEFAULT 0,
      flag INTEGER,
      data BLOB
    );
  `);
});

afterEach(() => d1.close());

describe("SqliteD1, the D1 semantics the Worker relies on", () => {
  it("first() is the first row, or null", async () => {
    await d1.prepare("INSERT INTO things (id, n) VALUES (?, ?)").bind("a", 1).run();
    expect(await d1.prepare("SELECT id, n FROM things WHERE id = ?").bind("a").first()).toEqual({ id: "a", n: 1 });
    expect(await d1.prepare("SELECT id FROM things WHERE id = ?").bind("zz").first()).toBeNull();
  });

  it("first(column) is one value", async () => {
    await d1.prepare("INSERT INTO things (id, n) VALUES (?, ?)").bind("a", 7).run();
    expect(await d1.prepare("SELECT n FROM things").first("n")).toBe(7);
  });

  it("rows are plain objects", async () => {
    await d1.prepare("INSERT INTO things (id) VALUES (?)").bind("a").run();
    const { results } = await d1.prepare("SELECT id FROM things").all();
    expect(Object.getPrototypeOf(results[0])).toBe(Object.prototype);
  });

  it("meta.changes counts rows a write changed", async () => {
    await d1.batch(["a", "b", "c"].map((id) => d1.prepare("INSERT INTO things (id) VALUES (?)").bind(id)));
    const res = await d1.prepare("UPDATE things SET n = n + 1 WHERE id != ?").bind("a").run();
    expect(res.meta.changes).toBe(2);
    const none = await d1.prepare("UPDATE things SET n = 1 WHERE id = ?").bind("zz").run();
    expect(none.meta.changes).toBe(0);
  });

  it("a conditional UPDATE is a mutex: only one claim wins", async () => {
    await d1.prepare("INSERT INTO things (id, n) VALUES ('t', 0)").run();
    const claim = () => d1.prepare("UPDATE things SET n = 1 WHERE id = 't' AND n = 0").run();
    const results = await Promise.all([claim(), claim(), claim()]);
    expect(results.map((r) => r.meta.changes).sort()).toEqual([0, 0, 1]);
  });

  it("DELETE ... RETURNING returns the row and counts the change", async () => {
    await d1.prepare("INSERT INTO things (id, n) VALUES (?, ?)").bind("x", 5).run();
    const claimed = await d1.prepare("DELETE FROM things WHERE id = ? RETURNING id, n").bind("x").first();
    expect(claimed).toEqual({ id: "x", n: 5 });
    const again = await d1.prepare("DELETE FROM things WHERE id = ? RETURNING id").bind("x").all();
    expect(again.results).toEqual([]);
    expect(again.meta.changes).toBe(0);
  });

  it("numbered parameters (?1) work, repeated", async () => {
    await d1.prepare("INSERT INTO things (id, n) VALUES (?1, ?2)").bind("p", 3).run();
    const res = await d1.prepare("UPDATE things SET n = n + ?1 WHERE id = ?2 AND n + ?1 <= ?3").bind(4, "p", 7).run();
    expect(res.meta.changes).toBe(1);
    expect(await d1.prepare("SELECT n FROM things WHERE id = 'p'").first("n")).toBe(7);
  });

  it("a batch is one transaction: a failure undoes the whole of it", async () => {
    await expect(
      d1.batch([
        d1.prepare("INSERT INTO things (id) VALUES ('one')"),
        d1.prepare("INSERT INTO things (id) VALUES ('one')"), // primary key clash
      ]),
    ).rejects.toThrow();
    expect(await d1.prepare("SELECT COUNT(*) AS c FROM things").first("c")).toBe(0);
  });

  it("a batch returns one result per statement, in order", async () => {
    const [ins, sel] = await d1.batch([
      d1.prepare("INSERT INTO things (id, n) VALUES ('b', 2)"),
      d1.prepare("SELECT n FROM things WHERE id = 'b'"),
    ]);
    expect(ins!.meta.changes).toBe(1);
    expect(sel!.results).toEqual([{ n: 2 }]);
  });

  it("binds booleans as 1/0 and bytes as blobs", async () => {
    await d1.prepare("INSERT INTO things (id, flag, data) VALUES (?, ?, ?)").bind("b", true, new Uint8Array([1, 2])).run();
    const row = await d1.prepare("SELECT flag, data FROM things").first<{ flag: number; data: Uint8Array }>();
    expect(row!.flag).toBe(1);
    expect([...row!.data]).toEqual([1, 2]);
  });

  it("refuses undefined, as D1 does", () => {
    expect(() => d1.prepare("SELECT ?").bind(undefined)).toThrow(/D1_TYPE_ERROR/);
  });

  it("enforces foreign keys, so cascades run", async () => {
    await d1.prepare("INSERT INTO parents (id) VALUES ('p')").run();
    await d1.prepare("INSERT INTO things (id, parent) VALUES ('c', 'p')").run();
    await d1.prepare("DELETE FROM parents WHERE id = 'p'").run();
    expect(await d1.prepare("SELECT COUNT(*) AS c FROM things").first("c")).toBe(0);
    await expect(d1.prepare("INSERT INTO things (id, parent) VALUES ('d', 'nobody')").run()).rejects.toThrow();
  });
});

describe("migrate", () => {
  const migrations = [
    { name: "0002_more.sql", sql: "ALTER TABLE m ADD COLUMN b TEXT;" },
    { name: "0001_init.sql", sql: "CREATE TABLE m (a TEXT);" },
  ];

  it("applies each migration once, in name order, and records it as wrangler does", () => {
    expect(migrate(d1, migrations)).toEqual(["0001_init.sql", "0002_more.sql"]);
    expect(migrate(d1, migrations)).toEqual([]);
    const names = d1.db.prepare("SELECT name FROM d1_migrations ORDER BY id").all();
    expect(names.map((r) => (r as { name: string }).name)).toEqual(["0001_init.sql", "0002_more.sql"]);
  });

  it("leaves nothing behind from a migration that fails", () => {
    expect(() => migrate(d1, [{ name: "0001_bad.sql", sql: "CREATE TABLE ok (a); CREATE TABLE broken (" }])).toThrow(
      /0001_bad\.sql/,
    );
    expect(d1.db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").get()).toBeUndefined();
  });
});
