import type { DetectedMedia } from "@/src/shared/types";
import { clearJobRuleIds, getJobRuleIds, setJobRuleIds } from "./storage";

const RESOURCE_TYPES = [
  chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
  chrome.declarativeNetRequest.ResourceType.OTHER,
  chrome.declarativeNetRequest.ResourceType.MEDIA,
];

let nextRuleId = 1000;

export type RuleTarget = Pick<DetectedMedia, "url" | "documentUrl">;

function hostOf(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    return hostname || null;
  } catch {
    return null;
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function hostsFrom(media: RuleTarget, extra: string[] = []): string[] {
  const hosts = new Set<string>();
  for (const url of [media.url, media.documentUrl, ...extra]) {
    if (!url) continue;
    const host = hostOf(url);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

function buildHeaders(media: RuleTarget): chrome.declarativeNetRequest.ModifyHeaderInfo[] {
  const headers: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];
  const documentUrl = media.documentUrl;

  if (documentUrl) {
    headers.push({
      header: "Referer",
      operation: chrome.declarativeNetRequest.HeaderOperation.SET,
      value: documentUrl,
    });
    const origin = originOf(documentUrl);
    if (origin) {
      headers.push({
        header: "Origin",
        operation: chrome.declarativeNetRequest.HeaderOperation.SET,
        value: origin,
      });
    }
  } else if (media.url) {
    const origin = originOf(media.url);
    if (origin) {
      headers.push({
        header: "Referer",
        operation: chrome.declarativeNetRequest.HeaderOperation.SET,
        value: `${origin}/`,
      });
    }
  }

  return headers;
}

export async function installJobRules(
  jobId: string,
  media: RuleTarget,
  extraHosts: string[] = [],
): Promise<number[]> {
  const hosts = hostsFrom(media, extraHosts);
  const headers = buildHeaders(media);

  await removeJobRules(jobId);

  if (hosts.length === 0 || headers.length === 0) {
    console.warn(`[dnr] ${jobId}: nothing to rewrite (hosts=${hosts.length})`);
    return [];
  }

  const ruleId = nextRuleId;
  nextRuleId += 1;

  const rule: chrome.declarativeNetRequest.Rule = {
    id: ruleId,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      requestHeaders: headers,
    },
    condition: {
      requestDomains: hosts,
      initiatorDomains: [chrome.runtime.id],
      resourceTypes: RESOURCE_TYPES,
    },
  };

  await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
  await setJobRuleIds(jobId, [ruleId]);
  return [ruleId];
}

export async function removeJobRules(jobId: string): Promise<void> {
  const ruleIds = await clearJobRuleIds(jobId);
  if (ruleIds.length === 0) return;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds });
}

export async function removeRuleIdsDirectly(ruleIds: number[]): Promise<void> {
  if (ruleIds.length === 0) return;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds });
}

export async function listSessionRules(): Promise<chrome.declarativeNetRequest.Rule[]> {
  return chrome.declarativeNetRequest.getSessionRules();
}

export async function reconcileSessionRules(liveJobIds: Set<string>): Promise<number> {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  if (rules.length === 0) return 0;

  const keep = new Set<number>();
  for (const jobId of liveJobIds) {
    for (const ruleId of await getJobRuleIds(jobId)) keep.add(ruleId);
  }

  const orphans = rules.filter((rule) => !keep.has(rule.id)).map((rule) => rule.id);
  if (orphans.length > 0) {
    await removeRuleIdsDirectly(orphans);
    console.info(`[dnr] removed ${orphans.length} orphaned session rule(s)`);
  }
  return orphans.length;
}
