import type { DetectedKind, JobProgress, JobRecord, JobState } from "@/src/shared/types";
import { looksOpaque, pageTitle } from "./page-title";
import { putJob, writeProgress } from "./storage";

export function sanitizeTitle(title: string | null | undefined, extension: string): string {
  const cleaned = (title ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what we strip
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 150)
    .trim();

  return `${cleaned || "video"}.${extension}`;
}

async function tabTitle(tabId: number): Promise<string | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.title ?? null;
  } catch {
    return null;
  }
}

export async function jobTitle(tabId: number): Promise<string | null> {
  const fromPage = await pageTitle(tabId);
  if (fromPage !== null) return fromPage;

  const tab = await tabTitle(tabId);
  return tab !== null && !looksOpaque(tab) ? tab : null;
}

export async function createJob(params: {
  tabId: number;
  mediaId: string;
  kind: DetectedKind;
  url: string;
  documentUrl?: string;
  filename: string;
  estimatedBytes?: number;
}): Promise<JobRecord> {
  const now = Date.now();
  const job: JobRecord = {
    jobId: crypto.randomUUID(),
    tabId: params.tabId,
    mediaId: params.mediaId,
    kind: params.kind,
    url: params.url,
    filename: params.filename,
    state: "QUEUED",
    createdAt: now,
    updatedAt: now,
  };
  if (params.documentUrl !== undefined) job.documentUrl = params.documentUrl;
  if (params.estimatedBytes !== undefined) job.estimatedBytes = params.estimatedBytes;
  return putJob(job);
}

export function progressOf(job: JobRecord, patch: Partial<JobProgress> = {}): JobProgress {
  return {
    jobId: job.jobId,
    tabId: job.tabId,
    state: job.state,
    filename: job.filename,
    at: Date.now(),
    ...patch,
  };
}

export async function transition(
  job: JobRecord,
  state: JobState,
  patch: Partial<JobRecord> = {},
  progressPatch: Partial<JobProgress> = {},
): Promise<JobRecord> {
  const next: JobRecord = { ...job, ...patch, state, updatedAt: Date.now() };
  await putJob(next);
  await writeProgress(progressOf(next, progressPatch));
  return next;
}

const PROGRESS_INTERVAL_MS = 250;
const lastProgressAt = new Map<string, number>();

export async function publishProgress(
  job: JobRecord,
  patch: Partial<JobProgress>,
  force = false,
): Promise<void> {
  const now = Date.now();
  const last = lastProgressAt.get(job.jobId) ?? 0;
  if (!force && now - last < PROGRESS_INTERVAL_MS) return;
  lastProgressAt.set(job.jobId, now);
  await writeProgress(progressOf(job, patch));
}

export function forgetProgressThrottle(jobId: string): void {
  lastProgressAt.delete(jobId);
}
