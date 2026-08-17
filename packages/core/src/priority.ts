/**
 * Ordenação de candidatos — implementa a regra **R-A: mais recente antes do mais antigo**.
 *
 * A chave de prioridade é hierárquica e o jitter só age no último nível de desempate,
 * dentro do mesmo *bucket de recência*. Isso é deliberado: se o jitter agisse sobre
 * `publishedAt` bruto, um vídeo de ontem poderia passar na frente do de hoje e R-A cairia.
 *
 * O bucket tem largura de horas (padrão 6), não de dias. A granularidade importa:
 * com bucket diário, um upload de 40 minutos atrás empatava com um da manhã do mesmo
 * dia e o desempate ficava no jitter — o que quebra "o mais recente tem prioridade"
 * justamente no caso que a inserção a quente precisa acertar.
 */

import { stableJitter } from './rng.js';
import type { AffinityMap, AirHistory, GridConfig, PoolVideo } from './types.js';

export interface RankedVideo {
  readonly video: PoolVideo;
  /** 0 = inédito (ou fora da janela de re-exibição), 1 = já exibido recentemente. */
  readonly airedBucket: 0 | 1;
  /** Janelas de `recencyBucketHours` desde a publicação. Menor = mais recente. */
  readonly recencyBucket: number;
  /** Desempate dentro do bucket: afinidade do canal × jitter estável. */
  readonly tiebreak: number;
}

export interface RankOptions {
  readonly seed: number;
  readonly affinity: AffinityMap;
  readonly history: AirHistory;
  readonly config: GridConfig;
  /**
   * Instante de referência para medir recência. É `startAtMs` na grade base e o
   * instante do patch nos re-fluxos — sempre um valor registrado, para o replay
   * reproduzir a mesma ordem.
   */
  readonly referenceMs: number;
}

/** Filtros de elegibilidade estruturais. Os de conformidade ficam em `packages/yt`. */
export function filterEligible(pool: readonly PoolVideo[], config: GridConfig): PoolVideo[] {
  return pool.filter((v) => {
    if (v.durationSec <= 0) return false;
    if (v.durationSec < config.minDurationSec) return false;
    if (config.maxDurationSec > 0 && v.durationSec > config.maxDurationSec) return false;
    return true;
  });
}

/** Janelas inteiras de `recencyBucketHours` entre a publicação e a referência. */
export function recencyBucket(
  publishedAt: number,
  referenceMs: number,
  bucketHours: number,
): number {
  const ageMs = referenceMs - publishedAt;
  if (ageMs <= 0) return 0; // publicado na referência ou depois: bucket mais novo
  const bucketMs = Math.max(1, bucketHours) * 3_600_000;
  return Math.floor(ageMs / bucketMs);
}

export function rank(pool: readonly PoolVideo[], opts: RankOptions): RankedVideo[] {
  const { seed, affinity, history, config, referenceMs } = opts;
  return pool.map((video) => ({
    video,
    airedBucket: history.airedVideoIds.has(video.id) ? (1 as const) : (0 as const),
    recencyBucket: recencyBucket(video.publishedAt, referenceMs, config.recencyBucketHours),
    tiebreak:
      (affinity.get(video.ytChannelId) ?? 0) * stableJitter(seed, video.id, config.jitterPct),
  }));
}

/**
 * Comparador total e determinístico.
 *
 * O desempate final por `videoId` não é decoração: sem ele, dois vídeos com afinidade
 * e jitter idênticos ficariam à mercê da estabilidade do `sort` da engine, e a grade
 * deixaria de ser reproduzível entre dispositivos.
 */
export function comparePriority(a: RankedVideo, b: RankedVideo): number {
  if (a.airedBucket !== b.airedBucket) return a.airedBucket - b.airedBucket;
  if (a.recencyBucket !== b.recencyBucket) return a.recencyBucket - b.recencyBucket;
  if (a.tiebreak !== b.tiebreak) return b.tiebreak - a.tiebreak;
  return a.video.id < b.video.id ? -1 : a.video.id > b.video.id ? 1 : 0;
}

export function sortByPriority(pool: readonly PoolVideo[], opts: RankOptions): PoolVideo[] {
  return rank(pool, opts)
    .sort(comparePriority)
    .map((r) => r.video);
}
