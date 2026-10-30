import type { SWToPopup } from "@/src/shared/messages";
import type { JobProgress, JobRecord, JobState } from "@/src/shared/types";
import { removeJobRules } from "./dnr-rules";
import { forgetProgressThrottle, transition } from "./jobs";
import { sendToOffscreen } from "./offscreen-manager";
import { mapDownload, unmapDownload } from "./storage";

const cleanedWaiters = new Map<string, () => void>();

export function resolveCleaned(jobId: string): void {
  const resolve = cleanedWaiters.get(jobId);
  cleanedWaiters.delete(jobId);
  resolve?.();
}

function waitForCleaned(jobId: string, timeoutMs = 15_000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      cleanedWaiters.delete(jobId);
      resolve(false);
    }, timeoutMs);

    cleanedWaiters.set(jobId, () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export function notifyPopup(message: SWToPopup): void {
  void chrome.runtime.sendMessage(message).catch(() => {});
}

const pendingNames = new Map<string, { filename: string; at: number }>();

export const namingLog: { tentative: string; chosen: string; url: string }[] = [];
const NAMING_LOG_SIZE = 10;

const PENDING_TTL_MS = 60_000;

function rememberFilename(url: string, filename: string): void {
  const now = Date.now();
  for (const [key, entry] of pendingNames) {
    if (now - entry.at > PENDING_TTL_MS) pendingNames.delete(key);
  }
  pendingNames.set(url, { filename, at: now });
}

export function handleDeterminingFilename(
  item: chrome.downloads.DownloadItem,
  suggest: (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void,
): void {
  const wanted = pendingNames.get(item.url) ?? pendingNames.get(item.finalUrl ?? "");

  if (wanted === undefined) {
    suggest();
    return;
  }

  pendingNames.delete(item.url);
  if (item.finalUrl) pendingNames.delete(item.finalUrl);

  namingLog.push({ tentative: item.filename, chosen: wanted.filename, url: item.url });
  if (namingLog.length > NAMING_LOG_SIZE) namingLog.shift();
  console.info(`[delivery] naming download "${item.filename}" -> "${wanted.filename}"`);
  suggest({ filename: wanted.filename, conflictAction: "uniquify" });
}

export async function startDownload(
  job: JobRecord,
  url: string,
  filename: string,
): Promise<number> {
  rememberFilename(url, filename);
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    conflictAction: "uniquify",
    saveAs: false,
  });
  await mapDownload(downloadId, job.jobId);
  return downloadId;
}

export async function finishJob(
  job: JobRecord,
  state: JobState,
  patch: Partial<JobRecord> = {},
  progressPatch: Partial<JobProgress> = {},
): Promise<JobRecord> {
  try {
    if (job.kind === "hls" || job.fallbackAttempted) {
      const cleaned = waitForCleaned(job.jobId);
      await sendToOffscreen({
        target: "offscreen",
        type: "OFFSCREEN_REVOKE_AND_CLEAN",
        jobId: job.jobId,
      }).catch(() => {});
      if (!(await cleaned)) console.warn(`[delivery] ${job.jobId}: no OFFSCREEN_CLEANED ack`);
    }

    await removeJobRules(job.jobId);
    if (job.downloadId !== undefined) await unmapDownload(job.downloadId);

    const errorPatch: Partial<JobProgress> = patch.error ? { error: patch.error } : {};
    const next = await transition(job, state, patch, { ...errorPatch, ...progressPatch });
    forgetProgressThrottle(job.jobId);
    return next;
  } catch (error) {
    console.error(`[delivery] teardown for ${job.jobId} failed`, error);
    return job;
  }
}
