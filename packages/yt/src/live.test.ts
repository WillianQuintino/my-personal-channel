import { describe, expect, it } from 'vitest';
import {
  channelsDueForCheck,
  detectLiveState,
  LIVE_PROBE_DEPTH,
  resolveLiveChannel,
} from './live.js';
import { NOW, videoRecord } from './fixtures.js';
import { estimatePoolRefreshCost, QUOTA_COST } from './quota.js';
import type { LiveState } from './live.js';

const MIN = 60_000;

function state(over: Partial<LiveState> = {}): LiveState {
  return {
    ytChannelId: 'UC1',
    status: 'offline',
    videoId: null,
    scheduledStartMs: null,
    checkedAtMs: NOW,
    nextCheckAtMs: NOW + 3_600_000,
    ...over,
  };
}

describe('detectLiveState', () => {
  it('detecta transmissão no ar', () => {
    const videos = [
      videoRecord({ id: 'live1', ytChannelId: 'UC1', liveState: 'live', durationSec: null }),
      videoRecord({ id: 'vod1', ytChannelId: 'UC1' }),
    ];
    const s = detectLiveState('UC1', videos, { nowMs: NOW });

    expect(s.status).toBe('live');
    expect(s.videoId).toBe('live1');
    // Enquanto está no ar, checa de novo em 5 min para pegar o encerramento.
    expect(s.nextCheckAtMs).toBe(NOW + 5 * MIN);
  });

  it('ignora transmissão que já terminou', () => {
    const videos = [
      videoRecord({
        id: 'liveFim',
        ytChannelId: 'UC1',
        liveState: 'live',
        liveActualEndMs: NOW - MIN,
      }),
    ];
    expect(detectLiveState('UC1', videos, { nowMs: NOW }).status).toBe('offline');
  });

  it('detecta transmissão agendada e escolhe a mais próxima', () => {
    const videos = [
      videoRecord({
        id: 'tarde',
        ytChannelId: 'UC1',
        liveState: 'upcoming',
        liveScheduledStartMs: NOW + 5 * 3_600_000,
      }),
      videoRecord({
        id: 'cedo',
        ytChannelId: 'UC1',
        liveState: 'upcoming',
        liveScheduledStartMs: NOW + 30 * MIN,
      }),
    ];
    const s = detectLiveState('UC1', videos, { nowMs: NOW });

    expect(s.status).toBe('upcoming');
    expect(s.videoId).toBe('cedo');
    // Volta a checar 2 min antes da hora marcada — polling dirigido.
    expect(s.nextCheckAtMs).toBe(NOW + 28 * MIN);
  });

  it('não antecipa poll para live marcada para semana que vem', () => {
    const videos = [
      videoRecord({
        id: 'longe',
        ytChannelId: 'UC1',
        liveState: 'upcoming',
        liveScheduledStartMs: NOW + 7 * 86_400_000,
      }),
    ];
    const s = detectLiveState('UC1', videos, { nowMs: NOW });
    // Limitado pelo intervalo ocioso: nada justifica poll de hora em hora agora.
    expect(s.nextCheckAtMs).toBe(NOW + 3_600_000);
  });

  it('nunca agenda checagem no passado', () => {
    const videos = [
      videoRecord({
        id: 'atrasada',
        ytChannelId: 'UC1',
        liveState: 'upcoming',
        liveScheduledStartMs: NOW - 3_600_000, // já deveria ter começado
      }),
    ];
    const s = detectLiveState('UC1', videos, { nowMs: NOW });
    expect(s.nextCheckAtMs).toBeGreaterThan(NOW);
  });

  it('reporta offline quando não há nada ao vivo nem agendado', () => {
    const s = detectLiveState('UC1', [videoRecord({ ytChannelId: 'UC1' })], { nowMs: NOW });
    expect(s).toMatchObject({ status: 'offline', videoId: null });
    expect(s.nextCheckAtMs).toBe(NOW + 3_600_000);
  });

  it('a transmissão no ar tem precedência sobre a agendada', () => {
    const videos = [
      videoRecord({
        id: 'agendada',
        ytChannelId: 'UC1',
        liveState: 'upcoming',
        liveScheduledStartMs: NOW + 10 * MIN,
      }),
      videoRecord({ id: 'noar', ytChannelId: 'UC1', liveState: 'live' }),
    ];
    // É o que pode ir para a tela agora.
    expect(detectLiveState('UC1', videos, { nowMs: NOW }).videoId).toBe('noar');
  });

  it('ignora vídeos de outros canais', () => {
    const videos = [videoRecord({ id: 'live-outro', ytChannelId: 'UC2', liveState: 'live' })];
    expect(detectLiveState('UC1', videos, { nowMs: NOW }).status).toBe('offline');
  });

  it('respeita intervalos customizados', () => {
    const videos = [videoRecord({ ytChannelId: 'UC1', liveState: 'live' })];
    const s = detectLiveState('UC1', videos, { nowMs: NOW, livePollSec: 60 });
    expect(s.nextCheckAtMs).toBe(NOW + MIN);
  });

  it('lista vazia é tratada como offline', () => {
    expect(detectLiveState('UC1', [], { nowMs: NOW }).status).toBe('offline');
  });
});

