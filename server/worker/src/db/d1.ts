// D1 call helpers that add meta.rows_read / rows_written to the request log.
import type { Log } from "../log";

export async function all<T>(log: Log, stmt: D1PreparedStatement): Promise<T[]> {
  const r = await stmt.all<T>();
  log.addMeta(r.meta);
  return r.results;
}

export async function batch(log: Log, db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  const rs = await db.batch(stmts);
  for (const r of rs) log.addMeta(r.meta);
  return rs;
}
