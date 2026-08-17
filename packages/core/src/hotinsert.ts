/**
 * Inserção a quente (§2b): vídeo novo e relevante entra na programação do dia
 * e reajusta o resto da grade.
 *
 * O invariante que sustenta tudo: **o slot no ar e a zona congelada nunca mudam**.
 * Sem isso, um upload novo daria solavanco em quem está assistindo e desmentiria
 * o guia que o usuário acabou de ler.
 */

import { fillSlots } from './fill.js';
import { filterEligible, sortByPriority } from './priority.js';
import { halfLifeDecay, localDayKey, MS_PER_SEC } from './time.js';
import { findSlotAt } from './tune.js';
import type { RelaxLevel } from './types.js';
import type {
  AffinityMap,
  AirHistory,
  GridConfig,
  PoolVideo,
  ScheduleSlot,
  VideoId,
  YtChannelId,
} from './types.js';

// ---------------------------------------------------------------------------
// Portão de relevância
// ---------------------------------------------------------------------------

export type HotInsertGate =
  | { readonly eligible: true; readonly reason: 'top_affinity' | 'favorite' | 'live_start' }
  | { readonly eligible: false; readonly reason: 'low_affinity' | 'stale' | 'filtered_out' };

/** Score de relevância: recência × afinidade. Recência decai rápido (meia-vida ~6h). */
export function relevanceScore(params: {
  readonly video: PoolVideo;
  readonly nowMs: number;
  readonly affinity: AffinityMap;
  readonly config: GridConfig;
}): number {
  const { video, nowMs, affinity, config } = params;
  const recency = halfLifeDecay(nowMs - video.publishedAt, config.recencyHalfLifeHours);
  return recency * (affinity.get(video.ytChannelId) ?? 0);
}

/**
 * Decide se um vídeo novo merece interromper a grade do dia.
 *
 * O portão existe porque sem ele *todo* upload de *todo* canal do pool viraria uma
 * reordenação — a grade nunca assentaria. Só passa conteúdo de canais que você
 * realmente acompanha, ou live começando agora.
 */
export function evaluateHotInsertGate(params: {
  readonly video: PoolVideo;
  readonly nowMs: number;
  readonly affinity: AffinityMap;
  readonly favorites: ReadonlySet<YtChannelId>;
  readonly config: GridConfig;
}): HotInsertGate {
  const { video, nowMs, affinity, favorites, config } = params;

  if (filterEligible([video], config).length === 0) {
    return { eligible: false, reason: 'filtered_out' };
  }
  if (video.isLive === true) {
    return { eligible: true, reason: 'live_start' };
  }
  if (favorites.has(video.ytChannelId)) {
    return { eligible: true, reason: 'favorite' };
  }

  // Vídeo antigo não é "novidade" — entra na grade de amanhã pelo caminho normal.
  const recency = halfLifeDecay(nowMs - video.publishedAt, config.recencyHalfLifeHours);
  if (recency < 0.25) {
    return { eligible: false, reason: 'stale' };
  }

  const topK = topKChannels(affinity, config.topKAffinity);
  return topK.has(video.ytChannelId)
    ? { eligible: true, reason: 'top_affinity' }
    : { eligible: false, reason: 'low_affinity' };
}

