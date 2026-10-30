import { namingLog } from "./delivery";
import { listSessionRules } from "./dnr-rules";
import { listOpfsDirs, offscreenOpen } from "./offscreen-manager";
import { detectionsByTab, jobStates, sessionKeys, sessionSnapshot } from "./storage";

export interface DiagnosticsSnapshot {
  tabCount: number;
  sessionKeys: string[];
  jobStates: Record<string, string>;
  detectionsPerTab: Record<string, number>;
  dnrRuleCount: number;
  dnrRules: chrome.declarativeNetRequest.Rule[];
  opfsDirs: string[] | null;
  offscreenReachable: boolean;
  offscreenOpen: boolean;
  namingLog: { tentative: string; chosen: string; url: string }[];
  filenameListenerRegistered: boolean;
}

export async function diagnostics(): Promise<DiagnosticsSnapshot> {
  const [tabs, keys, snapshot, rules, opfsDirs, isOpen] = await Promise.all([
    chrome.tabs.query({}),
    sessionKeys(),
    sessionSnapshot(),
    listSessionRules(),
    listOpfsDirs(),
    offscreenOpen(),
  ]);

  const report: DiagnosticsSnapshot = {
    tabCount: tabs.length,
    sessionKeys: keys,
    jobStates: jobStates(snapshot),
    detectionsPerTab: detectionsByTab(snapshot),
    dnrRuleCount: rules.length,
    dnrRules: rules,
    opfsDirs,
    offscreenReachable: opfsDirs !== null,
    offscreenOpen: isOpen,
    namingLog: [...namingLog],
    filenameListenerRegistered: chrome.downloads.onDeterminingFilename.hasListeners(),
  };

  console.log("[diagnostics]", report);
  if (opfsDirs === null) {
    console.warn("[diagnostics] the offscreen document did not answer OFFSCREEN_LIST_OPFS");
  }
  return report;
}
