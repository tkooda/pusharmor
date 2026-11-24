// File storage interface. The object store checks the declared length and the SHA-256 of the
// body it receives. Tests install an in-memory store.
import type { Env } from "../env";

// "ok": stored. "mismatch": the body did not match the declared length or SHA-256 (nothing kept).
// "cap": the storage account hit a daily cap (refused until 00:00 UTC). Any other failure throws.
export type PutResult = "ok" | "mismatch" | "cap";

export interface FileStore {
  put(key: string, body: ReadableStream<Uint8Array>, length: number, sha256: Uint8Array): Promise<PutResult>;
}

const unconfigured: FileStore = {
  put: () => Promise.reject(new Error("file storage not configured")),
};

export const storeDeps = {
  store: (_env: Env): FileStore => unconfigured,
};
