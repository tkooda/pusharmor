// File storage interface. The object store checks the declared length and the SHA-256 of the
// body it receives. Tests install an in-memory store.
import type { Env } from "../env";
import { B2Store } from "./b2";

// "ok": stored. "mismatch": the body did not match the declared length or SHA-256 (nothing kept).
// "cap": the storage account hit a daily cap (refused until 00:00 UTC). Any other failure throws.
export type PutResult = "ok" | "mismatch" | "cap";

// A body to serve (status 206 for a single byte range), status 416 (range not satisfiable, with
// the object size when storage gave it), "missing" (no such key), or "cap" (daily cap). Any other
// failure throws.
export type GetResult =
  | { status: 200 | 206; body: ReadableStream<Uint8Array>; length: number; contentRange: string | null; etag: string | null }
  | { status: 416; size: number | null }
  | "missing"
  | "cap";

// "ok": every version deleted. "missing": no version of the key. "cap": daily cap.
export type RemoveResult = "ok" | "missing" | "cap";

export interface Version {
  key: string;
  versionId: string;
}

export interface FileStore {
  put(key: string, body: ReadableStream<Uint8Array>, length: number, sha256: Uint8Array): Promise<PutResult>;
  get(key: string, range: string | null): Promise<GetResult>;
  remove(key: string): Promise<RemoveResult>;
  listPrefixes(prefix: string): Promise<string[] | "cap">;
  listPrefixesPage(prefix: string, token?: string): Promise<{ prefixes: string[]; next?: string } | "cap">;
  listVersionsPage(prefix: string): Promise<{ versions: Version[]; more: boolean } | "cap">;
  listVersions(prefix: string): Promise<Version[] | "cap">;
  deleteVersions(versions: Version[]): Promise<"ok" | "cap">;
}

// null: no storage configured; uploads, downloads and deletes are refused.
export const storeDeps = {
  store: (env: Env): FileStore | null =>
    env.B2_KEY_ID && env.B2_APP_KEY && env.B2_BUCKET && env.B2_S3_ENDPOINT && env.B2_REGION
      ? new B2Store({ keyId: env.B2_KEY_ID, appKey: env.B2_APP_KEY, bucket: env.B2_BUCKET, endpoint: env.B2_S3_ENDPOINT, region: env.B2_REGION })
      : null,
};
