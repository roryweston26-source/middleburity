// Local stand-in for Cloudflare D1, on Node's built-in SQLite. It exposes the small part of
// D1's API this app uses (prepare/bind/all/first/run, batch, exec), so the same SQL runs
// locally and in production. Like D1, statements are only compiled when they run, so a
// batch can create a table and fill it. Node only: Workers use the real D1 binding.
import { DatabaseSync } from "node:sqlite";

export function openLocalD1(path = ":memory:") {
  // Several dev servers can share one file (comparing models side by side); a write waits for
  // another's lock instead of failing with "database is locked".
  const db = new DatabaseSync(path, { timeout: 5000 });
  const run = (sql, args) => db.prepare(sql).run(...args);
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async (column) => {
      const row = db.prepare(sql).get(...args);
      return row && column ? row[column] : (row ?? null);
    },
    run: async () => ({ meta: { changes: run(sql, args).changes } }),
    _sqlAndArgs: () => ({ sql, args }), // local-only; used by batch below
  });
  return {
    prepare: (sql) => statement(sql),
    exec: async (sql) => {
      db.exec(sql);
      return { count: 1 };
    },
    // D1 runs a batch as one transaction.
    batch: async (statements) => {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => {
          const { sql, args } = s._sqlAndArgs();
          return { meta: { changes: run(sql, args).changes } };
        });
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    close: () => db.close(),
  };
}
