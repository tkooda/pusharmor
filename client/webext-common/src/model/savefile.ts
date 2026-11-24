/** save text through downloads.download with the Save-as dialog (Firefox). */
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

/**
 * Chrome: no downloads permission. The text goes through a temporary download link, clicked from the click handler.
 * The browser picks the folder, so the result is the file name.
 */
export async function saveViaLink(text: string, filename: string): Promise<string> {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
  return filename;
}

/** A file's bytes as application/octet-stream: never shown or run, only saved. */
function octets(blob: Blob): string {
  const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
  setTimeout(() => URL.revokeObjectURL(url), 60_000); // the download reads it after the click
  return url;
}

/** Chrome: a file through a temporary download link (the browser picks the folder). -> the file name. */
export async function saveBlobViaLink(blob: Blob, filename: string): Promise<string> {
  const a = document.createElement("a");
  a.href = octets(blob);
  a.download = filename;
  a.click();
  return filename;
}

/** Firefox: a file through downloads.download with the Save-as dialog (optional "downloads" permission, as for text). */
export async function saveBlobWithPermission(
  perms: PermissionsApi | undefined,
  getDownloads: () => DownloadsApi | undefined,
  blob: Blob,
  filename: string,
): Promise<string | null> {
  if (perms && !(await perms.request({ permissions: ["downloads"] }))) throw new Error("DOWNLOADS_DENIED");
  const d = getDownloads();
  if (!d) throw new Error("downloads unavailable");
  let id: number;
  try {
    id = await d.download({ url: octets(blob), filename, saveAs: true });
  } catch (e) {
    if (/cancel/i.test((e as Error).message ?? "")) return null;
    throw e;
  }
  return (await d.search({ id }))[0]?.filename || filename;
}
