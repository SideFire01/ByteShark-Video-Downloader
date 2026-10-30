import { getLaunchMode } from "@/src/shared/launch-mode";
import {
  type MediaListReply,
  SIZE_CONFIRM_THRESHOLD_BYTES,
  STORAGE_PREFIX,
} from "@/src/shared/messages";
import type { DetectedMedia, JobRecord, JobState, Variant } from "@/src/shared/types";
import { finishJob, notifyPopup } from "./delivery";
import { installJobRules, removeJobRules } from "./dnr-rules";
import { createJob, jobTitle, sanitizeTitle, transition } from "./jobs";
import { ensureOffscreen, sendToOffscreen } from "./offscreen-manager";
import { findDetection, getJob, listJobs, readDetections } from "./storage";

async function putVariants(jobId: string, variants: Variant[]): Promise<void> {
  await chrome.storage.session.set({ [`${STORAGE_PREFIX.variants}${jobId}`]: variants });
}

async function getVariants(jobId: string): Promise<Variant[]> {
  const storageKey = `${STORAGE_PREFIX.variants}${jobId}`;
  const stored = await chrome.storage.session.get(storageKey);
  const value: unknown = stored[storageKey];
  return Array.isArray(value) ? (value as Variant[]) : [];
}

async function clearVariants(jobId: string): Promise<void> {
  await chrome.storage.session.remove(`${STORAGE_PREFIX.variants}${jobId}`);
}

async function pendingJobFor(mediaId: string): Promise<JobRecord | null> {
  const jobs = await listJobs();
  return (
    jobs.find(
      (job) =>
        job.mediaId === mediaId &&
        (job.state === "CHOOSING" || job.state === "QUEUED" || job.state === "PROCESSING"),
    ) ?? null
  );
}

export async function startHlsJobFor(
  mediaId: string,
  variantUri?: string,
  auto?: boolean,
): Promise<JobRecord | null> {
  const pending = await pendingJobFor(mediaId);
  if (pending) {
    if (variantUri && pending.state === "CHOOSING") {
      await selectVariant(pending.jobId, variantUri);
    }
    return pending;
  }

  const media = await findDetection(mediaId);
  if (!media) throw new Error("that media is no longer detected — reopen the tab");
  return startHlsJob(media, variantUri, auto);
}

async function startHlsJob(
  media: DetectedMedia,
  variantUri?: string,
  auto?: boolean,
): Promise<JobRecord | null> {
  const title = await jobTitle(media.tabId);
  const job = await createJob({
    tabId: media.tabId,
    mediaId: media.id,
    kind: "hls",
    url: media.url,
    documentUrl: media.documentUrl,
    filename: sanitizeTitle(title, "mp4"),
  });

  await installJobRules(job.jobId, media);
  const queued = await transition(job, "QUEUED", variantUri ? { variantUri } : {}, { filename: job.filename });

  try {
    await ensureOffscreen();
    await sendToOffscreen({
      target: "offscreen",
      type: "OFFSCREEN_START_HLS",
      jobId: queued.jobId,
      media,
      filename: queued.filename,
      variant: variantUri ? { bandwidth: 0, uri: variantUri } : undefined,
      auto,
    });
    return queued;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishJob(queued, "ERROR", {
      error: `could not reach the offscreen document: ${message}`,
    });
    return queued;
  }
}

export async function selectVariant(jobId: string, variantUri: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  await transition(job, "QUEUED", { variantUri });
  await sendToOffscreen({
    target: "offscreen",
    type: "OFFSCREEN_SELECT_VARIANT",
    jobId,
    variantUri,
  });
}

export async function confirmSize(jobId: string, accept: boolean): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  if (!accept) {
    await transition(job, "DETECTED", { awaitingSizeConfirm: false });
    await sendToOffscreen({ target: "offscreen", type: "OFFSCREEN_CONFIRM_SIZE", jobId, accept });
    await removeJobRules(jobId);
    return;
  }
  await transition(job, "QUEUED", { awaitingSizeConfirm: false });
  await sendToOffscreen({ target: "offscreen", type: "OFFSCREEN_CONFIRM_SIZE", jobId, accept });
}

export async function cancelJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;

  await sendToOffscreen({ target: "offscreen", type: "OFFSCREEN_CANCEL", jobId }).catch(() => {});
  await clearVariants(jobId);
  await finishJob(job, "CANCELLED");
}

export async function onVariants(jobId: string, variants: Variant[]): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;

  await putVariants(jobId, variants);

  if (variants.length <= 1) return;

  if (job.variantUri !== undefined && variants.some((variant) => variant.uri === job.variantUri)) {
    return;
  }

  const choosing = await transition(job, "CHOOSING", {}, { filename: job.filename });
  notifyPopup({ target: "popup", type: "POPUP_VARIANT_LIST", jobId, variants });
  void choosing;
}

export async function onSizeEstimate(jobId: string, estimatedBytes: number): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;

  const sized = await transition(job, "QUEUED", { estimatedBytes }, { estimatedBytes });
  if (estimatedBytes <= SIZE_CONFIRM_THRESHOLD_BYTES) return;

  await transition(sized, "QUEUED", { awaitingSizeConfirm: true });
  notifyPopup({
    target: "popup",
    type: "POPUP_CONFIRM_SIZE",
    jobId,
    estimatedBytes,
    thresholdBytes: SIZE_CONFIRM_THRESHOLD_BYTES,
  });
}

export async function onFailed(
  jobId: string,
  error: string,
  state: Extract<JobState, "ERROR" | "UNSUPPORTED" | "DRM_BLOCKED"> = "ERROR",
): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  await clearVariants(jobId);
  await finishJob(job, state, { error });
}

function urlIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function dedupeVariantRows(media: DetectedMedia[], busy: Set<string>): DetectedMedia[] {
  const duplicates = new Set<string>();

  for (const master of media) {
    if (master.kind !== "hls" || master.hasAudioGroup !== false) continue;
    const variants = master.variantUris ?? [];
    if (variants.length !== 1) continue;

    const only = urlIdentity(variants[0] ?? "");
    for (const candidate of media) {
      if (candidate.id === master.id || candidate.kind !== "hls") continue;
      if (urlIdentity(candidate.url) === only) duplicates.add(candidate.id);
    }
  }

  for (const mediaId of busy) duplicates.delete(mediaId);
  return media.filter((entry) => !duplicates.has(entry.id));
}

export async function detectedCount(tabId: number): Promise<number> {
  const [media, jobs] = await Promise.all([readDetections(tabId), listJobs()]);
  const busy = new Set(jobs.filter((job) => job.tabId === tabId).map((job) => job.mediaId));
  return dedupeVariantRows(media, busy).length;
}

export async function mediaListView(tabId: number): Promise<MediaListReply> {
  const [media, jobs] = await Promise.all([readDetections(tabId), listJobs()]);
  const tabJobs = jobs.filter((job) => job.tabId === tabId);

  const variants: Record<string, Variant[]> = {};
  for (const job of tabJobs) {
    if (job.state !== "CHOOSING") continue;
    variants[job.jobId] = await getVariants(job.jobId);
  }

  const busy = new Set(tabJobs.map((job) => job.mediaId));
  return {
    media: dedupeVariantRows(media, busy),
    jobs: tabJobs,
    variants,
    launchMode: await getLaunchMode(),
  };
}
