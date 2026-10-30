export type LaunchMode = "popup" | "panel";

const MODE_KEY = "launchMode";
const DEFAULT_MODE: LaunchMode = "panel";

const POPUP_PAGE = "popup.html";

const PANEL_PAGE = "sidepanel.html";

const POPUP_APPEAR_MS = 2000;

function isLaunchMode(value: unknown): value is LaunchMode {
  return value === "popup" || value === "panel";
}

export async function getLaunchMode(): Promise<LaunchMode> {
  try {
    const stored = await chrome.storage.local.get(MODE_KEY);
    const value: unknown = stored[MODE_KEY];
    return isLaunchMode(value) ? value : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export async function applyLaunchMode(mode: LaunchMode): Promise<LaunchMode> {
  if (mode === "popup") {
    await chrome.action.setPopup({ popup: POPUP_PAGE });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
    await chrome.storage.local.set({ [MODE_KEY]: mode });
    return mode;
  }

  try {
    await chrome.action.setPopup({ popup: "" });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    await chrome.storage.local.set({ [MODE_KEY]: mode });
    return mode;
  } catch (error) {
    console.warn("[panel] side panel unavailable, keeping the popup", error);
    await chrome.action.setPopup({ popup: POPUP_PAGE }).catch(() => {});
    await chrome.storage.local.set({ [MODE_KEY]: "popup" });
    return "popup";
  }
}

async function isPopupOpen(): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.POPUP],
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function waitForPopup(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isPopupOpen()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, 80));
  }
}

async function openPopupSurface(
  windowId: number | null,
): Promise<{ opened: boolean; detail?: string }> {
  if (await isPopupOpen()) return { opened: true };

  const attempts: Array<() => Promise<void>> = [() => chrome.action.openPopup()];
  if (windowId !== null) {
    attempts.push(async () => {
      await chrome.windows.update(windowId, { focused: true });
      await new Promise((done) => setTimeout(done, 120));
      await chrome.action.openPopup();
    });
  }

  let detail: string | undefined;
  for (const attempt of attempts) {
    try {
      await attempt();
      if (await waitForPopup(POPUP_APPEAR_MS)) return { opened: true };
      detail = "the popup did not appear";
    } catch (error) {
      detail = String(error);
      console.warn("[panel] action.openPopup attempt failed:", error);
    }
  }

  console.warn(`[panel] could not show the popup: ${detail ?? "unknown reason"}`);
  return { opened: false, detail };
}

export interface SwitchResult {
  mode: LaunchMode;
  opened: boolean;
  detail?: string;
}

interface SidePanelWithClose {
  close?(options: { windowId: number }): Promise<void>;
}

async function closePanelSurface(windowId: number | null): Promise<void> {
  const sidePanel = chrome.sidePanel as unknown as SidePanelWithClose;
  if (typeof sidePanel.close !== "function") {
    console.debug("[panel] sidePanel.close() is unavailable, leaving the panel open");
    return;
  }
  if (windowId === null) return;

  try {
    await sidePanel.close({ windowId });
  } catch (error) {
    console.warn("[panel] could not close the side panel", error);
  }
}

async function isPanelOpen(): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.SIDE_PANEL],
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function windowOf(tabId: number | null): Promise<number | null> {
  if (tabId !== null) {
    try {
      return (await chrome.tabs.get(tabId)).windowId;
    } catch {}
  }
  const current = await chrome.windows.getCurrent().catch(() => null);
  return current?.id ?? null;
}

async function openPanelSurface(
  tabId: number | null,
): Promise<{ opened: boolean; detail?: string }> {
  if (tabId !== null) {
    await chrome.sidePanel
      .setOptions({ tabId, path: PANEL_PAGE, enabled: true })
      .catch((error: unknown) => {
        console.debug(`[panel] could not re-enable the panel for tab ${tabId}: ${String(error)}`);
      });
  }

  const attempts: Array<() => Promise<void>> = [];
  if (tabId !== null) attempts.push(() => chrome.sidePanel.open({ tabId }));
  attempts.push(async () => {
    const windowId =
      tabId !== null
        ? (await chrome.tabs.get(tabId)).windowId
        : (await chrome.windows.getCurrent()).id;
    if (windowId === undefined) throw new Error("no window for the side panel");
    await chrome.sidePanel.open({ windowId });
  });

  let detail: string | undefined;
  for (const attempt of attempts) {
    try {
      await attempt();
      return { opened: true };
    } catch (error) {
      detail = String(error);
      console.warn("[panel] side panel open attempt failed:", error);
    }
  }
  return { opened: false, detail };
}

export async function showPopupSurface(
  tabId: number | null,
): Promise<{ opened: boolean; detail?: string }> {
  const windowId = await windowOf(tabId);

  if (await isPanelOpen()) await closePanelSurface(windowId);

  return openPopupSurface(windowId);
}

export async function switchSurface(mode: LaunchMode, tabId: number | null): Promise<SwitchResult> {
  if (mode === "panel") {
    const panel = await openPanelSurface(tabId);
    const applied = await applyLaunchMode(mode);
    return { mode: applied, opened: panel.opened, detail: panel.detail };
  }

  const applied = await applyLaunchMode(mode);
  if (applied !== "popup") return { mode: applied, opened: false };

  void chrome.runtime
    .sendMessage({ target: "sw", type: "POPUP_SHOW_POPUP", tabId: tabId ?? -1 })
    .catch((error: unknown) => {
      console.warn("[panel] could not ask for the popup to be shown", error);
    });
  return { mode: applied, opened: true };
}
