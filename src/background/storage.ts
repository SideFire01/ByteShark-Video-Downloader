import { STORAGE_PREFIX } from "@/src/shared/messages";
import type { DetectedMedia, JobProgress, JobRecord } from "@/src/shared/types";

function prefixKeys(prefix: string, snapshot: Record<string, unknown>): [string, unknown][] {
  return Object.entries(snapshot).filter(([storageKey]) => storageKey.startsWith(prefix));
}

function suffix(storageKey: string, prefix: string): string {
  return storageKey.slice(prefix.length);
}

export async function getSnapshot(): Promise<Record<string, unknown>> {
  return chrome.storage.session.get(null);
}

export async function readDetections(tabId: number): Promise<DetectedMedia[]> {
  const storageKey = `${STORAGE_PREFIX.detections}${tabId}`;
  const stored = await chrome.storage.session.get(storageKey);
  const value: unknown = stored[storageKey];
  return Array.isArray(value) ? (value as DetectedMedia[]) : [];
}

export async function writeDetections(tabId: number, media: DetectedMedia[]): Promise<void> {
  await chrome.storage.session.set({ [`${STORAGE_PREFIX.detections}${tabId}`]: media });
}

export async function clearDetections(tabId: number): Promise<void> {
  await chrome.storage.session.remove(`${STORAGE_PREFIX.detections}${tabId}`);
}

export async function findDetection(mediaId: string): Promise<DetectedMedia | null> {
  const snapshot = await getSnapshot();
  for (const [, value] of prefixKeys(STORAGE_PREFIX.detections, snapshot)) {
    if (!Array.isArray(value)) continue;
    const hit = (value as DetectedMedia[]).find((entry) => entry.id === mediaId);
    if (hit) return hit;
  }
  return null;
}

export async function putJob(job: JobRecord): Promise<JobRecord> {
  await chrome.storage.session.set({ [`${STORAGE_PREFIX.job}${job.jobId}`]: job });
  return job;
}

export async function getJob(jobId: string): Promise<JobRecord | null> {
  const storageKey = `${STORAGE_PREFIX.job}${jobId}`;
  const stored = await chrome.storage.session.get(storageKey);
  const value: unknown = stored[storageKey];
  if (typeof value !== "object" || value === null) return null;
  return value as JobRecord;
}

export async function listJobs(): Promise<JobRecord[]> {
  const snapshot = await getSnapshot();
  return prefixKeys(STORAGE_PREFIX.job, snapshot)
    .map(([, value]) => value)
    .filter((value): value is JobRecord => typeof value === "object" && value !== null)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function writeProgress(progress: JobProgress): Promise<void> {
  await chrome.storage.session.set({
    [`${STORAGE_PREFIX.progress}${progress.jobId}`]: progress,
  });
}

export async function readProgress(jobId: string): Promise<JobProgress | null> {
  const storageKey = `${STORAGE_PREFIX.progress}${jobId}`;
  const stored = await chrome.storage.session.get(storageKey);
  const value: unknown = stored[storageKey];
  if (typeof value !== "object" || value === null) return null;
  return value as JobProgress;
}

export async function mapDownload(downloadId: number, jobId: string): Promise<void> {
  await chrome.storage.session.set({ [`${STORAGE_PREFIX.download}${downloadId}`]: jobId });
}

export async function unmapDownload(downloadId: number): Promise<void> {
  await chrome.storage.session.remove(`${STORAGE_PREFIX.download}${downloadId}`);
}

export async function jobIdForDownload(downloadId: number): Promise<string | null> {
  const storageKey = `${STORAGE_PREFIX.download}${downloadId}`;
  const stored = await chrome.storage.session.get(storageKey);
  const value: unknown = stored[storageKey];
  return typeof value === "string" ? value : null;
}

export async function setJobRuleIds(jobId: string, ruleIds: number[]): Promise<void> {
  await chrome.storage.session.set({ [`${STORAGE_PREFIX.dnr}${jobId}`]: ruleIds });
}

export async function getJobRuleIds(jobId: string): Promise<number[]> {
  const storageKey = `${STORAGE_PREFIX.dnr}${jobId}`;
  const stored = await chrome.storage.session.get(storageKey);
  const value: unknown = stored[storageKey];
  return Array.isArray(value) ? (value as number[]) : [];
}

export async function clearJobRuleIds(jobId: string): Promise<number[]> {
  const ruleIds = await getJobRuleIds(jobId);
  await chrome.storage.session.remove(`${STORAGE_PREFIX.dnr}${jobId}`);
  return ruleIds;
}

export async function sessionKeys(): Promise<string[]> {
  const snapshot = await getSnapshot();
  return Object.keys(snapshot).sort();
}

export async function sessionSnapshot(): Promise<Record<string, unknown>> {
  return getSnapshot();
}

export function jobStates(snapshot: Record<string, unknown>): Record<string, string> {
  const states: Record<string, string> = {};
  for (const [, value] of prefixKeys(STORAGE_PREFIX.progress, snapshot)) {
    if (typeof value !== "object" || value === null) continue;
    const progress = value as Partial<JobProgress>;
    if (typeof progress.jobId !== "string") continue;
    states[progress.jobId] = progress.state ?? "unknown";
  }
  return states;
}

export function detectionsByTab(snapshot: Record<string, unknown>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [storageKey, value] of prefixKeys(STORAGE_PREFIX.detections, snapshot)) {
    counts[suffix(storageKey, STORAGE_PREFIX.detections)] = Array.isArray(value) ? value.length : 0;
  }
  return counts;
}
