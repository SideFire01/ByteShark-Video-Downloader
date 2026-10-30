import { STORAGE_PREFIX } from "@/src/shared/messages";
import { detectedCount } from "./hls-dispatch";

const DEBOUNCE_MS = 250;

const timers = new Map<number, ReturnType<typeof setTimeout>>();

const BADGE_BACKGROUND = "#ff0000";
const BADGE_TEXT = "#ffffff";

async function applyBadgeColors(): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_BACKGROUND });
  await chrome.action.setBadgeTextColor({ color: BADGE_TEXT });
}

export function scheduleBadgeRefresh(tabId: number): void {
  if (tabId < 0) return;
  const existing = timers.get(tabId);
  if (existing !== undefined) clearTimeout(existing);
  timers.set(
    tabId,
    setTimeout(() => {
      timers.delete(tabId);
      void refreshBadge(tabId);
    }, DEBOUNCE_MS),
  );
}

export async function refreshBadge(tabId: number): Promise<void> {
  try {
    const count = await detectedCount(tabId);
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" });
  } catch (error) {
    console.debug(`[badge] cannot set text for tab ${tabId}: ${String(error)}`);
  }
}

function tabOfKey(key: string, newValue: unknown): number | null {
  if (key.startsWith(STORAGE_PREFIX.detections)) {
    const id = Number(key.slice(STORAGE_PREFIX.detections.length));
    return Number.isFinite(id) ? id : null;
  }

  if (key.startsWith(STORAGE_PREFIX.job)) {
    const job = newValue as { tabId?: unknown } | undefined;
    return typeof job?.tabId === "number" ? job.tabId : null;
  }

  return null;
}

export function registerBadgeListeners(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session") return;
    for (const [key, change] of Object.entries(changes)) {
      const tabId = tabOfKey(key, change.newValue);
      if (tabId !== null) scheduleBadgeRefresh(tabId);
    }
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => scheduleBadgeRefresh(tabId));
}

export async function refreshActiveBadge(): Promise<void> {
  await applyBadgeColors().catch(() => {});
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) await refreshBadge(tab.id);
  } catch {}
}
