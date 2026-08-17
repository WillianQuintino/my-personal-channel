/**
 * Construtores de pool para os testes. Ficam em `src` (e não em `__tests__`) porque
 * o worker também os usa para gerar grades de exemplo em desenvolvimento.
 */

import { DEFAULT_GRID_CONFIG } from './types.js';
import type { AffinityMap, AirHistory, GridConfig, PoolVideo, YtChannelId } from './types.js';

export const TZ_SP = 'America/Sao_Paulo';

/** 2026-08-17T00:00:00-03:00 — meia-noite em São Paulo. */
export const DAY_START_SP = Date.UTC(2026, 7, 17, 3, 0, 0);

export function makeConfig(over: Partial<GridConfig> = {}): GridConfig {
  return { ...DEFAULT_GRID_CONFIG, timeZone: TZ_SP, ...over };
}

export function emptyHistory(): AirHistory {
  return { airedVideoIds: new Set() };
}

export function historyOf(...ids: string[]): AirHistory {
  return { airedVideoIds: new Set(ids) };
}

export function affinityOf(entries: Record<YtChannelId, number>): AffinityMap {
  return new Map(Object.entries(entries));
}

export interface MakeVideoOpts {
  readonly id: string;
  readonly ytChannelId: string;
  /** Dias atrás em relação a `DAY_START_SP`. Aceita fração. */
  readonly ageDays?: number;
  readonly durationSec?: number;
  readonly title?: string;
  readonly categoryId?: string;
  readonly tags?: readonly string[];
  readonly isLive?: boolean;
}

export function makeVideo(opts: MakeVideoOpts): PoolVideo {
  const ageDays = opts.ageDays ?? 1;
  return {
    id: opts.id,
    ytChannelId: opts.ytChannelId,
    title: opts.title ?? `vídeo ${opts.id}`,
    durationSec: opts.durationSec ?? 600,
    publishedAt: DAY_START_SP - ageDays * 86_400_000,
    categoryId: opts.categoryId ?? '20',
    tags: opts.tags ?? [],
    ...(opts.isLive === undefined ? {} : { isLive: opts.isLive }),
  };
}

/**
 * Pool sintético: `channels` canais × `perChannel` vídeos, um dia de idade por
 * degrau, para que a ordem cronológica seja inequívoca nos testes de R-A.
 */
export function makePool(channels: number, perChannel: number, durationSec = 600): PoolVideo[] {
  const out: PoolVideo[] = [];
  for (let c = 0; c < channels; c++) {
    for (let v = 0; v < perChannel; v++) {
      out.push(
        makeVideo({
          id: `v-c${c}-n${v}`,
          ytChannelId: `UC${c}`,
          ageDays: v + 1,
          durationSec,
        }),
      );
    }
  }
  return out;
}

/** Afinidade uniforme para todos os canais de um pool. */
export function uniformAffinity(pool: readonly PoolVideo[], value = 0.5): AffinityMap {
  const m = new Map<YtChannelId, number>();
  for (const v of pool) m.set(v.ytChannelId, value);
  return m;
}