/** Os K canais de maior afinidade. Empate resolvido por id, para ser determinístico. */
export function topKChannels(affinity: AffinityMap, k: number): ReadonlySet<YtChannelId> {
  const sorted = [...affinity.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  return new Set(sorted.slice(0, Math.max(0, k)).map(([id]) => id));
}

// ---------------------------------------------------------------------------
// Zonas de congelamento
// ---------------------------------------------------------------------------

export interface GridZones {
  /** Slot no ar agora. Imutável. */
  readonly onAir: ScheduleSlot | undefined;
  /** Slots dentro do horizonte congelado. Imutáveis — o EPG já os prometeu. */
  readonly frozen: readonly ScheduleSlot[];
  /** Resto do dia. Re-fluível. */
  readonly tail: readonly ScheduleSlot[];
  /** Instante em que a cauda começa. */
  readonly tailStartsAtMs: number;
}

/**
 * Divide a grade em ao-ar / congelada / cauda.
 *
 * A fronteira é `nowMs + frozenHorizonSec`, mas um slot só é considerado congelado
 * se **começa** antes dela; um slot que começa depois é re-fluível inteiro. Cortar
 * um slot no meio produziria um vídeo entrando pela metade sem motivo.
 */
export function computeZones(
  slots: readonly ScheduleSlot[],
  nowMs: number,
  config: GridConfig,
): GridZones {
  const frozenUntilMs = nowMs + config.frozenHorizonSec * MS_PER_SEC;
  const onAir = findSlotAt(slots, nowMs);

  const frozen: ScheduleSlot[] = [];
  const tail: ScheduleSlot[] = [];

  for (const slot of slots) {
    if (slot.endsAtMs <= nowMs) continue; // passado: fora das três zonas
    if (slot.startsAtMs < frozenUntilMs) frozen.push(slot);
    else tail.push(slot);
  }

  const lastFrozen = frozen[frozen.length - 1];
  const tailStartsAtMs = lastFrozen ? lastFrozen.endsAtMs : Math.max(nowMs, frozenUntilMs);

  return { onAir, frozen, tail, tailStartsAtMs };
}

// ---------------------------------------------------------------------------
// Aplicação
// ---------------------------------------------------------------------------

export type HotInsertRejection =
  | 'gate_rejected'
  | 'rate_limited'
  | 'too_soon_after_last'
  | 'no_reflowable_tail'
  | 'already_scheduled';

export type HotInsertOutcome =
  | {
      readonly applied: true;
      readonly slots: readonly ScheduleSlot[];
      readonly coverageEndMs: number;
      readonly insertedAtSeq: number;
      readonly displacedVideoId: VideoId | null;
      readonly gateReason: string;
      readonly maxRelaxUsed: RelaxLevel;
    }
  | {
      readonly applied: false;
      readonly reason: HotInsertRejection;
      readonly slots: readonly ScheduleSlot[];
    };

export interface ApplyHotInsertParams {
  readonly slots: readonly ScheduleSlot[];
  readonly newVideo: PoolVideo;
  /** Pool corrente, para o re-fluxo poder escolher substitutos. */
  readonly pool: readonly PoolVideo[];
  readonly nowMs: number;
  readonly seed: number;
  readonly affinity: AffinityMap;
  readonly favorites: ReadonlySet<YtChannelId>;
  readonly history: AirHistory;
  readonly config: GridConfig;
  /** `appliedAtMs` das inserções a quente já feitas hoje neste canal de TV. */
  readonly priorHotInsertsAtMs: readonly number[];
}

export function applyHotInsert(params: ApplyHotInsertParams): HotInsertOutcome {
  const {
    slots,
    newVideo,
    pool,
    nowMs,
    seed,
    affinity,
    favorites,
    history,
    config,
    priorHotInsertsAtMs,
  } = params;

  const gate = evaluateHotInsertGate({ video: newVideo, nowMs, affinity, favorites, config });
  if (!gate.eligible) return { applied: false, reason: 'gate_rejected', slots };

  // Limites anti-turbulência: uma rajada de uploads não pode reescrever o dia.
  if (priorHotInsertsAtMs.length >= config.maxHotInsertsPerDay) {
    return { applied: false, reason: 'rate_limited', slots };
  }
  const lastAt = priorHotInsertsAtMs.length ? Math.max(...priorHotInsertsAtMs) : undefined;
  if (lastAt !== undefined && nowMs - lastAt < config.minHotInsertGapSec * MS_PER_SEC) {
    return { applied: false, reason: 'too_soon_after_last', slots };
  }

  const zones = computeZones(slots, nowMs, config);
  if (zones.tail.length === 0) {
    return { applied: false, reason: 'no_reflowable_tail', slots };
  }

  /*
   * A guarda cobre a grade **inteira**, não só a zona congelada.
   *
   * `pinFirst` contorna de propósito a lista de candidatos, para não ser preterido
   * por R-B — e isso significa que ele também contornaria a exclusão de vídeos já
   * escalados. Sem esta verificação, patches repetidos do mesmo upload o colocavam
   * várias vezes no mesmo dia. Um vídeo vai ao ar uma vez por dia, ponto.
   */
  if (slots.some((s) => s.videoId === newVideo.id)) {
    return { applied: false, reason: 'already_scheduled', slots };
  }
  const frozenIds = new Set<VideoId>(zones.frozen.map((s) => s.videoId));

  // R-B contra a parte imutável do dia.
  const frozenUseLastSeq = new Map<YtChannelId, number>();
  for (const slot of zones.frozen) frozenUseLastSeq.set(slot.ytChannelId, slot.seq);

  // Slots já passados também contam para "canal usado hoje": o dia é o dia inteiro.
  const pastSlots = slots.filter((s) => s.endsAtMs <= nowMs);
  for (const slot of pastSlots) {
    const prev = frozenUseLastSeq.get(slot.ytChannelId);
    if (prev === undefined || slot.seq > prev) frozenUseLastSeq.set(slot.ytChannelId, slot.seq);
  }

  const tailSeqStart = zones.tail[0]?.seq ?? 0;

  // Conjunto de vídeos disponíveis para a cauda: o pool, menos o que já é imutável,
  // mais o vídeo novo.
  const byId = new Map<VideoId, PoolVideo>();
  for (const v of filterEligible(pool, config)) byId.set(v.id, v);
  byId.set(newVideo.id, newVideo);
  for (const id of frozenIds) byId.delete(id);
  for (const s of pastSlots) byId.delete(s.videoId);

  // Aqui a referência é o "agora" do patch, não o início do dia: é o que faz um
  // upload de minutos atrás vencer um vídeo da manhã do mesmo dia.
  const candidates = sortByPriority([...byId.values()], {
    seed,
    affinity,
    history,
    config,
    referenceMs: nowMs,
  });

  /*
   * Não há caso especial para conflito de R-B, e isso é deliberado.
   *
   * `fillSlots` já resolve o conflito melhor do que qualquer regra escrita à mão:
   * por R-A o vídeo novo é o candidato de maior prioridade, então cai no primeiro
   * slot da cauda em que R-B permite. Se o canal dele acabou de passar na zona
   * congelada, o relaxamento em cascata o coloca duas posições depois, em vez de
   * colar duas aparições do mesmo canal — e o "deslocamento" da ocorrência antiga
   * daquele canal acontece por consequência, porque R-B só admite uma aparição por
   * dia e R-A prefere a versão mais nova. Um algoritmo, não dois.
   */
  const remainingCoverageSec = Math.max(
    0,
    Math.round((slots[slots.length - 1]?.endsAtMs ?? zones.tailStartsAtMs) / MS_PER_SEC) -
      Math.round(zones.tailStartsAtMs / MS_PER_SEC),
  );

  const refilled = fillSlots({
    candidates,
    startAtMs: zones.tailStartsAtMs,
    coverageSec: remainingCoverageSec,
    startSeq: tailSeqStart,
    preUsedLastSeq: frozenUseLastSeq,
    hotInsertIds: new Set([newVideo.id]),
    pinFirst: newVideo,
  });

  const insertedSlot = refilled.slots.find((s) => s.videoId === newVideo.id);
  if (!insertedSlot) {
    // A cauda não tinha espaço para o vídeo novo (cauda curtíssima no fim do dia).
    return { applied: false, reason: 'no_reflowable_tail', slots };
  }

  const merged = [...pastSlots, ...zones.frozen, ...refilled.slots];

  // Deslocamento é derivado, não decidido: quem saiu da cauda por causa da chegada
  // do vídeo novo, no mesmo canal. Serve para a UI explicar a troca ao usuário.
  const tailAfter = new Set(refilled.slots.map((s) => s.videoId));
  const displacedVideoId =
    zones.tail.find((s) => s.ytChannelId === newVideo.ytChannelId && !tailAfter.has(s.videoId))
      ?.videoId ?? null;

  return {
    applied: true,
    slots: merged,
    coverageEndMs: refilled.coverageEndMs,
    insertedAtSeq: insertedSlot.seq,
    displacedVideoId,
    gateReason: gate.reason,
    maxRelaxUsed: refilled.maxRelaxUsed,
  };
}

// ---------------------------------------------------------------------------
// Descarte de vídeo injogável (§5) — mesmo mecanismo de re-fluxo
// ---------------------------------------------------------------------------

export interface DropUnplayableParams {
  readonly slots: readonly ScheduleSlot[];
  readonly unplayableVideoId: VideoId;
  readonly pool: readonly PoolVideo[];
  readonly nowMs: number;
  readonly seed: number;
  readonly affinity: AffinityMap;
  readonly history: AirHistory;
  readonly config: GridConfig;
}

/**
 * Remove um vídeo que falhou em runtime e re-flui dali para frente.
 *
 * Diferente da inserção a quente, aqui **o slot no ar pode ser justamente o que
 * falhou** — é o caso comum: o player acusou erro 150 no vídeo que estava entrando.
 * Então o re-fluxo começa em `nowMs`, não depois da zona congelada.
 */
export function dropUnplayable(params: DropUnplayableParams): {
  readonly slots: readonly ScheduleSlot[];
  readonly coverageEndMs: number;
} {
  const { slots, unplayableVideoId, pool, nowMs, seed, affinity, history, config } = params;

  /*
   * O passado fica intacto, inclusive se o vídeo injogável já foi ao ar mais cedo.
   *
   * Filtrar o passado abriria um buraco na grade — os vizinhos do slot removido
   * continuariam com os horários antigos, e a contiguidade quebraria. Pelo mesmo
   * princípio da zona congelada: o que já passou não se reescreve. Excluir o vídeo
   * das escalações futuras é feito pelo pool, não mexendo no histórico.
   */
  const past = slots.filter((s) => s.endsAtMs <= nowMs);
  const onAir = findSlotAt(slots, nowMs);

  /*
   * Onde o re-fluxo começa depende de o vídeo que falhou ser ou não o que está no ar.
   * Emendar sempre em `nowMs` deixaria um vão entre o fim do último slot passado e o
   * instante do erro — foi exatamente o defeito que os testes de contiguidade pegaram.
   */
  const preserved: ScheduleSlot[] = [...past];
  let refillStartMs: number;

  if (onAir && onAir.videoId === unplayableVideoId) {
    // O vídeo no ar falhou: o slot é cortado no instante do erro e o substituto
    // emenda ali, sem tela preta.
    const airedSec = Math.max(0, Math.round((nowMs - onAir.startsAtMs) / MS_PER_SEC));
    if (airedSec > 0) {
      preserved.push({
        ...onAir,
        endsAtMs: onAir.startsAtMs + airedSec * MS_PER_SEC,
        durationSec: airedSec,
        truncated: true,
      });
    }
    refillStartMs = preserved[preserved.length - 1]?.endsAtMs ?? nowMs;
  } else if (onAir) {
    // O vídeo que falhou está adiante: quem está no ar continua intacto.
    preserved.push(onAir);
    refillStartMs = onAir.endsAtMs;
  } else {
    refillStartMs = past[past.length - 1]?.endsAtMs ?? nowMs;
  }

  const usedLastSeq = new Map<YtChannelId, number>();
  for (const slot of preserved) {
    const prev = usedLastSeq.get(slot.ytChannelId);
    if (prev === undefined || slot.seq > prev) usedLastSeq.set(slot.ytChannelId, slot.seq);
  }

  const byId = new Map<VideoId, PoolVideo>();
  for (const v of filterEligible(pool, config)) byId.set(v.id, v);
  byId.delete(unplayableVideoId);
  for (const s of preserved) byId.delete(s.videoId);

  const candidates = sortByPriority([...byId.values()], {
    seed,
    affinity,
    history,
    config,
    referenceMs: nowMs,
  });

  const startSeq = (preserved[preserved.length - 1]?.seq ?? -1) + 1;
  const lastEnd = slots[slots.length - 1]?.endsAtMs ?? refillStartMs;
  const coverageSec = Math.max(0, Math.round((lastEnd - refillStartMs) / MS_PER_SEC));

  const refilled = fillSlots({
    candidates,
    startAtMs: refillStartMs,
    coverageSec,
    startSeq,
    preUsedLastSeq: usedLastSeq,
  });

  return {
    slots: [...preserved, ...refilled.slots],
    coverageEndMs: refilled.coverageEndMs,
  };
}

/** Chave de dia usada para contar inserções a quente e agrupar patches. */
export function hotInsertDayKey(nowMs: number, config: GridConfig): string {
  return localDayKey(nowMs, config.timeZone);
}
