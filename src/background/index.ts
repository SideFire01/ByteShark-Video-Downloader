import { readDetections } from "@/src/background/storage";
import { applyLaunchMode, getLaunchMode, showPopupSurface } from "@/src/shared/launch-mode";
import { errorMessage, hasTarget, type OffscreenToSW, type PopupToSW } from "@/src/shared/messages";
import { refreshActiveBadge, registerBadgeListeners } from "./badge";
import { handleDeterminingFilename, resolveCleaned, startDownload } from "./delivery";
import { registerDetectionListeners } from "./detection";
import { diagnostics } from "./diagnostics";
import { forgetDirectFailures, startDirectMp4 } from "./direct-mp4";
import { installJobRules } from "./dnr-rules";
import {
  handleDownloadChanged,
  handleDownloadErased,
  reapStalledJobs,
  reconcileOnStartup,
  startWatchdog,
} from "./downloads";
import {
  cancelJob,
  confirmSize,
  mediaListView,
  onFailed,
  onSizeEstimate,
  onVariants,
  startHlsJobFor,
} from "./hls-dispatch";
import { forgetProgressThrottle, publishProgress, transition } from "./jobs";
import { probeMediaFacts } from "./media-probe";
import { titleReport } from "./page-title";
import { findDetection, getJob } from "./storage";

async function resolveMedia(mediaId: string) {
  const media = await findDetection(mediaId);
  if (!media) throw new Error("that media is no longer detected — reopen the tab");
  return media;
}

async function handleCommand(message: PopupToSW): Promise<void> {
  switch (message.type) {
    case "POPUP_START_MP4":
      await startDirectMp4(await resolveMedia(message.mediaId));
      return;
    case "POPUP_START_HLS":
      await startHlsJobFor(message.mediaId, message.variantUri);
      return;
    case "POPUP_START_MANY": {
      let started = 0;
      let skipped = 0;
      for (const mediaId of message.mediaIds) {
        const media = await findDetection(mediaId);
        if (!media) {
          skipped += 1;
          continue;
        }
        try {
          if (media.kind === "mp4") {
            await startDirectMp4(media);
          } else {
            await startHlsJobFor(mediaId, message.variantUris?.[mediaId], true);
          }
          started += 1;
        } catch (error) {
          skipped += 1;
          console.warn(`[sw] bulk download skipped ${mediaId}: ${errorMessage(error)}`);
        }
      }
      console.info(`[sw] bulk download: ${started} started, ${skipped} skipped`);
      return;
    }
    case "POPUP_CANCEL":
      await cancelJob(message.jobId);
      return;
    case "POPUP_CONFIRM_SIZE":
      await confirmSize(message.jobId, message.accept);
      return;
    case "POPUP_SHOW_POPUP":
      await showPopupSurface(message.tabId >= 0 ? message.tabId : null);
      return;
    default:
      return;
  }
}

function handleRequest(message: PopupToSW, sendResponse: (response: unknown) => void): boolean {
  if (message.type !== "POPUP_LIST_MEDIA") return false;

  void (async () => {
    try {
      const view = await mediaListView(message.tabId);
      void readDetections(message.tabId).then(() => view);
      sendResponse(view);
      probeMediaFacts(view.media);
    } catch (error) {
      console.warn("[sw] POPUP_LIST_MEDIA failed", error);
      sendResponse({ media: [], jobs: [], variants: {}, launchMode: "popup" });
    }
  })();
  return true;
}

async function handleOffscreen(message: OffscreenToSW): Promise<unknown> {
  switch (message.type) {
    case "OFFSCREEN_PROGRESS": {
      const job = await getJob(message.progress.jobId);
      if (!job) return { ok: false };
      if (message.progress.state === "PROCESSING" && job.state !== "PROCESSING") {
        const processing = await transition(job, "PROCESSING");
        await publishProgress(processing, message.progress, true);
        return { ok: true };
      }
      await publishProgress(job, message.progress);
      return { ok: true };
    }

    case "OFFSCREEN_VARIANTS":
      await onVariants(message.jobId, message.variants);
      return { ok: true };

    case "OFFSCREEN_SIZE_ESTIMATE":
      await onSizeEstimate(message.jobId, message.estimatedBytes);
      return { ok: true };

    case "OFFSCREEN_HOSTS": {
      const job = await getJob(message.jobId);
      if (!job) return { applied: false };
      const ruleIds = await installJobRules(job.jobId, job, message.hosts);
      return { applied: ruleIds.length > 0 };
    }

    case "OFFSCREEN_READY_TO_SAVE": {
      const job = await getJob(message.jobId);
      if (!job) return { ok: false };
      try {
        const downloadId = await startDownload(job, message.blobUrl, message.filename);
        await transition(
          job,
          "SAVING",
          { downloadId, filename: message.filename },
          { filename: message.filename },
        );
        return { ok: true };
      } catch (error) {
        await onFailed(message.jobId, `could not save: ${errorMessage(error)}`);
        return { ok: false };
      }
    }

    case "OFFSCREEN_FAILED":
      await onFailed(message.jobId, message.error, message.state ?? "ERROR");
      return { ok: true };

    case "OFFSCREEN_CLEANED":
      resolveCleaned(message.jobId);
      forgetProgressThrottle(message.jobId);
      return { ok: true };

    case "OFFSCREEN_OPFS_LISTING":
      return { ok: true };

    case "OFFSCREEN_PONG":
      return { pong: true };

    default:
      return { ok: false };
  }
}

export function initBackground(): void {
  registerDetectionListeners();
  registerBadgeListeners();

  chrome.downloads.onChanged.addListener(handleDownloadChanged);
  chrome.downloads.onErased.addListener(handleDownloadErased);
  chrome.downloads.onDeterminingFilename.addListener(handleDeterminingFilename);

  chrome.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse: (response: unknown) => void) => {
      if (!hasTarget(message, "sw")) return false;

      const incoming = message as PopupToSW | OffscreenToSW;
      if ("type" in incoming && String(incoming.type).startsWith("OFFSCREEN_")) {
        void handleOffscreen(incoming as OffscreenToSW)
          .then(sendResponse)
          .catch((error: unknown) => {
            console.warn(`[sw] ${incoming.type} failed`, error);
            sendResponse({ ok: false });
          });
        return true;
      }

      if (handleRequest(incoming as PopupToSW, sendResponse)) return true;

      sendResponse({ ack: true });
      void handleCommand(incoming as PopupToSW).catch((error: unknown) => {
        console.warn("[sw] command failed", error);
      });
      return false;
    },
  );

  (globalThis as { diagnostics?: typeof diagnostics }).diagnostics = diagnostics;
  (globalThis as { reconcile?: typeof reconcileOnStartup }).reconcile = reconcileOnStartup;
  (globalThis as { reapStalled?: typeof reapStalledJobs }).reapStalled = reapStalledJobs;
  (globalThis as { forgetDirectFailures?: typeof forgetDirectFailures }).forgetDirectFailures =
    forgetDirectFailures;
  (globalThis as { titleReport?: typeof titleReport }).titleReport = titleReport;

  void (async () => {
    try {
      const report = await reconcileOnStartup();
      if (report.jobs > 0 || report.orphansRemoved > 0) {
        console.info("[sw] startup reconciliation", report);
      }
    } catch (error) {
      console.warn("[sw] startup reconciliation failed", error);
    }
  })();

  void refreshActiveBadge();
  void getLaunchMode().then((mode) => applyLaunchMode(mode));

  startWatchdog();
}
