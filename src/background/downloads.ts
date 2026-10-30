import type { JobRecord } from "@/src/shared/types";
import { finishJob, notifyPopup } from "./delivery";
import { noteDirectFailure, retryViaOffscreen } from "./direct-mp4";
import { reconcileSessionRules, removeJobRules } from "./dnr-rules";
import { closeOffscreen, pruneOpfs } from "./offscreen-manager";
import { getJob, jobIdForDownload, listJobs, readProgress, unmapDownload } from "./storage";
import { trackTransportProgress } from "./transport-progress";

const WATCHDOG_MS = 10 * 60_000;

async function failureReason(job: JobRecord): Promise<string> {
  if (job.downloadId === undefined) return "interrupted";
  const [item] = await chrome.downloads.search({ id: job.downloadId });
  return item?.error ?? "interrupted";
}

export function describeDownloadError(code: string): string {
  switch (code) {
    case "FILE_ACCESS_DENIED":
      return "Chrome could not write to your downloads folder — check its permissions";
    case "FILE_NO_SPACE":
      return "there is not enough free disk space";
    case "FILE_NAME_TOO_LONG":
      return "the filename is too long for this system";
    case "FILE_TOO_LARGE":
      return "the file is larger than the filesystem allows";
    case "FILE_BLOCKED":
    case "FILE_SECURITY_CHECK_FAILED":
    case "FILE_VIRUS_INFECTED":
      return "the browser blocked the file";
    case "USER_CANCELED":
      return "the download was cancelled";
    case "SERVER_FORBIDDEN":
    case "SERVER_UNAUTHORIZED":
      return "the site refused the download — it may only allow its own player to fetch this";
    case "SERVER_BAD_CONTENT":
    case "SERVER_FAILED":
    case "SERVER_NO_RANGE":
      return "the server rejected the download";
    case "NETWORK_FAILED":
    case "NETWORK_TIMEOUT":
    case "NETWORK_DISCONNECTED":
    case "NETWORK_SERVER_DOWN":
    case "NETWORK_INVALID_REQUEST":
      return "the network connection failed";
    default:
      return code;
  }
}

const UNFIXABLE_BY_REFETCH = new Set([
  "USER_CANCELED",
  "FILE_NO_SPACE",
  "FILE_NAME_TOO_LONG",
  "FILE_TOO_LARGE",
  "FILE_VIRUS_INFECTED",
  "FILE_BLOCKED",
  "FILE_SECURITY_CHECK_FAILED",
]);

const STRUCTURAL_REFUSALS = new Set([
  "FILE_ACCESS_DENIED",
  "SERVER_FORBIDDEN",
  "SERVER_UNAUTHORIZED",
  "SERVER_BAD_CONTENT",
]);

function shouldRetryOffscreen(code: string): boolean {
  return !UNFIXABLE_BY_REFETCH.has(code);
}

async function eraseOwnDownload(downloadId: number): Promise<void> {
  try {
    await chrome.downloads.erase({ id: downloadId });
  } catch (error) {
    console.warn(`[downloads] could not erase failed download ${downloadId}`, error);
  }
}

export function handleDownloadChanged(delta: chrome.downloads.DownloadDelta): void {
  void (async () => {
    if (!delta.id) return;
    const state = delta.state?.current;
    if (state !== "complete" && state !== "interrupted") return;

    const jobId = await jobIdForDownload(delta.id);
    if (!jobId) return;

    const job = await getJob(jobId);
    if (!job) {
      await unmapDownload(delta.id);
      return;
    }

    if (state === "complete") {
      await finishJob(job, "DONE");
      return;
    }

    const reason = await failureReason(job);

    await unmapDownload(delta.id);
    await eraseOwnDownload(delta.id);

    if (job.kind === "mp4" && !job.fallbackAttempted && shouldRetryOffscreen(reason)) {
      if (STRUCTURAL_REFUSALS.has(reason)) await noteDirectFailure(job.url);
      await retryViaOffscreen({ ...job, downloadId: undefined }, reason);
      return;
    }

    await finishJob(job, "ERROR", {
      error: `download failed: ${describeDownloadError(reason)}`,
      downloadId: undefined,
    });
  })();
}

