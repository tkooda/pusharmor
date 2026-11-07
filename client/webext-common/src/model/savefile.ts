/** save text through downloads.download with the Save-as dialog (Chrome and Firefox). */
interface DownloadsApi {
  download(o: { url: string; filename?: string; saveAs?: boolean }): Promise<number>;
  search(q: { id: number }): Promise<{ filename?: string }[]>;
}

interface PermissionsApi {
  request(p: { permissions: string[] }): Promise<boolean>;
}

/**
 * Save needs the optional "downloads" permission. request() is the first call in the click handler (a user gesture
 * is needed) and resolves true at once, with no prompt, when the permission is already held (so a popup that closed
 * during the prompt needs no second prompt). The downloads API is resolved after the grant, never at startup.
 */
export async function saveWithPermission(
  perms: PermissionsApi | undefined,
  getDownloads: () => DownloadsApi | undefined,
  text: string,
  filename: string,
): Promise<string | null> {
  if (perms && !(await perms.request({ permissions: ["downloads"] }))) throw new Error("DOWNLOADS_DENIED");
  return saveTextFile(getDownloads(), text, filename);
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
