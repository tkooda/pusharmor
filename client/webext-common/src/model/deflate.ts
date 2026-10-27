// deflate-raw via CompressionStream / DecompressionStream, inflate capped.

async function readAll(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function streamOf(data: Uint8Array): ReadableStream<Uint8Array> {
  const copy = new Uint8Array(data);
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(copy);
      c.close();
    },
  });
}

export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const s = streamOf(data).pipeThrough(new CompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const out = await readAll(s, Number.MAX_SAFE_INTEGER);
  if (!out) throw new Error("deflate failed");
  return out;
}

/** Inflate; null on a corrupt stream or when the output exceeds cap bytes. */
export async function inflateRaw(data: Uint8Array, cap: number): Promise<Uint8Array | null> {
  try {
    const s = streamOf(data).pipeThrough(new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    return await readAll(s, cap);
  } catch {
    return null;
  }
}
