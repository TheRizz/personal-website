// A D1Database for unit tests, backed by Node's built-in SQLite with the real migrations applied,
// so the SQL under test is the SQL that ships. Like D1, a batch runs in one transaction and keeps
// going when a statement matches no rows. Only what the Worker uses is implemented.

interface SqliteStatement {
  all(...values: unknown[]): Record<string, unknown>[];
  run(...values: unknown[]): { changes: number | bigint };
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

const MIGRATIONS = {
  blog: import.meta.glob<string>("../migrations/*.sql", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  tycoon: import.meta.glob<string>("../migrations-tycoon/*.sql", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
};

/** A fresh in-memory database with every migration applied, and the D1 view of it. */
export async function createD1(
  database: keyof typeof MIGRATIONS = "blog",
): Promise<{ db: D1Database; sqlite: SqliteDatabase }> {
  const { DatabaseSync } = (await import("node:sqlite" as string)) as SqliteModule;
  const sqlite = new DatabaseSync(":memory:");
  // D1 enforces foreign keys.
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = MIGRATIONS[database];
  for (const file of Object.keys(migrations).sort()) sqlite.exec(migrations[file]!);

  const statement = (sql: string, values: unknown[] = []) => {
    const bound = {
      sql,
      values,
      bind: (...next: unknown[]) => {
        if (next.some((value) => value === undefined)) throw new Error("D1_TYPE_ERROR: undefined");
        return statement(sql, next);
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...values), success: true, meta: {} }),
      first: async () => sqlite.prepare(sql).all(...values)[0] ?? null,
      run: async () => {
        const { changes } = sqlite.prepare(sql).run(...values);
        return { results: [], success: true, meta: { changes: Number(changes) } };
      },
    };
    return bound;
  };
  type Bound = ReturnType<typeof statement>;

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Bound[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((s) => ({
          results: sqlite.prepare(s.sql).all(...s.values),
          success: true,
          meta: {},
        }));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db: db as unknown as D1Database, sqlite };
}
