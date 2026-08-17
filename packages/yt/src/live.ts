/**
 * Detecção de transmissões ao vivo, pelo caminho barato.
 *
 * `search.list` com `eventType=live` resolveria isso em uma chamada, mas custa 100
 * unidades **por canal** — checar 50 canais uma vez já estouraria metade da cota
 * diária. O caminho usado aqui custa ~2 unidades por lote de 50 canais:
 *
 *   uploads playlist (1u / 50 itens) → videos.list nos mais recentes (1u / 50 ids)
 *
 * Funciona porque uma transmissão ao vivo aparece na playlist de uploads do canal, e
 * `snippet.liveBroadcastContent` já diz se está no ar.
 */

import type { VideoRecord } from './types.js';

export type LiveStatus = 'live' | 'upcoming' | 'offline';

export interface LiveState {
  readonly ytChannelId: string;
  readonly status: LiveStatus;
  /** Vídeo ao vivo ou agendado, quando houver. */
  readonly videoId: string | null;
  readonly scheduledStartMs: number | null;
  readonly checkedAtMs: number;
  /** Quando vale a pena checar de novo. Polling dirigido, não varredura cega. */
  readonly nextCheckAtMs: number;
}

export interface LiveDetectionOptions {
  readonly nowMs: number;
  /** Intervalo entre checagens de um canal sem live à vista. Padrão 1h. */
  readonly idlePollSec?: number;
  /** Intervalo entre checagens enquanto uma live está no ar. Padrão 5 min. */
  readonly livePollSec?: number;
  /** Antecedência com que voltamos a checar antes do início agendado. Padrão 2 min. */
  readonly preRollSec?: number;
}

/**
 * Deduz o estado de live de um canal a partir dos vídeos recentes dele.
 *
 * Quando há transmissão no ar e também uma agendada, a que está no ar ganha: é o que
 * pode ir para a tela agora.
 */
export function detectLiveState(
  ytChannelId: string,
  recentVideos: readonly VideoRecord[],
  opts: LiveDetectionOptions,
): LiveState {
  const { nowMs } = opts;
  const idlePollSec = opts.idlePollSec ?? 3_600;
  const livePollSec = opts.livePollSec ?? 300;
  const preRollSec = opts.preRollSec ?? 120;

  const mine = recentVideos.filter((v) => v.ytChannelId === ytChannelId);

  const live = mine.find((v) => v.liveState === 'live' && v.liveActualEndMs === null);
  if (live) {
    return {
      ytChannelId,
      status: 'live',
      videoId: live.id,
      scheduledStartMs: live.liveScheduledStartMs,
      checkedAtMs: nowMs,
      nextCheckAtMs: nowMs + livePollSec * 1_000,
    };
  }

  // Entre as agendadas, a mais próxima é a que define o próximo poll.
  const upcoming = mine
    .filter((v) => v.liveState === 'upcoming' && v.liveScheduledStartMs !== null)
    .sort((a, b) => (a.liveScheduledStartMs ?? 0) - (b.liveScheduledStartMs ?? 0))[0];

  if (upcoming?.liveScheduledStartMs !== null && upcoming?.liveScheduledStartMs !== undefined) {
    const startMs = upcoming.liveScheduledStartMs;
    // Checar um pouco antes da hora marcada, mas nunca depois do intervalo ocioso:
    // uma live marcada para semana que vem não justifica poll de hora em hora agora.
    const wakeAtMs = Math.min(
      Math.max(nowMs + 60_000, startMs - preRollSec * 1_000),
      nowMs + idlePollSec * 1_000,
    );
    return {
      ytChannelId,
      status: 'upcoming',
      videoId: upcoming.id,
      scheduledStartMs: startMs,
      checkedAtMs: nowMs,
      nextCheckAtMs: wakeAtMs,
    };
  }

  return {
    ytChannelId,
    status: 'offline',
    videoId: null,
    scheduledStartMs: null,
    checkedAtMs: nowMs,
    nextCheckAtMs: nowMs + idlePollSec * 1_000,
  };
}

/** Canais cujo `nextCheckAtMs` já venceu. É a fila do worker de lives. */
export function channelsDueForCheck(
  states: readonly LiveState[],
  nowMs: number,
): readonly string[] {
  return states.filter((s) => s.nextCheckAtMs <= nowMs).map((s) => s.ytChannelId);
}

/**
 * Resolve o que um canal de TV em modo LIVE ou BOTH deve exibir agora.
 *
 * O fallback para a grade VOD não é detalhe de implementação: sem ele, um canal de
 * lives fica no ar sem conteúdo quando ninguém está transmitindo — e "sem sinal" é
 * exatamente a experiência que este produto existe para evitar.
 */
export type LiveResolution =
  | { readonly kind: 'live'; readonly videoId: string; readonly ytChannelId: string }
  | { readonly kind: 'vod_fallback' };

export function resolveLiveChannel(states: readonly LiveState[], nowMs: number): LiveResolution {
  const onAir = states
    .filter((s) => s.status === 'live' && s.videoId !== null)
    // Desempate determinístico entre transmissões simultâneas.
    .sort((a, b) => (a.ytChannelId < b.ytChannelId ? -1 : a.ytChannelId > b.ytChannelId ? 1 : 0));

  const first = onAir[0];
  if (first?.videoId) {
    return { kind: 'live', videoId: first.videoId, ytChannelId: first.ytChannelId };
  }
  void nowMs;
  return { kind: 'vod_fallback' };
}

/**
 * Quantos vídeos recentes por canal basta inspecionar para achar uma live.
 *
 * Uma transmissão ao vivo é sempre um dos uploads mais recentes do canal, então 10 é
 * folgado. Aumentar isto multiplica o custo em `videos.list` sem ganho de detecção.
 */
export const LIVE_PROBE_DEPTH = 10;
