/**
 * Sintonização e correção de deriva — a ponte entre o relógio e o player.
 *
 * A regra que evita acúmulo de erro: **sempre derivar o slot do relógio**, nunca
 * de `seq + 1`. Se o app ficou em background 40 minutos, incrementar a sequência
 * mostraria o vídeo errado; recalcular pelo relógio cai no lugar certo.
 */

import { MS_PER_SEC } from './time.js';
import type { ScheduleSlot } from './types.js';

export interface TuneIn {
  readonly slot: ScheduleSlot;
  /** Segundos a passar em `startSeconds` do IFrame API. */
  readonly startSeconds: number;
}

/** Busca binária do slot que contém `nowMs`. Slots são contíguos e ordenados. */
export function findSlotAt(
  slots: readonly ScheduleSlot[],
  nowMs: number,
): ScheduleSlot | undefined {
  let lo = 0;
  let hi = slots.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const slot = slots[mid];
    if (!slot) break;
    if (nowMs < slot.startsAtMs) hi = mid - 1;
    else if (nowMs >= slot.endsAtMs) lo = mid + 1;
    else return slot;
  }
  return undefined;
}

export function findSlotBySeq(
  slots: readonly ScheduleSlot[],
  seq: number,
): ScheduleSlot | undefined {
  return slots.find((s) => s.seq === seq);
}

/**
 * Onde entrar no ar. O offset é truncado para baixo e limitado a
 * `durationSec - 1`: pedir `startSeconds` igual à duração faz o player disparar
 * `ENDED` imediatamente e o canal entra em laço de troca.
 */
export function computeTuneIn(slots: readonly ScheduleSlot[], nowMs: number): TuneIn | null {
  const slot = findSlotAt(slots, nowMs);
  if (!slot) return null;
  const rawSec = Math.floor((nowMs - slot.startsAtMs) / MS_PER_SEC);
  const startSeconds = Math.max(0, Math.min(rawSec, Math.max(0, slot.durationSec - 1)));
  return { slot, startSeconds };
}

/** Próximo slot depois de `slot`, se a grade cobrir. */
export function nextSlot(
  slots: readonly ScheduleSlot[],
  slot: ScheduleSlot,
): ScheduleSlot | undefined {
  return findSlotBySeq(slots, slot.seq + 1);
}

export interface DriftDecision {
  readonly shouldSeek: boolean;
  readonly expectedSec: number;
  readonly driftSec: number;
  readonly targetSec: number;
}

/**
 * Decide se vale corrigir a posição do player.
 *
 * `alreadyCorrected` existe para limitar a uma correção por slot: sem esse freio,
 * um vídeo cuja duração real difere da armazenada entra em laço de `seekTo`,
 * o que na prática trava a reprodução.
 */
export function evaluateDrift(params: {
  readonly slot: ScheduleSlot;
  readonly nowMs: number;
  readonly playerCurrentSec: number;
  readonly toleranceSec?: number;
  readonly alreadyCorrected: boolean;
}): DriftDecision {
  const { slot, nowMs, playerCurrentSec, alreadyCorrected } = params;
  const toleranceSec = params.toleranceSec ?? 5;

  const expectedSec = (nowMs - slot.startsAtMs) / MS_PER_SEC;
  const driftSec = playerCurrentSec - expectedSec;
  const targetSec = Math.max(0, Math.min(expectedSec, Math.max(0, slot.durationSec - 1)));

  return {
    shouldSeek: !alreadyCorrected && Math.abs(driftSec) > toleranceSec,
    expectedSec,
    driftSec,
    targetSec,
  };
}

/** Códigos de `onError` do IFrame API que significam "este vídeo não vai tocar aqui". */
export const UNPLAYABLE_ERROR_CODES = [2, 5, 100, 101, 150] as const;
export type UnplayableErrorCode = (typeof UNPLAYABLE_ERROR_CODES)[number];

export function isUnplayableError(code: number): code is UnplayableErrorCode {
  return (UNPLAYABLE_ERROR_CODES as readonly number[]).includes(code);
}

export function describeErrorCode(code: number): string {
  switch (code) {
    case 2:
      return 'id de vídeo inválido';
    case 5:
      return 'erro do player HTML5';
    case 100:
      return 'vídeo removido ou privado';
    case 101:
    case 150:
      return 'embed desabilitado pelo dono do vídeo';
    default:
      return `erro desconhecido (${code})`;
  }
}