describe('channelsDueForCheck', () => {
  it('devolve só os canais cujo prazo venceu', () => {
    const states = [
      state({ ytChannelId: 'UC1', nextCheckAtMs: NOW - MIN }),
      state({ ytChannelId: 'UC2', nextCheckAtMs: NOW + MIN }),
      state({ ytChannelId: 'UC3', nextCheckAtMs: NOW }),
    ];
    expect(channelsDueForCheck(states, NOW)).toEqual(['UC1', 'UC3']);
  });

  it('devolve vazio quando nada venceu', () => {
    expect(channelsDueForCheck([state({ nextCheckAtMs: NOW + MIN })], NOW)).toEqual([]);
  });
});

describe('resolveLiveChannel', () => {
  it('escolhe a transmissão no ar', () => {
    const states = [
      state({ ytChannelId: 'UC1', status: 'offline' }),
      state({ ytChannelId: 'UC2', status: 'live', videoId: 'live2' }),
    ];
    expect(resolveLiveChannel(states, NOW)).toEqual({
      kind: 'live',
      videoId: 'live2',
      ytChannelId: 'UC2',
    });
  });

  it('desempata transmissões simultâneas de forma determinística', () => {
    const states = [
      state({ ytChannelId: 'UCz', status: 'live', videoId: 'lz' }),
      state({ ytChannelId: 'UCa', status: 'live', videoId: 'la' }),
    ];
    expect(resolveLiveChannel(states, NOW)).toMatchObject({ ytChannelId: 'UCa' });
    // A ordem de entrada não muda o resultado.
    expect(resolveLiveChannel([...states].reverse(), NOW)).toMatchObject({ ytChannelId: 'UCa' });
  });

  it('cai para a grade VOD quando ninguém está transmitindo', () => {
    /*
     * O fallback não é detalhe de implementação: sem ele, um canal de lives fica no ar
     * sem conteúdo quando ninguém transmite — e "sem sinal" é exatamente a experiência
     * que este produto existe para evitar.
     */
    const states = [state({ status: 'offline' }), state({ status: 'upcoming', videoId: 'x' })];
    expect(resolveLiveChannel(states, NOW)).toEqual({ kind: 'vod_fallback' });
  });

  it('cai para VOD com lista vazia', () => {
    expect(resolveLiveChannel([], NOW)).toEqual({ kind: 'vod_fallback' });
  });

  it('ignora estado "live" sem videoId', () => {
    expect(resolveLiveChannel([state({ status: 'live', videoId: null })], NOW)).toEqual({
      kind: 'vod_fallback',
    });
  });
});

describe('custo da detecção', () => {
  it('o caminho barato é ordens de grandeza mais baixo que search.list', () => {
    /*
     * Este teste existe para travar a decisão de projeto: `search.list` com
     * `eventType=live` resolveria a detecção numa chamada, mas custa 100 unidades
     * **por canal**. Checar 50 canais uma única vez estouraria metade da cota diária.
     */
    const canais = 50;
    const porBusca = canais * QUOTA_COST['search.list'];
    const caminhoBarato = estimatePoolRefreshCost(canais, LIVE_PROBE_DEPTH);

    expect(porBusca).toBe(5_000);
    expect(caminhoBarato).toBe(60);
    expect(caminhoBarato * 80).toBeLessThan(porBusca);
  });

  it('a profundidade de sondagem é suficiente sem ser custosa', () => {
    // Uma live é sempre um dos uploads mais recentes; 10 é folgado.
    expect(LIVE_PROBE_DEPTH).toBe(10);
    expect(LIVE_PROBE_DEPTH).toBeLessThanOrEqual(50); // uma página só
  });
});
