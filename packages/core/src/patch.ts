/**
 * Replay de patches — o que mantém a grade idêntica entre dispositivos.
 *
 * A grade materializada nunca é "o que este dispositivo calculou": é
 * `base(seed) + patches aplicados em ordem de seqNo`. Um dispositivo que ficou
 * offline reconstrói a programação exata ao reconectar, sem precisar baixar a
 * grade inteira — só os patches que perdeu.
 */

import { applyHotInsert, dropUnplayable } from './hotinsert.js';
import type { BuiltGrid } from './grid.js';
import type {
  AffinityMap,
  AirHistory,
  GridConfig,
  PoolVideo,
  ScheduleSlot,
  SchedulePatch,
  VideoId,
  YtChannelId,
} from './types.js';

export class PatchOrderError extends Error {
  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super(`patch fora de ordem: esperado seqNo ${expected}, recebido ${received}`);
    this.name = 'PatchOrderError';
  }
}

export interface ReplayParams {
  readonly base: BuiltGrid;
  readonly patches: readonly SchedulePatch[];
  readonly pool: readonly PoolVideo[];
  readonly affinity: AffinityMap;
  readonly favorites: ReadonlySet<YtChannelId>;
  readonly history: AirHistory;
  readonly config: GridConfig;
}

export interface ReplayResult {
  readonly slots: readonly ScheduleSlot[];
  readonly applied: number;
  readonly skipped: readonly { readonly seqNo: number; readonly reason: string }[];
}

/**
 * Aplica os patches sobre a grade base.
 *
 * Ordem é obrigatória e verificada: aplicar um `HOT_INSERT` antes de um
 * `DROP_UNPLAYABLE` anterior produziria uma grade diferente, e a divergência
 * silenciosa entre dispositivos seria muito difícil de diagnosticar depois.
 * Melhor falhar alto.
 */
export function replayPatches(params: ReplayParams): ReplayResult {
  const { base, patches, pool, affinity, favorites, history, config } = params;

  let slots: readonly ScheduleSlot[] = base.slots;
  const skipped: { seqNo: number; reason: string }[] = [];
  let applied = 0;
  let expectedSeqNo = 1;
  const hotInsertsAtMs: number[] = [];

  for (const patch of patches) {
    if (patch.seqNo !== expectedSeqNo) {
      throw new PatchOrderError(expectedSeqNo, patch.seqNo);
    }
    expectedSeqNo++;

    switch (patch.kind) {
      case 'HOT_INSERT': {
        const video = findVideo(pool, patch.videoId);
        if (!video) {
          skipped.push({ seqNo: patch.seqNo, reason: 'vídeo ausente do pool' });
          continue;
        }
        const outcome = applyHotInsert({
          slots,
          newVideo: video,
          pool,
          nowMs: patch.appliedAtMs,
          seed: base.seed,
          affinity,
          favorites,
          history,
          config,
          priorHotInsertsAtMs: hotInsertsAtMs,
        });
        if (outcome.applied) {
          slots = outcome.slots;
          hotInsertsAtMs.push(patch.appliedAtMs);
          applied++;
        } else {
          skipped.push({ seqNo: patch.seqNo, reason: outcome.reason });
        }
        break;
      }

      case 'DROP_UNPLAYABLE': {
        if (!patch.videoId) {
          skipped.push({ seqNo: patch.seqNo, reason: 'patch sem videoId' });
          continue;
        }
        const result = dropUnplayable({
          slots,
          unplayableVideoId: patch.videoId,
          pool,
          nowMs: patch.appliedAtMs,
          seed: base.seed,
          affinity,
          history,
          config,
        });
        slots = result.slots;
        applied++;
        break;
      }

      case 'AFFINITY_REFLOW': {
        // Reordenação motivada por mudança de gosto: mesmo mecanismo do descarte,
        // mas sem remover nada — apenas re-flui a cauda com a afinidade atual.
        const result = dropUnplayable({
          slots,
          unplayableVideoId: '__none__',
          pool,
          nowMs: patch.appliedAtMs,
          seed: base.seed,
          affinity,
          history,
          config,
        });
        slots = result.slots;
        applied++;
        break;
      }
    }
  }

  return { slots, applied, skipped };
}

function findVideo(pool: readonly PoolVideo[], id: VideoId | null): PoolVideo | undefined {
  if (!id) return undefined;
  return pool.find((v) => v.id === id);
}
