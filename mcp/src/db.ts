import postgres from "postgres";
import { config } from "./config.js";

/// One pool for the whole process. The intent ledger and the readable job content live in the
/// same database the web app uses, so an agent and a browser see the same rows.
export type Sql = ReturnType<typeof postgres>;

let sql: Sql | null = null;

export function db(): Sql {
  if (!sql) {
    // The package is ESM and `postgres` ships a CJS default; under NodeNext the callable form
    // is not always the module object itself.
    const mod = postgres as unknown as { default?: typeof postgres };
    const factory = (typeof postgres === "function" ? postgres : mod.default) as typeof postgres;
    const url = config.databaseUrl;
    /// Hosted Postgres needs TLS; a local server over loopback does not speak it.
    const loopback = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
    sql = factory(url, { ssl: loopback ? false : "require", max: 5, onnotice: () => {} });
  }
  return sql;
}