export function handleDownloadErased(downloadId: number): void {
  void (async () => {
    const jobId = await jobIdForDownload(downloadId);
    if (!jobId) return;
    const job = await getJob(jobId);
    await unmapDownload(downloadId);
    if (!job) return;
    notifyPopup({ target: "popup", type: "POPUP_ERROR", message: "The download was removed." });
    await finishJob(job, "ERROR", {
      error: "removed from the downloads list",
      downloadId: undefined,
    });
  })();
}

const STALL_MS = 5 * 60_000;

export async function reapStalledJobs(): Promise<string[]> {
  const reaped: string[] = [];
  const jobs = await listJobs();

  for (const job of jobs) {
    if (job.state === "SAVING") {
      if (job.downloadId === undefined) continue;
      if (Date.now() - job.updatedAt < WATCHDOG_MS) continue;

      const [item] = await chrome.downloads.search({ id: job.downloadId });
      if (item && (item.state === "complete" || item.state === "interrupted")) {
        handleDownloadChanged({ id: job.downloadId, state: { current: item.state } });
        continue;
      }
      if (item && item.state === "in_progress") continue;

      console.warn(`[watchdog] ${job.jobId}: no terminal state, tearing down`);
      await finishJob(job, "ERROR", { error: "download stalled (watchdog)" });
      reaped.push(job.jobId);
      continue;
    }

    if (job.state !== "PROCESSING" && job.state !== "QUEUED") continue;
    if (job.awaitingSizeConfirm) continue;

    const progress = await readProgress(job.jobId);
    const lastAt = progress?.at ?? job.updatedAt;
    if (Date.now() - lastAt < STALL_MS) continue;

    console.warn(`[watchdog] ${job.jobId}: no progress for ${STALL_MS / 60_000} min, failing`);
    await finishJob(job, "ERROR", {
      error: `no progress for ${STALL_MS / 60_000} minutes — the site may be blocking or throttling the download`,
    });
    reaped.push(job.jobId);
  }

  return reaped;
}

export function startWatchdog(): () => void {
  const timer = setInterval(() => {
    void reapStalledJobs().catch((error: unknown) => {
      console.warn("[watchdog] sweep failed", error);
    });
  }, 60_000);

  return () => clearInterval(timer);
}

const TERMINAL = new Set(["DONE", "CANCELLED", "ERROR", "UNSUPPORTED", "DRM_BLOCKED"]);

export interface ReconcileReport {
  jobs: number;
  live: string[];
  orphansRemoved: number;
  opfsDirs: string[] | null;
  offscreenClosed: boolean;
}

export async function reconcileOnStartup(): Promise<ReconcileReport> {
  const jobs = await listJobs();
  const live = new Set<string>();

  for (const job of jobs) {
    if (TERMINAL.has(job.state)) {
      await removeJobRules(job.jobId);
      continue;
    }

    if (job.downloadId === undefined) {
      await finishJob(job, "ERROR", {
        error: "interrupted before delivery (service worker restart)",
      });
      continue;
    }

    const [item] = await chrome.downloads.search({ id: job.downloadId });
    if (!item) {
      await finishJob(job, "ERROR", {
        error: "download no longer exists in chrome://downloads",
        downloadId: undefined,
      });
      continue;
    }

    if (item.state === "complete") {
      await finishJob(job, "DONE");
      continue;
    }

    if (item.state === "interrupted") {
      await unmapDownload(job.downloadId);
      await eraseOwnDownload(job.downloadId);
      await finishJob(job, "ERROR", {
        error: `download failed: ${describeDownloadError(item.error ?? "interrupted")}`,
        downloadId: undefined,
      });
      continue;
    }

    if (job.state === "SAVING") trackTransportProgress(job.jobId);
    live.add(job.jobId);
  }

  const orphansRemoved = await reconcileSessionRules(live);
  const opfsDirs = await pruneOpfs([...live]);

  let offscreenClosed = false;
  if (live.size === 0) offscreenClosed = await closeOffscreen().catch(() => false);

  return { jobs: jobs.length, live: [...live], orphansRemoved, opfsDirs, offscreenClosed };
}
