/**
 * Máquina de estados do canal — junta relógio, grade e player.
 *
 * É escrita como redutor: recebe eventos e devolve **comandos**, sem tocar no DOM nem
 * em temporizadores. Essa escolha existe para poder testar as três camadas de
 * resiliência (filtro prévio, watchdog e `onError`) sem falsear timers nem simular
 * um navegador — o que na prática é a diferença entre ter e não ter cobertura aqui.
 *
 * A regra que evita acúmulo de erro, repetida em todos os caminhos: **o slot vem
 * sempre do relógio**, nunca de `seq + 1`.
 */

import {
  computeTuneIn,
  describeErrorCode,
  evaluateDrift,
  findSlotAt,
  isUnplayableError,
} from '@minhatv/core';
import type { ScheduleSlot } from '@minhatv/core';
import { PlayerState, type PlayerStateValue } from './iframe-api.js';

/**
 * Prazo para o player sair de "carregando" e chegar a `PLAYING`.
 *
 * Sem este watchdog o canal congela em tela preta **sem nenhum evento de erro**: há
 * vídeos que simplesmente não iniciam no iframe e nunca disparam `onError`. É a falha
 * mais insidiosa deste tipo de app, e a razão de o watchdog ser camada própria.
 */
export const LOAD_WATCHDOG_MS = 8_000;

/** Falhas seguidas antes de admitir o problema ao usuário. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** Diferença de duração que justifica corrigir o registro e re-fluir o dia. */
export const DURATION_MISMATCH_TOLERANCE_SEC = 2;

export type ChannelStatus = 'off' | 'loading' | 'playing' | 'off_air' | 'trouble';

export type Command =
  | {
      readonly kind: 'LOAD_VIDEO';
      readonly videoId: string;
      readonly startSeconds: number;
      readonly seq: number;
    }
  | { readonly kind: 'SEEK'; readonly seconds: number }
  | {
      readonly kind: 'MARK_UNPLAYABLE';
      readonly videoId: string;
      readonly code: number;
      readonly reason: string;
    }
  | { readonly kind: 'REQUEST_REFLOW'; readonly videoId: string }
  | {
      readonly kind: 'REPORT_DURATION';
      readonly videoId: string;
      readonly expectedSec: number;
      readonly actualSec: number;
    }
  | { readonly kind: 'SHOW_OFF_AIR' }
  | { readonly kind: 'SHOW_TROUBLE'; readonly failures: number };

export interface TickInput {
  readonly nowMs: number;
  /** `getCurrentTime()` do player, ou `null` se ainda não houver player. */
  readonly playerCurrentSec: number | null;
  readonly playerState: PlayerStateValue | null;
  /** `getDuration()` do player, quando disponível. */
  readonly playerDurationSec?: number | null;
}

export interface EngineSnapshot {
  readonly status: ChannelStatus;
  readonly currentSeq: number | null;
  readonly currentSlot: ScheduleSlot | null;
  readonly consecutiveFailures: number;
  /** Códigos de erro já vistos nesta sessão, para diagnóstico. */
  readonly failureLog: readonly { readonly videoId: string; readonly code: number }[];
}

/** Código sintético para a falha detectada pelo watchdog, que não vem do `onError`. */
export const WATCHDOG_ERROR_CODE = -1;

export class ChannelEngine {
  #slots: readonly ScheduleSlot[];
  #currentSeq: number | null = null;
  #loadStartedAtMs: number | null = null;
  #reachedPlaying = false;
  #driftCorrectedForSeq: number | null = null;
  #durationReportedForSeq: number | null = null;
  #consecutiveFailures = 0;
  #status: ChannelStatus = 'off';
  #failureLog: { videoId: string; code: number }[] = [];

  constructor(slots: readonly ScheduleSlot[] = []) {
    this.#slots = slots;
  }

  snapshot(): EngineSnapshot {
    return {
      status: this.#status,
      currentSeq: this.#currentSeq,
      currentSlot: this.#currentSeq === null ? null : (this.#slotBySeq(this.#currentSeq) ?? null),
      consecutiveFailures: this.#consecutiveFailures,
      failureLog: [...this.#failureLog],
    };
  }

  get slots(): readonly ScheduleSlot[] {
    return this.#slots;
  }

  #slotBySeq(seq: number): ScheduleSlot | undefined {
    return this.#slots.find((s) => s.seq === seq);
  }

