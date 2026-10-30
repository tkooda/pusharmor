// D1 call helpers.
import { ApiError } from "../errors";
import { JSON_CAP_ERROR } from "./sql";

export async function all<T>(stmt: D1PreparedStatement): Promise<T[]> {
  const r = await stmt.all<T>();
  return r.results;
}

export async function batch(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  let rs: D1Result[];
  try {
    rs = await db.batch(stmts);
  } catch (e) {
    // The stored JSON cap trigger (migrations/0004).
    if (e instanceof Error && e.message.includes(JSON_CAP_ERROR)) throw new ApiError(413, "too large");
    throw e;
  }
  return rs;
}
