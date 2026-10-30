// D1 call helpers that add meta.rows_read / rows_written to the request log.
import type { Log } from "../log";
import { ApiError } from "../errors";
import { JSON_CAP_ERROR } from "./sql";

export async function all<T>(log: Log, stmt: D1PreparedStatement): Promise<T[]> {
  const r = await stmt.all<T>();
  log.addMeta(r.meta);
  return r.results;
}

export async function batch(log: Log, db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  let rs: D1Result[];
  try {
    rs = await db.batch(stmts);
  } catch (e) {
    // The stored JSON cap trigger (migrations/0004).
    if (e instanceof Error && e.message.includes(JSON_CAP_ERROR)) throw new ApiError(413, "too large");
    throw e;
  }
  for (const r of rs) log.addMeta(r.meta);
  return rs;
}
