import type { SWToOffscreen } from "@/src/shared/messages";

const OFFSCREEN_URL = "offscreen.html";

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const JUSTIFICATION =
  "Media assembly needs a DOM context: the service worker has no URL.createObjectURL, and OPFS " +
  "staging plus the blob URL must outlive the download.";

let creating: Promise<void> | null = null;

async function hasDocument(): Promise<boolean> {
  return chrome.offscreen.hasDocument();
}

export async function ensureOffscreen(): Promise<void> {
  if (creating) return creating;

  creating = (async () => {
    if (await hasDocument()) return;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: JUSTIFICATION,
      });
    } catch (error) {
      if (!/single offscreen|already exists/i.test(errorMessage(error))) throw error;
    }
  })();

  try {
    await creating;
  } finally {
    creating = null;
  }
}

export async function closeOffscreen(): Promise<boolean> {
  if (!(await hasDocument())) return false;
  await chrome.offscreen.closeDocument();
  return true;
}

export async function sendToOffscreen(message: SWToOffscreen): Promise<unknown> {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    throw new Error(`offscreen not reachable: ${errorMessage(error)}`);
  }
}

export async function offscreenOpen(): Promise<boolean> {
  return hasDocument();
}

interface OpfsReply {
  dirs?: unknown;
}

export async function listOpfsDirs(): Promise<string[] | null> {
  try {
    await ensureOffscreen();
    const reply = (await sendToOffscreen({
      target: "offscreen",
      type: "OFFSCREEN_LIST_OPFS",
    })) as OpfsReply | undefined;

    const dirs = reply?.dirs;
    if (!Array.isArray(dirs)) return null;
    return dirs.filter((entry): entry is string => typeof entry === "string");
  } catch (error) {
    console.warn("[offscreen] listing OPFS failed", error);
    return null;
  }
}

export async function pruneOpfs(keep: string[]): Promise<string[] | null> {
  try {
    await ensureOffscreen();
    const reply = (await sendToOffscreen({
      target: "offscreen",
      type: "OFFSCREEN_PRUNE_OPFS",
      keep,
    })) as OpfsReply | undefined;

    const dirs = reply?.dirs;
    if (!Array.isArray(dirs)) return null;
    return dirs.filter((entry): entry is string => typeof entry === "string");
  } catch (error) {
    console.warn("[offscreen] pruning OPFS failed", error);
    return null;
  }
}
