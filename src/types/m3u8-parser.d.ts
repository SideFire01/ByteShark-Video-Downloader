declare module "m3u8-parser" {
  export interface M3u8Key {
    method: string;
    uri?: string;
    iv?: Uint32Array | Record<string, number>;
    keyFormat?: string;
  }

  export interface M3u8Map {
    uri: string;
  }

  export interface M3u8Segment {
    uri: string;
    duration: number;
    key?: M3u8Key;
    map?: M3u8Map;
    discontinuitySequence?: number;
  }

  export interface M3u8VariantStream {
    uri: string;
    attributes: {
      BANDWIDTH?: number;
      "AVERAGE-BANDWIDTH"?: number;
      RESOLUTION?: { width: number; height: number };
      CODECS?: string;
      AUDIO?: string;
    };
  }

  export interface M3u8MediaGroup {
    default?: boolean;
    autoselect?: boolean;
    uri?: string;
  }

  export interface M3u8Manifest {
    playlists?: M3u8VariantStream[];
    segments?: M3u8Segment[];
    endList?: boolean;
    mediaSequence?: number;
    targetDuration?: number;
    mediaGroups?: {
      AUDIO?: Record<string, Record<string, M3u8MediaGroup>>;
    };
  }

  export class Parser {
    manifest: M3u8Manifest;
    push(chunk: string): void;
    end(): void;
  }
}
