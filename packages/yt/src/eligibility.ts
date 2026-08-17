/**
 * Elegibilidade de vídeo (R13) e validade de cache (R3).
 *
 * R13 é a causa número um de "canal travado": um vídeo não-embutível, removido ou
 * bloqueado na região devolve erro 150/100 no ar e, se ninguém tratar, o canal
 * congela em tela preta. Este módulo é a primeira das três camadas de defesa — as
 * outras duas (watchdog de carregamento e `onError`) ficam no player.
 */

import type { PoolVideo } from '@minhatv/core';
import type { VideoRecord } from './types.js';

/** Prazo máximo de retenção de dados da API, em dias corridos (R3). */
export const CACHE_MAX_AGE_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Margem para revalidar antes do prazo. Sem folga, um job que atrase algumas horas
 * deixaria registros passarem dos 30 dias — violação, não atraso.
 */
export const CACHE_REFRESH_AFTER_DAYS = 25;

export type IneligibleReason =
  | 'not_embeddable'
  | 'not_public'
  | 'not_processed'
  | 'region_blocked'
  | 'region_not_allowed'
  | 'age_gated'
  | 'unknown_duration'
  | 'too_short'
  | 'too_long'
  | 'live_in_progress'
  | 'marked_unplayable'
  | 'cache_expired';

export interface EligibilityOptions {
  /** Código ISO 3166-1 alpha-2 do usuário, para as restrições regionais. */
  readonly region: string;
  readonly minDurationSec: number;
  /** 0 = sem limite. */
  readonly maxDurationSec: number;
  /** epoch ms — necessário para checar a validade de 30 dias. */
  readonly nowMs: number;
  /** Vídeos que já falharam no player e foram marcados no banco. */
  readonly unplayableIds?: ReadonlySet<string>;
  /**
   * `true` para canais em modo VOD, que não devem escalar uma live em andamento
   * (duração indefinida arruinaria a grade). Canais de live tratam isso à parte.
   */
  readonly excludeLive?: boolean;
}

export type EligibilityVerdict =
  { readonly eligible: true } | { readonly eligible: false; readonly reason: IneligibleReason };

/** Idade do registro em dias. */
export function cacheAgeDays(record: { refreshedAtMs: number }, nowMs: number): number {
  return (nowMs - record.refreshedAtMs) / DAY_MS;
}

/** `true` quando o registro passou dos 30 dias e **tem de** ser apagado ou revalidado (R3). */
export function isCacheExpired(record: { refreshedAtMs: number }, nowMs: number): boolean {
  return cacheAgeDays(record, nowMs) >= CACHE_MAX_AGE_DAYS;
}

/** `true` quando está na hora de revalidar, antes de chegar ao prazo. */
export function needsRefresh(record: { refreshedAtMs: number }, nowMs: number): boolean {
  return cacheAgeDays(record, nowMs) >= CACHE_REFRESH_AFTER_DAYS;
}

export function checkEligibility(video: VideoRecord, opts: EligibilityOptions): EligibilityVerdict {
  const reject = (reason: IneligibleReason): EligibilityVerdict => ({ eligible: false, reason });

  // Vem primeiro: um registro vencido não pode nem ser consultado, muito menos escalado.
  if (isCacheExpired(video, opts.nowMs)) return reject('cache_expired');

  if (opts.unplayableIds?.has(video.id)) return reject('marked_unplayable');

  if (!video.embeddable) return reject('not_embeddable');
  if (video.privacyStatus !== 'public') return reject('not_public');
  if (video.uploadStatus !== 'processed') return reject('not_processed');

  // Conteúdo com classificação indicativa costuma exigir login e não toca em iframe.
  if (video.hasContentRating) return reject('age_gated');

  const region = opts.region.toUpperCase();
  if (video.blockedRegions.some((r) => r.toUpperCase() === region)) {
    return reject('region_blocked');
  }
  if (
    video.allowedRegions.length > 0 &&
    !video.allowedRegions.some((r) => r.toUpperCase() === region)
  ) {
    return reject('region_not_allowed');
  }

  if (video.liveState === 'live' && opts.excludeLive === true) {
    return reject('live_in_progress');
  }
  // 'upcoming' nunca entra em grade VOD: não há nada para tocar ainda.
  if (video.liveState === 'upcoming') return reject('live_in_progress');

  if (video.durationSec === null) return reject('unknown_duration');
  if (video.durationSec < opts.minDurationSec) return reject('too_short');
  if (opts.maxDurationSec > 0 && video.durationSec > opts.maxDurationSec) {
    return reject('too_long');
  }

  return { eligible: true };
}

/** Converte um registro elegível no `PoolVideo` que o motor de grade consome. */
export function toPoolVideo(video: VideoRecord): PoolVideo | null {
  if (video.durationSec === null) return null;
  return {
    id: video.id,
    ytChannelId: video.ytChannelId,
    title: video.title,
    durationSec: video.durationSec,
    publishedAt: video.publishedAt,
    categoryId: video.categoryId,
    tags: video.tags,
    ...(video.liveState === 'live' ? { isLive: true } : {}),
  };
}

export interface PoolBuildResult {
  readonly pool: readonly PoolVideo[];
  /** Contagem por motivo de recusa. Alimenta o diagnóstico de "pool pequeno" na UI. */
  readonly rejected: Readonly<Record<string, number>>;
}

/**
 * Aplica R13 a uma lista de registros e devolve o pool pronto para a grade,
 * junto com o porquê de cada recusa.
 *
 * A contagem de recusas não é telemetria decorativa: é o que permite dizer ao usuário
 * "seu canal de #minecraft tem 3 vídeos porque 40 não são embutíveis", em vez de
 * apresentar um canal vazio sem explicação.
 */
export function buildPool(
  videos: readonly VideoRecord[],
  opts: EligibilityOptions,
): PoolBuildResult {
  const pool: PoolVideo[] = [];
  const rejected: Record<string, number> = {};

  for (const video of videos) {
    const verdict = checkEligibility(video, opts);
    if (!verdict.eligible) {
      rejected[verdict.reason] = (rejected[verdict.reason] ?? 0) + 1;
      continue;
    }
    const poolVideo = toPoolVideo(video);
    if (poolVideo) pool.push(poolVideo);
    else rejected['unknown_duration'] = (rejected['unknown_duration'] ?? 0) + 1;
  }

  return { pool, rejected };
}
