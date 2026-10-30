import type { LaunchMode } from "./launch-mode";
import type { DetectedMedia, JobProgress, JobRecord, JobState, Variant } from "./types";

export type MessageTarget = "sw" | "offscreen" | "popup";

export type PopupToSW =
  | { target: "sw"; type: "POPUP_LIST_MEDIA"; tabId: number }
  | { target: "sw"; type: "POPUP_START_MP4"; mediaId: string }
  | { target: "sw"; type: "POPUP_START_HLS"; mediaId: string; variantUri?: string }
  | {
      target: "sw";
      type: "POPUP_START_MANY";
      mediaIds: string[];
      variantUris?: Record<string, string>;
    }
  | { target: "sw"; type: "POPUP_CANCEL"; jobId: string }
  | { target: "sw"; type: "POPUP_CONFIRM_SIZE"; jobId: string; accept: boolean }
  | { target: "sw"; type: "POPUP_SHOW_POPUP"; tabId: number };

export type SWToOffscreen =
  | {
      target: "offscreen";
      type: "OFFSCREEN_START_HLS";
      jobId: string;
      media: DetectedMedia;
      filename: string;
      variant?: Variant;
      auto?: boolean;
    }
  | {
      target: "offscreen";
      type: "OFFSCREEN_START_FETCH";
      jobId: string;
      tabId: number;
      url: string;
      filename: string;
    }
  | { target: "offscreen"; type: "OFFSCREEN_SELECT_VARIANT"; jobId: string; variantUri: string }
  | { target: "offscreen"; type: "OFFSCREEN_CONFIRM_SIZE"; jobId: string; accept: boolean }
  | { target: "offscreen"; type: "OFFSCREEN_REVOKE_AND_CLEAN"; jobId: string }
  | { target: "offscreen"; type: "OFFSCREEN_CANCEL"; jobId: string }
  | { target: "offscreen"; type: "OFFSCREEN_LIST_OPFS" }
  | { target: "offscreen"; type: "OFFSCREEN_PRUNE_OPFS"; keep: string[] }
  | { target: "offscreen"; type: "OFFSCREEN_PING" };

export type OffscreenToSW =
  | { target: "sw"; type: "OFFSCREEN_PROGRESS"; progress: JobProgress }
  | { target: "sw"; type: "OFFSCREEN_VARIANTS"; jobId: string; variants: Variant[] }
  | { target: "sw"; type: "OFFSCREEN_SIZE_ESTIMATE"; jobId: string; estimatedBytes: number }
  | {
      target: "sw";
      type: "OFFSCREEN_READY_TO_SAVE";
      jobId: string;
      blobUrl: string;
      filename: string;
    }
  | {
      target: "sw";
      type: "OFFSCREEN_FAILED";
      jobId: string;
      error: string;
      state?: Extract<JobState, "ERROR" | "UNSUPPORTED" | "DRM_BLOCKED">;
    }
  | { target: "sw"; type: "OFFSCREEN_CLEANED"; jobId: string }
  | { target: "sw"; type: "OFFSCREEN_OPFS_LISTING"; dirs: string[] }
  | { target: "sw"; type: "OFFSCREEN_PONG" }
  | {
      target: "sw";
      type: "OFFSCREEN_HOSTS";
      jobId: string;
      hosts: string[];
    };

export type SWToPopup =
  | { target: "popup"; type: "POPUP_VARIANT_LIST"; jobId: string; variants: Variant[] }
  | {
      target: "popup";
      type: "POPUP_CONFIRM_SIZE";
      jobId: string;
      estimatedBytes: number;
      thresholdBytes: number;
    }
  | { target: "popup"; type: "POPUP_ERROR"; message: string };

export const STORAGE_PREFIX = {
  progress: "progress:",
  job: "job:",
  download: "download:",
  detections: "detections:",
  dnr: "dnr:",
  variants: "variants:",
} as const;

export interface MediaListReply {
  media: DetectedMedia[];
  jobs: JobRecord[];
  variants: Record<string, Variant[]>;
  launchMode: LaunchMode;
}

export const SIZE_CONFIRM_THRESHOLD_BYTES = 500 * 1024 * 1024;

export function hasTarget<T extends MessageTarget>(
  message: unknown,
  target: T,
): message is { target: T; type: string } {
  if (typeof message !== "object" || message === null) return false;
  return (message as { target?: unknown }).target === target;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export type { JobRecord };
