import type { DetectedMedia, JobRecord } from "@/src/shared/types";
import { finishJob, startDownload } from "./delivery";
import { installJobRules } from "./dnr-rules";
import { createJob, jobTitle, sanitizeTitle, transition } from "./jobs";
import { ensureOffscreen, sendToOffscreen } from "./offscreen-manager";
import { getJob } from "./storage";
import { trackTransportProgress } from "./transport-progress";

let slot: Promise<void> = Promise.resolve();

function takeSlot(): Promise<() => void> {
  const previous = slot;
  let release = () => {};
  slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  return previous.then(() => release);
}

const DIRECT_FAILURE_KEY = "directFailures";
const DIRECT_FAILURE_TTL_MS = 7 * 24 * 60 * 60_000;

type DirectFailures = Record<string, number>;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

async function readFailures(): Promise<DirectFailures> {
  const stored = await chrome.storage.local.get(DIRECT_FAILURE_KEY);
  const value: unknown = stored[DIRECT_FAILURE_KEY];
  if (typeof value !== "object" || value === null) return {};
  const failures: DirectFailures = {};
  for (const [host, at] of Object.entries(value as Record<string, unknown>)) {
    if (typeof at === "number") failures[host] = at;
  }
  return failures;
}

export async function noteDirectFailure(url: string): Promise<void> {
  const host = hostOf(url);
  if (!host) return;
  const failures = await readFailures();
  failures[host] = Date.now();
  await chrome.storage.local.set({ [DIRECT_FAILURE_KEY]: failures });
  console.info(`[direct-mp4] ${host}: refusing the direct path, using the offscreen fetch instead`);
}

export async function hostRefusesDirect(url: string): Promise<boolean> {
  const host = hostOf(url);
  if (!host) return false;

  const failures = await readFailures();
  const at = failures[host];
  if (at === undefined) return false;

  if (Date.now() - at > DIRECT_FAILURE_TTL_MS) {
    delete failures[host];
    await chrome.storage.local.set({ [DIRECT_FAILURE_KEY]: failures });
    return false;
  }
  return true;
}

export async function forgetDirectFailures(): Promise<void> {
  await chrome.storage.local.remove(DIRECT_FAILURE_KEY);
}

export async function startDirectMp4(media: DetectedMedia): Promise<JobRecord> {
  const title = await jobTitle(media.tabId);
  const job = await createJob({
    tabId: media.tabId,
    mediaId: media.id,
    kind: "mp4",
    url: media.url,
    filename: sanitizeTitle(title, "mp4"),
    estimatedBytes: media.estimatedBytes,
  });

  await installJobRules(job.jobId, media);
  await transition(job, "QUEUED", {}, { filename: job.filename });

  if (await hostRefusesDirect(media.url)) {
    await retryViaOffscreen(job, "this site previously refused the direct download");
    return (await getJob(job.jobId)) ?? job;
  }

  const release = await takeSlot();
  try {
    const current = await getJob(job.jobId);
    if (!current || current.state === "ERROR") return current ?? job;

    const downloadId = await startDownload(current, media.url, current.filename);
    trackTransportProgress(current.jobId);
    return await transition(current, "SAVING", { downloadId }, { filename: current.filename });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finishJob(job, "ERROR", { error: `could not start the download: ${message}` });
  } finally {
    release();
  }
}

export async function retryViaOffscreen(job: JobRecord, reason: string): Promise<void> {
  const processing = await transition(
    job,
    "PROCESSING",
    { fallbackAttempted: true, downloadId: undefined },
    { error: undefined },
  );
  console.info(`[direct-mp4] ${job.jobId}: download failed (${reason}); retrying offscreen`);

  try {
    await ensureOffscreen();
    await sendToOffscreen({
      target: "offscreen",
      type: "OFFSCREEN_START_FETCH",
      jobId: processing.jobId,
      tabId: processing.tabId,
      url: processing.url,
      filename: processing.filename,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishJob(processing, "ERROR", { error: `offscreen retry failed: ${message}` });
  }
}
