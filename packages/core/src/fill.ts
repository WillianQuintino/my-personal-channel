/**
 * Preenchimento guloso com restrições — implementa **R-B: não repetir o mesmo
 * canal do YouTube no mesmo dia**, com relaxamento em cascata.
 *
 * Esta é a primitiva única usada por três caminhos: geração da grade base,
 * re-fluxo após inserção a quente e re-fluxo após descarte de vídeo injogável.
 * Um só algoritmo significa que as três situações respeitam exatamente as mesmas
 * regras — foi o principal motivo para fatorar assim.
 */

import { MS_PER_SEC } from './time.js';
import { RelaxLevel } from './types.js';
import type { Grid, PoolVideo, ScheduleSlot, YtChannelId } from './types.js';

/** Distância mínima em slots exigida por cada nível de relaxamento. */
const MIN_DISTANCE: Record<RelaxLevel, number> = {
  [RelaxLevel.Strict]: Number.POSITIVE_INFINITY, // nunca reusar o canal no dia
  [RelaxLevel.Distance6]: 6,
  [RelaxLevel.Distance2]: 2,
  // Aceita qualquer candidato: `seq - lastSeq` é sempre ≥1, então a condição nunca barra.
  // É a saída de emergência para pools com um único canal.
  [RelaxLevel.Any]: 1,
};

const RELAX_ORDER: readonly RelaxLevel[] = [
  RelaxLevel.Strict,
  RelaxLevel.Distance6,
  RelaxLevel.Distance2,
  RelaxLevel.Any,
];

/**
 * Quantas vezes o pool pode ser reciclado quando esgota antes de cobrir o dia.
 * Sem teto, um pool minúsculo geraria laço infinito; com teto, a grade termina
 * curta e o chamador sinaliza pool degenerado.
 */
const MAX_RECYCLES = 8;

export interface FillParams {
  /** Candidatos **já ordenados** por `sortByPriority`. A ordem é R-A. */
  readonly candidates: readonly PoolVideo[];
  readonly startAtMs: number;
  readonly coverageSec: number;
  readonly startSeq: number;
  /** Último `seq` em que cada canal apareceu antes deste trecho (parte congelada). */
  readonly preUsedLastSeq: ReadonlyMap<YtChannelId, number>;
  /** Marca slots gerados como inserção a quente. Usado só no re-fluxo. */
  readonly hotInsertIds?: ReadonlySet<string>;
  /**
   * Vídeo que **tem** de entrar, na primeira posição em que R-B permitir.
   *
   * Existe por causa de uma armadilha do preenchimento guloso: quando sobram muitos
   * canais inéditos, o nível estrito de R-B sempre encontra outro candidato, e o
   * vídeo de maior prioridade fica preterido para sempre. Para a grade base isso é
   * exatamente o desejado ("prefira canal inédito"); para a inserção a quente
   * anularia o propósito — o upload novo simplesmente não entraria no ar hoje.
   *
   * O pino aceita até o nível `Distance2`, nunca `Any`: a novidade entra, mas não
   * ao preço de colar duas aparições do mesmo canal.
   */
  readonly pinFirst?: PoolVideo;
}

export interface FillResult extends Grid {
  /** Nível máximo de relaxamento que foi necessário. >0 indica pool estreito. */
  readonly maxRelaxUsed: RelaxLevel;
  /** `true` se o pool esgotou e a cobertura ficou menor que a pedida. */
  readonly poolExhausted: boolean;
  /** Último `seq` de cada canal ao fim do preenchimento. */
  readonly usedLastSeq: ReadonlyMap<YtChannelId, number>;
}

function satisfies(
  level: RelaxLevel,
  lastSeq: number | undefined,
  currentSeq: number,
  usedToday: boolean,
): boolean {
  if (level === RelaxLevel.Strict) return !usedToday;
  if (lastSeq === undefined) return true;
  return currentSeq - lastSeq >= MIN_DISTANCE[level];
}

/** Níveis que o pino aceita: entra a novidade, mas sem colar o mesmo canal. */
const PIN_MAX_LEVEL = RelaxLevel.Distance2;

export function fillSlots(params: FillParams): FillResult {
  const { candidates, startAtMs, coverageSec, startSeq, preUsedLastSeq, hotInsertIds, pinFirst } =
    params;

  const targetEndMs = startAtMs + coverageSec * MS_PER_SEC;
  const lastSeqByChannel = new Map<YtChannelId, number>(preUsedLastSeq);
  const usedToday = new Set<YtChannelId>(preUsedLastSeq.keys());
  const consumed = new Set<string>();

  const slots: ScheduleSlot[] = [];
  let cursor = startAtMs;
  let seq = startSeq;
  let maxRelaxUsed = RelaxLevel.Strict;
  let recycles = 0;
  let poolExhausted = false;

  const pick = (): { video: PoolVideo; level: RelaxLevel } | null => {
    // O pino tem precedência sobre a cascata normal, desde que R-B permita.
    if (pinFirst && !consumed.has(pinFirst.id)) {
      for (const level of RELAX_ORDER) {
        if (level > PIN_MAX_LEVEL) break;
        const lastSeq = lastSeqByChannel.get(pinFirst.ytChannelId);
        if (satisfies(level, lastSeq, seq, usedToday.has(pinFirst.ytChannelId))) {
          return { video: pinFirst, level };
        }
      }
    }

    for (const level of RELAX_ORDER) {
      for (const video of candidates) {
        if (consumed.has(video.id)) continue;
        if (
          satisfies(
            level,
            lastSeqByChannel.get(video.ytChannelId),
            seq,
            usedToday.has(video.ytChannelId),
          )
        ) {
          return { video, level };
        }
      }
    }
    return null;
  };

  while (cursor < targetEndMs) {
    let chosen = pick();

    if (!chosen) {
      // Pool esgotado. Reciclar libera re-exibição; `lastSeqByChannel` continua
      // valendo, então R-B ainda espaça os canais depois da reciclagem.
      if (recycles >= MAX_RECYCLES || consumed.size === 0) {
        poolExhausted = true;
        break;
      }
      consumed.clear();
      recycles++;
      chosen = pick();
      if (!chosen) {
        poolExhausted = true;
        break;
      }
    }

    const { video, level } = chosen;
    const endsAtMs = cursor + video.durationSec * MS_PER_SEC;

    slots.push({
      seq,
      videoId: video.id,
      ytChannelId: video.ytChannelId,
      startsAtMs: cursor,
      endsAtMs,
      durationSec: video.durationSec,
      relaxedTo: level,
      isHotInsert: hotInsertIds?.has(video.id) ?? false,
    });

    if (level > maxRelaxUsed) maxRelaxUsed = level;
    consumed.add(video.id);
    lastSeqByChannel.set(video.ytChannelId, seq);
    usedToday.add(video.ytChannelId);
    cursor = endsAtMs;
    seq++;
  }

  return {
    slots,
    coverageEndMs: cursor,
    maxRelaxUsed,
    poolExhausted,
    usedLastSeq: lastSeqByChannel,
  };
}
