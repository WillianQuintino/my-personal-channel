/**
 * Normalização dos recursos crus da API para os registros da aplicação.
 *
 * Fica separada da elegibilidade de propósito: normalizar é traduzir, filtrar é
 * decidir. Um vídeo não-embutível ainda é normalizado e guardado (com a marca),
 * porque saber que ele existe e não pode tocar evita reconsultá-lo depois.
 */

import { videoDurationSec } from './duration.js';
import type {
  RawChannel,
  RawPlaylistItem,
  RawVideo,
  RawSubscription,
  VideoRecord,
} from './types.js';

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Melhor miniatura disponível, preferindo as maiores. */
export function pickThumbnail(
  thumbnails: Readonly<Record<string, { url: string }>> | undefined,
): string | null {
  if (!thumbnails) return null;
  for (const key of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const t = thumbnails[key];
    if (t?.url) return t.url;
  }
  return null;
}

export function normalizeVideo(raw: RawVideo, refreshedAtMs: number): VideoRecord | null {
  const snippet = raw.snippet;
  const ytChannelId = snippet?.channelId;
  // Sem id de vídeo ou de canal o registro é inútil: não dá para escalar nem atribuir.
  if (!raw.id || !ytChannelId) return null;

  const publishedAt = parseTime(snippet?.publishedAt);
  if (publishedAt === null) return null;

  const region = raw.contentDetails?.regionRestriction;

  return {
    id: raw.id,
    ytChannelId,
    ytChannelTitle: snippet?.channelTitle ?? '',
    title: snippet?.title ?? '',
    description: snippet?.description ?? '',
    publishedAt,
    durationSec: videoDurationSec(raw.contentDetails?.duration),
    categoryId: snippet?.categoryId ?? '',
    tags: snippet?.tags ?? [],
    // Ausente conta como não-embutível: presumir que toca produziria erro 150 no ar.
    embeddable: raw.status?.embeddable === true,
    privacyStatus: raw.status?.privacyStatus ?? 'unknown',
    uploadStatus: raw.status?.uploadStatus ?? 'unknown',
    madeForKids: raw.status?.madeForKids === true,
    blockedRegions: region?.blocked ?? [],
    allowedRegions: region?.allowed ?? [],
    // Classificação indicativa costuma vir com portão de idade, que não toca em iframe.
    hasContentRating: Object.keys(raw.contentDetails?.contentRating ?? {}).length > 0,
    liveState: snippet?.liveBroadcastContent ?? 'none',
    liveScheduledStartMs: parseTime(raw.liveStreamingDetails?.scheduledStartTime),
    liveActualStartMs: parseTime(raw.liveStreamingDetails?.actualStartTime),
    liveActualEndMs: parseTime(raw.liveStreamingDetails?.actualEndTime),
    thumbnailUrl: pickThumbnail(snippet?.thumbnails),
    refreshedAtMs,
  };
}

export interface ChannelRecord {
  readonly id: string;
  readonly title: string;
  readonly uploadsPlaylistId: string | null;
  readonly thumbnailUrl: string | null;
  readonly refreshedAtMs: number;
}

export function normalizeChannel(raw: RawChannel, refreshedAtMs: number): ChannelRecord | null {
  if (!raw.id) return null;
  return {
    id: raw.id,
    title: raw.snippet?.title ?? '',
    uploadsPlaylistId: raw.contentDetails?.relatedPlaylists?.uploads ?? null,
    thumbnailUrl: pickThumbnail(raw.snippet?.thumbnails),
    refreshedAtMs,
  };
}

/**
 * Id da playlist de uploads a partir do id do canal.
 *
 * `UC…` → `UU…` é uma convenção estável do YouTube e economiza um `channels.list`
 * inteiro por canal. Ainda assim, quando a resposta da API traz o id explícito, ele
 * tem precedência: a convenção é atalho, não fonte da verdade.
 */
export function uploadsPlaylistIdFor(ytChannelId: string): string | null {
  if (!ytChannelId.startsWith('UC') || ytChannelId.length < 3) return null;
  return `UU${ytChannelId.slice(2)}`;
}

export function subscribedChannelIds(items: readonly RawSubscription[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const id = item.snippet?.resourceId?.channelId;
    if (id) out.push(id);
  }
  return out;
}

/**
 * Ids de vídeo de uma página de `playlistItems`.
 *
 * `contentDetails.videoId` e `snippet.resourceId.videoId` carregam o mesmo dado, mas
 * qual dos dois vem preenchido depende das `part` pedidas, então lemos os dois.
 */
export function playlistVideoIds(items: readonly RawPlaylistItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const id = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
    if (id) out.push(id);
  }
  return out;
}
