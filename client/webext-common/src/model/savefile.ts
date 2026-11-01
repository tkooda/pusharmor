/** I626: save text through downloads.download with the Save-as dialog (Chrome and Firefox). */
export interface DownloadsApi {
  download(o: { url: string; filename?: string; saveAs?: boolean }): Promise<number>;
  search(q: { id: number }): Promise<{ filename?: string }[]>;
}

/** Resolves to the saved path, or null when the user cancels the dialog. Rejects on any other failure. */
export async function saveTextFile(d: DownloadsApi | undefined, text: string, filename: string): Promise<string | null> {
  if (!d) throw new Error("downloads unavailable");
  const url = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
  let id: number;
  try {
    id = await d.download({ url, filename, saveAs: true });
  } catch (e) {
    if (/cancel/i.test((e as Error).message ?? "")) return null;
    throw e;
  }
  const path = (await d.search({ id }))[0]?.filename;
  return path || filename;
}