  /**
   * Sintoniza pelo relógio. É o único caminho que escolhe um slot, e todos os outros
   * eventos convergem para cá — inclusive `ENDED` e a volta do background.
   */
  tune(nowMs: number): Command[] {
    const tuneIn = computeTuneIn(this.#slots, nowMs);
    if (!tuneIn) {
      this.#status = 'off_air';
      this.#currentSeq = null;
      this.#loadStartedAtMs = null;
      this.#reachedPlaying = false;
      return [{ kind: 'SHOW_OFF_AIR' }];
    }

    this.#currentSeq = tuneIn.slot.seq;
    this.#loadStartedAtMs = nowMs;
    this.#reachedPlaying = false;
    this.#driftCorrectedForSeq = null;
    this.#durationReportedForSeq = null;
    this.#status = 'loading';

    return [
      {
        kind: 'LOAD_VIDEO',
        videoId: tuneIn.slot.videoId,
        startSeconds: tuneIn.startSeconds,
        seq: tuneIn.slot.seq,
      },
    ];
  }

  onStateChange(state: PlayerStateValue, nowMs: number): Command[] {
    if (state === PlayerState.PLAYING) {
      this.#reachedPlaying = true;
      this.#consecutiveFailures = 0;
      this.#status = 'playing';
      return [];
    }

    if (state === PlayerState.ENDED) {
      /*
       * Recalcular pelo relógio em vez de avançar `seq + 1`. Se o app ficou em
       * background 40 minutos, incrementar a sequência mostraria o vídeo errado;
       * o relógio cai no lugar certo.
       */
      return this.tune(nowMs);
    }

    return [];
  }

  onError(code: number, nowMs: number): Command[] {
    const slot = this.#currentSeq === null ? undefined : this.#slotBySeq(this.#currentSeq);
    if (!slot) return [];
    if (!isUnplayableError(code)) return [];
    return this.#handleFailure(slot, code, describeErrorCode(code), nowMs);
  }

  /**
   * Pulso periódico. Cobre três coisas que os eventos do player não garantem:
   * o watchdog de carregamento, a correção de deriva e a virada de slot quando
   * `ENDED` não chega (acontece, sobretudo em WebView).
   */
  tick(input: TickInput): Command[] {
    const { nowMs, playerCurrentSec, playerDurationSec } = input;

    // Watchdog: travou carregando e nenhum erro foi emitido.
    if (
      this.#status === 'loading' &&
      !this.#reachedPlaying &&
      this.#loadStartedAtMs !== null &&
      nowMs - this.#loadStartedAtMs >= LOAD_WATCHDOG_MS
    ) {
      const slot = this.#currentSeq === null ? undefined : this.#slotBySeq(this.#currentSeq);
      if (slot) {
        return this.#handleFailure(
          slot,
          WATCHDOG_ERROR_CODE,
          `não iniciou em ${LOAD_WATCHDOG_MS / 1000}s`,
          nowMs,
        );
      }
    }

    if (this.#status !== 'playing' || this.#currentSeq === null) return [];

    const slot = this.#slotBySeq(this.#currentSeq);
    if (!slot) return this.tune(nowMs);

    // O relógio saiu do slot corrente e `ENDED` não chegou: virar na força.
    if (nowMs >= slot.endsAtMs || nowMs < slot.startsAtMs) {
      return this.tune(nowMs);
    }

    const commands: Command[] = [];

    // Duração real diferente da armazenada desalinha todo o resto do dia.
    if (
      playerDurationSec !== null &&
      playerDurationSec !== undefined &&
      playerDurationSec > 0 &&
      this.#durationReportedForSeq !== slot.seq &&
      Math.abs(playerDurationSec - slot.durationSec) > DURATION_MISMATCH_TOLERANCE_SEC
    ) {
      this.#durationReportedForSeq = slot.seq;
      commands.push({
        kind: 'REPORT_DURATION',
        videoId: slot.videoId,
        expectedSec: slot.durationSec,
        actualSec: playerDurationSec,
      });
    }

    if (playerCurrentSec !== null) {
      const drift = evaluateDrift({
        slot,
        nowMs,
        playerCurrentSec,
        alreadyCorrected: this.#driftCorrectedForSeq === slot.seq,
      });
      if (drift.shouldSeek) {
        this.#driftCorrectedForSeq = slot.seq;
        commands.push({ kind: 'SEEK', seconds: drift.targetSec });
      }
    }

    return commands;
  }

  /** O app voltou do background, ou a aba ficou visível. Re-sintoniza do zero. */
  onVisible(nowMs: number): Command[] {
    return this.tune(nowMs);
  }

  /** Nova grade depois de um re-fluxo (descarte de injogável ou inserção a quente). */
  onGridUpdated(slots: readonly ScheduleSlot[], nowMs: number): Command[] {
    /*
     * O vídeo no ar é lido da grade **antiga**, antes da troca. Comparar depois de
     * atribuir compara a grade nova consigo mesma: qualquer substituição passaria
     * batida e o player continuaria no vídeo que acabou de ser descartado.
     */
    const playingVideoId =
      this.#status === 'playing' && this.#currentSeq !== null
        ? this.#slotBySeq(this.#currentSeq)?.videoId
        : undefined;

    this.#slots = slots;

    // Se o slot no ar não mudou, não há por que reiniciar o vídeo de quem está assistindo.
    if (playingVideoId !== undefined) {
      const atClock = findSlotAt(slots, nowMs);
      if (atClock && atClock.videoId === playingVideoId) {
        this.#currentSeq = atClock.seq;
        return [];
      }
    }
    return this.tune(nowMs);
  }

  #handleFailure(slot: ScheduleSlot, code: number, reason: string, nowMs: number): Command[] {
    this.#consecutiveFailures++;
    this.#failureLog.push({ videoId: slot.videoId, code });

    const commands: Command[] = [
      { kind: 'MARK_UNPLAYABLE', videoId: slot.videoId, code, reason },
      { kind: 'REQUEST_REFLOW', videoId: slot.videoId },
    ];

    /*
     * Depois de três falhas seguidas, insistir em silêncio é pior que admitir: o pool
     * pode estar degenerado, ou a rede caiu. O cartão de aviso aparece **fora** do
     * retângulo do player (R5).
     */
    if (this.#consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.#status = 'trouble';
      commands.push({ kind: 'SHOW_TROUBLE', failures: this.#consecutiveFailures });
    } else {
      this.#status = 'loading';
      this.#loadStartedAtMs = nowMs;
    }

    return commands;
  }
}
