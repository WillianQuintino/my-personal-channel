/**
 * Formas mínimas dos recursos da Data API v3 que usamos. Declaradas à mão em vez de
 * importadas de `googleapis` porque só precisamos de uma fração dos campos, e tipos
 * estreitos deixam explícito o que a aplicação de fato depende.
 */

export interface YtThumbnail {
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
}

export interface RawVideo {
  readonly id: string;
  readonly snippet?: {
    readonly channelId?: string;
    readonly channelTitle?: string;
    readonly title?: string;
    readonly description?: string;
    readonly publishedAt?: string;
    readonly categoryId?: string;
    readonly tags?: readonly string[];
    readonly liveBroadcastContent?: 'none' | 'live' | 'upcoming';
    readonly thumbnails?: Readonly<Record<string, YtThumbnail>>;
  };
  readonly contentDetails?: {
    readonly duration?: string;
    readonly regionRestriction?: {
      readonly allowed?: readonly string[];
      readonly blocked?: readonly string[];
    };
    readonly contentRating?: Readonly<Record<string, unknown>>;
  };
  readonly status?: {
    readonly uploadStatus?: string;
    readonly privacyStatus?: string;
    readonly embeddable?: boolean;
    readonly madeForKids?: boolean;
  };
  readonly liveStreamingDetails?: {
    readonly actualStartTime?: string;
    readonly actualEndTime?: string;
    readonly scheduledStartTime?: string;
    readonly concurrentViewers?: string;
  };
}

export interface RawChannel {
  readonly id: string;
  readonly snippet?: {
    readonly title?: string;
    readonly thumbnails?: Readonly<Record<string, YtThumbnail>>;
  };
  readonly contentDetails?: {
    readonly relatedPlaylists?: {
      readonly uploads?: string;
      readonly likes?: string;
      /**
       * Depreciados em 2016: retornam sempre `HL` e `WL`, e consultá-los devolve
       * lista vazia. Ficam declarados para que ninguém os "descubra" e tente usar.
       * @deprecated Ver R1 em COMPLIANCE.md.
       */
      readonly watchHistory?: string;
      /** @deprecated Ver R1 em COMPLIANCE.md. */
      readonly watchLater?: string;
    };
  };
}

export interface RawSubscription {
  readonly id?: string;
  readonly snippet?: {
    readonly title?: string;
    readonly resourceId?: { readonly channelId?: string };
    readonly thumbnails?: Readonly<Record<string, YtThumbnail>>;
  };
}

export interface RawPlaylistItem {
  readonly id?: string;
  readonly snippet?: {
    readonly channelId?: string;
    readonly title?: string;
    readonly publishedAt?: string;
    readonly resourceId?: { readonly kind?: string; readonly videoId?: string };
  };
  readonly contentDetails?: {
    readonly videoId?: string;
    readonly videoPublishedAt?: string;
  };
}

export interface RawVideoCategory {
  readonly id: string;
  readonly snippet?: {
    readonly title?: string;
    readonly assignable?: boolean;
  };
}

export interface ListResponse<T> {
  readonly items?: readonly T[];
  readonly nextPageToken?: string;
  readonly pageInfo?: { readonly totalResults?: number; readonly resultsPerPage?: number };
}

/** Metadados normalizados de um vídeo, do jeito que a aplicação guarda. */
export interface VideoRecord {
  readonly id: string;
  readonly ytChannelId: string;
  readonly ytChannelTitle: string;
  readonly title: string;
  readonly description: string;
  /** epoch ms */
  readonly publishedAt: number;
  /** `null` quando a duração é desconhecida (live em andamento devolve `PT0S`). */
  readonly durationSec: number | null;
  readonly categoryId: string;
  readonly tags: readonly string[];
  readonly embeddable: boolean;
  readonly privacyStatus: string;
  readonly uploadStatus: string;
  readonly madeForKids: boolean;
  readonly blockedRegions: readonly string[];
  readonly allowedRegions: readonly string[];
  readonly hasContentRating: boolean;
  readonly liveState: 'none' | 'live' | 'upcoming';
  /** epoch ms, quando informado */
  readonly liveScheduledStartMs: number | null;
  readonly liveActualStartMs: number | null;
  readonly liveActualEndMs: number | null;
  readonly thumbnailUrl: string | null;
  /** epoch ms em que estes dados foram lidos da API. Base da regra dos 30 dias (R3). */
  readonly refreshedAtMs: number;
}
