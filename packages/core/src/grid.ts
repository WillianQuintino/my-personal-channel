/**
 * Geração da grade base e re-fluxo.
 *
 * A grade materializada é sempre `base(seed) + patches em ordem`. Manter a base
 * determinística é o que permite a um dispositivo que ficou offline reconstruir
 * exatamente a mesma programação ao reconectar, aplicando os patches que perdeu.
 */

import { fillSlots } from './fill.js';
import type { FillResult } from './fill.js';
import { filterEligible, sortByPriority } from './priority.js';
import { gridSeed } from './rng.js';
import { localDayKey, startOfLocalDay } from './time.js';
import type { AffinityMap, AirHistory, GridConfig, PoolVideo, TvChannelId } from './types.js';

export interface BuildGridParams {
  readonly tvChannelId: TvChannelId;
  readonly pool: readonly PoolVideo[];
  readonly affinity: AffinityMap;
  readonly history: AirHistory;
  readonly config: GridConfig;
  /**
   * Instante em que a grade começa. Normalmente a meia-noite local, mas o
   * encadeamento entre dias usa o `coverageEndMs` do dia anterior, para que um
   * vídeo que atravessa a meia-noite não seja cortado nem duplicado.
   */
  readonly startAtMs: number;
}

export interface BuiltGrid extends FillResult {
  readonly tvChannelId: TvChannelId;
  readonly dayKey: string;
  readonly seed: number;
}

export function buildGrid(params: BuildGridParams): BuiltGrid {
  const { tvChannelId, pool, affinity, history, config, startAtMs } = params;

  const dayKey = localDayKey(startAtMs, config.timeZone);
  const seed = gridSeed(tvChannelId, dayKey);
  const eligible = filterEligible(pool, config);
  // A referência de recência é o início da grade: mantém a ordem estável ao longo
  // do dia, para que recomputar a grade às 22h dê o mesmo resultado que às 00h.
  const candidates = sortByPriority(eligible, {
    seed,
    affinity,
    history,
    config,
    referenceMs: startAtMs,
  });

  const result = fillSlots({
    candidates,
    startAtMs,
    coverageSec: config.coverageSec,
    startSeq: 0,
    preUsedLastSeq: new Map(),
  });

  return { ...result, tvChannelId, dayKey, seed };
}

/** Conveniência: grade do dia local que contém `nowMs`, começando na meia-noite local. */
export function buildGridForDay(
  params: Omit<BuildGridParams, 'startAtMs'> & { readonly nowMs: number },
): BuiltGrid {
  const startAtMs = startOfLocalDay(params.nowMs, params.config.timeZone);
  return buildGrid({ ...params, startAtMs });
}
