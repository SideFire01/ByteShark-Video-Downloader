export type DetectedKind = "mp4" | "hls";

export interface DetectedMedia {
  id: string;
  tabId: number;
  url: string;
  kind: DetectedKind;
  contentType?: string;
  documentUrl?: string;
  frameId?: number;
  timestamp: number;
  dedupeKey: string;
  estimatedBytes?: number;
  variantEstimates?: Record<string, number>;
  variantDetails?: Record<string, VariantDetail>;
  variantUris?: string[];
  hasAudioGroup?: boolean;
  durationSeconds?: number;
  probeAt?: number;
}

export interface Variant {
  bandwidth: number;
  resolution?: { width: number; height: number };
  uri: string;
}

export interface VariantDetail {
  bandwidth: number;
  width?: number;
  height?: number;
}

export interface KeyEntry {
  mediaSequence: number;
  keyUri: string;
  ivHex?: string;
  keyFormat: string;
}

export type EncryptionClass =
  | { kind: "none" }
  | { kind: "aes128"; keys: KeyEntry[] }
  | { kind: "drm"; reason: string }
  | { kind: "unsupported"; reason: string };

export type JobState =
  | "DETECTED"
  | "QUEUED"
  | "CHOOSING"
  | "PROCESSING"
  | "SAVING"
  | "DONE"
  | "CANCELLED"
  | "DRM_BLOCKED"
  | "UNSUPPORTED"
  | "ERROR";

export interface JobProgress {
  jobId: string;
  tabId: number;
  state: JobState;
  segmentsDone?: number;
  segmentsTotal?: number;
  bytesWritten?: number;
  estimatedBytes?: number;
  error?: string;
  filename?: string;
  at?: number;
}

export interface JobRecord {
  jobId: string;
  tabId: number;
  mediaId: string;
  kind: DetectedKind;
  url: string;
  documentUrl?: string;
  filename: string;
  state: JobState;
  variantUri?: string;
  downloadId?: number;
  fallbackAttempted?: boolean;
  awaitingSizeConfirm?: boolean;
  estimatedBytes?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
