import { hasTarget, type OffscreenToSW, type SWToOffscreen } from "@/src/shared/messages";
import {
  activeJobs,
  cancelJob,
  confirmSize,
  revokeAndClean,
  selectVariant,
  startFetch,
  startHls,
} from "./job";
import { listJobDirs, pruneExcept } from "./opfs";

function reply(message: OffscreenToSW): void {
  void chrome.runtime.sendMessage(message).catch(() => {});
}

async function handle(message: SWToOffscreen): Promise<unknown> {
  switch (message.type) {
    case "OFFSCREEN_START_HLS":
      startHls({
        jobId: message.jobId,
        tabId: message.media.tabId,
        playlistUrl: message.media.url,
        filename: message.filename,
        variantUri: message.variant?.uri,
        auto: message.auto,
      });
      return { ack: true };

    case "OFFSCREEN_START_FETCH":
      startFetch({
        jobId: message.jobId,
        tabId: message.tabId,
        url: message.url,
        filename: message.filename,
      });
      return { ack: true };

    case "OFFSCREEN_SELECT_VARIANT":
      selectVariant(message.jobId, message.variantUri);
      return { ack: true };

    case "OFFSCREEN_CONFIRM_SIZE":
      confirmSize(message.jobId, message.accept);
      return { ack: true };

    case "OFFSCREEN_REVOKE_AND_CLEAN":
      await revokeAndClean(message.jobId);
      return { ack: true };

    case "OFFSCREEN_CANCEL":
      await cancelJob(message.jobId);
      return { ack: true };

    case "OFFSCREEN_LIST_OPFS": {
      const dirs = await listJobDirs();
      reply({ target: "sw", type: "OFFSCREEN_OPFS_LISTING", dirs });
      return { dirs };
    }

    case "OFFSCREEN_PRUNE_OPFS": {
      const dirs = await pruneExcept(message.keep);
      reply({ target: "sw", type: "OFFSCREEN_OPFS_LISTING", dirs });
      return { dirs };
    }

    case "OFFSCREEN_PING":
      return { pong: true, active: activeJobs() };

    default:
      console.warn("[offscreen] unhandled message", (message as { type?: string }).type);
      return { ok: false };
  }
}

export function initOffscreen(): void {
  chrome.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse: (response: unknown) => void) => {
      if (!hasTarget(message, "offscreen")) return false;

      void handle(message as SWToOffscreen)
        .then(sendResponse)
        .catch((error: unknown) => {
          console.warn("[offscreen] handler failed", error);
          sendResponse({ ok: false });
        });
      return true;
    },
  );
}
