/**
 * Fixtures modeladas em respostas reais da Data API v3. Os testes rodam só contra
 * elas — bater na API em CI queimaria cota compartilhada e faria os testes falharem
 * por motivos alheios ao código.
 */

import type {
  RawChannel,
  RawPlaylistItem,
  RawSubscription,
  RawVideo,
  VideoRecord,
} from './types.js';

export const NOW = Date.UTC(2026, 7, 17, 15, 0, 0);

export interface RawVideoOverrides {
  readonly id?: string;
  readonly channelId?: string;
  readonly duration?: string;
  readonly embeddable?: boolean;
  readonly privacyStatus?: string;
  readonly uploadStatus?: string;
  readonly publishedAt?: string;
  readonly categoryId?: string;
  readonly tags?: readonly string[];
  readonly blocked?: readonly string[];
  readonly allowed?: readonly string[];
  readonly contentRating?: Readonly<Record<string, unknown>>;
  readonly liveBroadcastContent?: 'none' | 'live' | 'upcoming';
  readonly scheduledStartTime?: string;
  readonly actualStartTime?: string;
  readonly actualEndTime?: string;
}

export function rawVideo(over: RawVideoOverrides = {}): RawVideo {
  const regionRestriction =
    over.blocked || over.allowed
      ? {
          ...(over.blocked ? { blocked: over.blocked } : {}),
          ...(over.allowed ? { allowed: over.allowed } : {}),
        }
      : undefined;

  const liveStreamingDetails =
    over.scheduledStartTime || over.actualStartTime || over.actualEndTime
      ? {
          ...(over.scheduledStartTime ? { scheduledStartTime: over.scheduledStartTime } : {}),
          ...(over.actualStartTime ? { actualStartTime: over.actualStartTime } : {}),
          ...(over.actualEndTime ? { actualEndTime: over.actualEndTime } : {}),
        }
      : undefined;

  return {
    id: over.id ?? 'dQw4w9WgXcQ',
    snippet: {
      channelId: over.channelId ?? 'UCuAXFkgsw1L7xaCfnd5JJOw',
      channelTitle: 'Canal de Teste',
      title: 'Vídeo de teste',
      description: 'descrição',
      publishedAt: over.publishedAt ?? '2026-08-16T12:00:00Z',
      categoryId: over.categoryId ?? '20',
      tags: over.tags ?? ['minecraft', 'gameplay'],
      liveBroadcastContent: over.liveBroadcastContent ?? 'none',
      thumbnails: {
        default: { url: 'https://i.ytimg.com/vi/x/default.jpg' },
        high: { url: 'https://i.ytimg.com/vi/x/hqdefault.jpg' },
      },
    },
    contentDetails: {
      duration: over.duration ?? 'PT10M',
      ...(regionRestriction ? { regionRestriction } : {}),
      ...(over.contentRating ? { contentRating: over.contentRating } : {}),
    },
    status: {
      uploadStatus: over.uploadStatus ?? 'processed',
      privacyStatus: over.privacyStatus ?? 'public',
      embeddable: over.embeddable ?? true,
      madeForKids: false,
    },
    ...(liveStreamingDetails ? { liveStreamingDetails } : {}),
  };
}

export function rawChannel(id = 'UCuAXFkgsw1L7xaCfnd5JJOw'): RawChannel {
  return {
    id,
    snippet: {
      title: 'Canal de Teste',
      thumbnails: { high: { url: 'https://yt3.ggpht.com/x' } },
    },
    contentDetails: {
      relatedPlaylists: {
        uploads: `UU${id.slice(2)}`,
        likes: 'LL',
        // Valores que a API devolve desde 2016 — consultá-los dá lista vazia (R1).
        watchHistory: 'HL',
        watchLater: 'WL',
      },
    },
  };
}

export function rawSubscription(channelId: string): RawSubscription {
  return {
    id: `sub-${channelId}`,
    snippet: { title: `Canal ${channelId}`, resourceId: { channelId } },
  };
}

export function rawPlaylistItem(videoId: string): RawPlaylistItem {
  return {
    id: `pli-${videoId}`,
    contentDetails: { videoId, videoPublishedAt: '2026-08-16T12:00:00Z' },
  };
}

/** Registro normalizado, já pronto, para testar elegibilidade sem passar pelo cliente. */
export function videoRecord(over: Partial<VideoRecord> = {}): VideoRecord {
  return {
    id: 'vid1',
    ytChannelId: 'UC1',
    ytChannelTitle: 'Canal 1',
    title: 'Título',
    description: '',
    publishedAt: NOW - 86_400_000,
    durationSec: 600,
    categoryId: '20',
    tags: [],
    embeddable: true,
    privacyStatus: 'public',
    uploadStatus: 'processed',
    madeForKids: false,
    blockedRegions: [],
    allowedRegions: [],
    hasContentRating: false,
    liveState: 'none',
    liveScheduledStartMs: null,
    liveActualStartMs: null,
    liveActualEndMs: null,
    thumbnailUrl: null,
    refreshedAtMs: NOW,
    ...over,
  };
}
