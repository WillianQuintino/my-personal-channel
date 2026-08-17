/**
 * Testes da máquina de estados do canal.
 *
 * Cobre as três camadas de resiliência de R13 do lado do player: o watchdog de
 * carregamento (a falha que não emite erro nenhum), o tratamento de `onError`, e a
 * virada de slot quando `ENDED` não chega.
 *
 * Nenhum timer falso e nenhum DOM: o motor recebe eventos e devolve comandos, então o
 * teste é o próprio simulador do navegador.
 */

import { describe, expect, it } from 'vitest';
import { buildGrid } from '@minhatv/core';
import {
  DAY_START_SP,
  emptyHistory,
  makeConfig,
  makePool,
  uniformAffinity,
} from '@minhatv/core/fixtures';
import {
  ChannelEngine,
  DURATION_MISMATCH_TOLERANCE_SEC,
  LOAD_WATCHDOG_MS,
  MAX_CONSECUTIVE_FAILURES,
  WATCHDOG_ERROR_CODE,
} from './engine.js';
import { PlayerState } from './iframe-api.js';
import type { Command } from './engine.js';

const config = makeConfig();
const pool = makePool(200, 1, 600);
const grid = buildGrid({
  tvChannelId: 'tv-tudo',
  pool,
  affinity: uniformAffinity(pool),
  history: emptyHistory(),
  config,
  startAtMs: DAY_START_SP,
});

const NOON = DAY_START_SP + 12 * 3_600_000;

function kinds(commands: readonly Command[]): string[] {
  return commands.map((c) => c.kind);
}

function loadOf(commands: readonly Command[]) {
  const c = commands.find((x) => x.kind === 'LOAD_VIDEO');
  if (c?.kind !== 'LOAD_VIDEO') throw new Error('esperava LOAD_VIDEO');
  return c;
}

/** Motor já sintonizado e tocando, no estado em que a maioria dos testes começa. */
function playing(nowMs = NOON) {
  const engine = new ChannelEngine(grid.slots);
  engine.tune(nowMs);
  engine.onStateChange(PlayerState.PLAYING, nowMs);
  return engine;
}

describe('sintonização', () => {
  it('carrega o vídeo do slot corrente no offset do relógio', () => {
    const engine = new ChannelEngine(grid.slots);
    const slot = grid.slots[72]!; // meio-dia
    const commands = engine.tune(slot.startsAtMs + 137_000);

    const load = loadOf(commands);
    expect(load.videoId).toBe(slot.videoId);
    expect(load.startSeconds).toBe(137);
    expect(engine.snapshot().status).toBe('loading');
  });

  it('reporta fora do ar quando o relógio está fora da grade', () => {
    const engine = new ChannelEngine(grid.slots);
    const commands = engine.tune(DAY_START_SP - 60_000);

    expect(kinds(commands)).toEqual(['SHOW_OFF_AIR']);
    expect(engine.snapshot()).toMatchObject({ status: 'off_air', currentSeq: null });
  });

  it('grade vazia reporta fora do ar em vez de quebrar', () => {
    expect(kinds(new ChannelEngine([]).tune(NOON))).toEqual(['SHOW_OFF_AIR']);
  });

  it('PLAYING confirma a reprodução e zera o contador de falhas', () => {
    const engine = playing();
    expect(engine.snapshot()).toMatchObject({ status: 'playing', consecutiveFailures: 0 });
  });
});

describe('avanço de slot', () => {
  it('ENDED recalcula pelo relógio, não por seq + 1', () => {
    /*
     * A distinção importa quando o app fica em background: incrementar a sequência
     * mostraria o vídeo errado, enquanto o relógio cai no lugar certo.
     */
    const engine = playing(NOON);
    const seqAntes = engine.snapshot().currentSeq!;

    // Quarenta minutos depois — quatro slots à frente, não um.
    const commands = engine.onStateChange(PlayerState.ENDED, NOON + 40 * 60_000);

    expect(loadOf(commands).seq).toBe(seqAntes + 4);
  });

  it('ENDED no instante certo avança um slot', () => {
    const engine = playing(NOON);
    const slot = engine.snapshot().currentSlot!;
    const commands = engine.onStateChange(PlayerState.ENDED, slot.endsAtMs);
    expect(loadOf(commands).seq).toBe(slot.seq + 1);
    expect(loadOf(commands).startSeconds).toBe(0);
  });

  it('vira o slot no tick quando ENDED não chega', () => {
    // Acontece de verdade, sobretudo em WebView.
    const engine = playing(NOON);
    const slot = engine.snapshot().currentSlot!;

    const commands = engine.tick({
      nowMs: slot.endsAtMs + 5_000,
      playerCurrentSec: 600,
      playerState: PlayerState.PLAYING,
    });

    expect(loadOf(commands).seq).toBe(slot.seq + 1);
  });

  it('estados intermediários do player não geram comando', () => {
    const engine = playing();
    for (const state of [PlayerState.BUFFERING, PlayerState.PAUSED, PlayerState.CUED]) {
      expect(engine.onStateChange(state, NOON)).toEqual([]);
    }
  });
});

describe('watchdog de carregamento', () => {
  it('trata travamento sem erro como falha depois do prazo', () => {
    /*
     * Esta é a falha mais insidiosa do gênero: há vídeos que não iniciam no iframe e
     * **nunca** disparam `onError`. Sem o watchdog o canal fica em tela preta para
     * sempre, sem nada nos logs.
     */
    const engine = new ChannelEngine(grid.slots);
    const commands0 = engine.tune(NOON);
    const videoId = loadOf(commands0).videoId;

    const commands = engine.tick({
      nowMs: NOON + LOAD_WATCHDOG_MS,
      playerCurrentSec: 0,
      playerState: PlayerState.BUFFERING,
    });

    expect(kinds(commands)).toEqual(['MARK_UNPLAYABLE', 'REQUEST_REFLOW']);
    const mark = commands[0];
    expect(mark).toMatchObject({ videoId, code: WATCHDOG_ERROR_CODE });
    if (mark?.kind === 'MARK_UNPLAYABLE') expect(mark.reason).toContain('8s');
  });

  it('não dispara antes do prazo', () => {
    const engine = new ChannelEngine(grid.slots);
    engine.tune(NOON);
    const commands = engine.tick({
      nowMs: NOON + LOAD_WATCHDOG_MS - 1,
      playerCurrentSec: 0,
      playerState: PlayerState.BUFFERING,
    });
    expect(commands).toEqual([]);
  });

  it('não dispara se o vídeo começou a tocar dentro do prazo', () => {
    const engine = new ChannelEngine(grid.slots);
    engine.tune(NOON);
    engine.onStateChange(PlayerState.PLAYING, NOON + 1_000);

    const commands = engine.tick({
      nowMs: NOON + LOAD_WATCHDOG_MS + 5_000,
      playerCurrentSec: 9,
      playerState: PlayerState.PLAYING,
    });
    expect(kinds(commands)).not.toContain('MARK_UNPLAYABLE');
  });

  it('rearma para o slot seguinte depois de uma falha', () => {
    const engine = new ChannelEngine(grid.slots);
    engine.tune(NOON);
    engine.tick({ nowMs: NOON + LOAD_WATCHDOG_MS, playerCurrentSec: 0, playerState: null });

    // O motor volta a 'loading' com o relógio rearmado no instante da falha.
    expect(engine.snapshot().status).toBe('loading');
    const denovo = engine.tick({
      nowMs: NOON + 2 * LOAD_WATCHDOG_MS,
      playerCurrentSec: 0,
      playerState: null,
    });
    expect(kinds(denovo)).toContain('MARK_UNPLAYABLE');
  });
});

describe('onError', () => {
  it('marca vídeo injogável e pede re-fluxo', () => {
    const engine = playing();
    const videoId = engine.snapshot().currentSlot!.videoId;

    const commands = engine.onError(150, NOON);

    expect(kinds(commands)).toEqual(['MARK_UNPLAYABLE', 'REQUEST_REFLOW']);
    expect(commands[0]).toMatchObject({ videoId, code: 150 });
    if (commands[0]?.kind === 'MARK_UNPLAYABLE') {
      expect(commands[0].reason).toContain('embed');
    }
  });

  it('trata todos os códigos que significam "não vai tocar aqui"', () => {
    for (const code of [2, 5, 100, 101, 150]) {
      const engine = playing();
      expect(kinds(engine.onError(code, NOON))).toContain('MARK_UNPLAYABLE');
    }
  });

  it('ignora código desconhecido, sem descartar o vídeo', () => {
    const engine = playing();
    expect(engine.onError(42, NOON)).toEqual([]);
    expect(engine.snapshot().consecutiveFailures).toBe(0);
  });

  it('ignora erro quando não há slot no ar', () => {
    const engine = new ChannelEngine(grid.slots);
    expect(engine.onError(150, NOON)).toEqual([]);
  });

  it('admite o problema depois de três falhas seguidas', () => {
    const engine = playing();
    let commands: Command[] = [];
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      commands = engine.onError(150, NOON + i * 1_000);
    }

    expect(kinds(commands)).toContain('SHOW_TROUBLE');
    expect(engine.snapshot().status).toBe('trouble');
    const trouble = commands.find((c) => c.kind === 'SHOW_TROUBLE');
    expect(trouble).toMatchObject({ failures: MAX_CONSECUTIVE_FAILURES });
  });

  it('uma reprodução bem-sucedida zera o contador', () => {
    const engine = playing();
    engine.onError(150, NOON);
    engine.onError(150, NOON + 1_000);
    expect(engine.snapshot().consecutiveFailures).toBe(2);

    engine.onStateChange(PlayerState.PLAYING, NOON + 2_000);
    expect(engine.snapshot().consecutiveFailures).toBe(0);

    // O terceiro erro depois de um sucesso não deve estourar o limite.
    expect(kinds(engine.onError(150, NOON + 3_000))).not.toContain('SHOW_TROUBLE');
  });

  it('registra as falhas para diagnóstico', () => {
    const engine = playing();
    engine.onError(150, NOON);
    engine.onError(100, NOON + 1_000);

    const log = engine.snapshot().failureLog;
    expect(log).toHaveLength(2);
    expect(log.map((f) => f.code)).toEqual([150, 100]);
  });
});

describe('correção de deriva', () => {
  it('não corrige dentro da tolerância', () => {
    const engine = playing(NOON);
    const commands = engine.tick({
      nowMs: NOON + 60_000,
      playerCurrentSec: 62,
      playerState: PlayerState.PLAYING,
    });
    expect(kinds(commands)).not.toContain('SEEK');
  });

  it('corrige quando a deriva passa da tolerância', () => {
    const engine = playing(NOON);
    const commands = engine.tick({
      nowMs: NOON + 60_000,
      playerCurrentSec: 5,
      playerState: PlayerState.PLAYING,
    });

    const seek = commands.find((c) => c.kind === 'SEEK');
    expect(seek).toBeDefined();
    if (seek?.kind === 'SEEK') expect(seek.seconds).toBeCloseTo(60, 0);
  });

  it('corrige no máximo uma vez por slot', () => {
    /*
     * Sem esse freio, um vídeo cuja duração real difere da armazenada entra em laço de
     * seekTo — o que na prática trava a reprodução.
     */
    const engine = playing(NOON);
    const primeira = engine.tick({
      nowMs: NOON + 60_000,
      playerCurrentSec: 5,
      playerState: PlayerState.PLAYING,
    });
    const segunda = engine.tick({
      nowMs: NOON + 90_000,
      playerCurrentSec: 5,
      playerState: PlayerState.PLAYING,
    });

    expect(kinds(primeira)).toContain('SEEK');
    expect(kinds(segunda)).not.toContain('SEEK');
  });

  it('o freio é rearmado no slot seguinte', () => {
    const engine = playing(NOON);
    engine.tick({ nowMs: NOON + 60_000, playerCurrentSec: 5, playerState: PlayerState.PLAYING });

    const slot = engine.snapshot().currentSlot!;
    engine.onStateChange(PlayerState.ENDED, slot.endsAtMs);
    engine.onStateChange(PlayerState.PLAYING, slot.endsAtMs);

    const commands = engine.tick({
      nowMs: slot.endsAtMs + 60_000,
      playerCurrentSec: 5,
      playerState: PlayerState.PLAYING,
    });
    expect(kinds(commands)).toContain('SEEK');
  });

  it('não corrige sem posição do player', () => {
    const engine = playing(NOON);
    const commands = engine.tick({
      nowMs: NOON + 60_000,
      playerCurrentSec: null,
      playerState: PlayerState.PLAYING,
    });
    expect(kinds(commands)).not.toContain('SEEK');
  });
});

describe('divergência de duração', () => {
  it('reporta quando a duração real difere da armazenada', () => {
    const engine = playing(NOON);
    const slot = engine.snapshot().currentSlot!;

    const commands = engine.tick({
      nowMs: NOON + 10_000,
      playerCurrentSec: 10,
      playerState: PlayerState.PLAYING,
      playerDurationSec: slot.durationSec + 30,
    });

    const report = commands.find((c) => c.kind === 'REPORT_DURATION');
    expect(report).toMatchObject({
      videoId: slot.videoId,
      expectedSec: slot.durationSec,
      actualSec: slot.durationSec + 30,
    });
  });

  it('tolera pequena diferença de arredondamento', () => {
    const engine = playing(NOON);
    const slot = engine.snapshot().currentSlot!;
    const commands = engine.tick({
      nowMs: NOON + 10_000,
      playerCurrentSec: 10,
      playerState: PlayerState.PLAYING,
      playerDurationSec: slot.durationSec + DURATION_MISMATCH_TOLERANCE_SEC,
    });
    expect(kinds(commands)).not.toContain('REPORT_DURATION');
  });

  it('reporta uma vez por slot', () => {
    const engine = playing(NOON);
    const slot = engine.snapshot().currentSlot!;
    const tickArgs = {
      playerCurrentSec: 10,
      playerState: PlayerState.PLAYING,
      playerDurationSec: slot.durationSec + 30,
    };

    const a = engine.tick({ nowMs: NOON + 10_000, ...tickArgs });
    const b = engine.tick({ nowMs: NOON + 20_000, ...tickArgs });

    expect(kinds(a)).toContain('REPORT_DURATION');
    expect(kinds(b)).not.toContain('REPORT_DURATION');
  });

  it('ignora duração ausente ou zero', () => {
    const engine = playing(NOON);
    for (const playerDurationSec of [null, 0, undefined]) {
      const commands = engine.tick({
        nowMs: NOON + 10_000,
        playerCurrentSec: 10,
        playerState: PlayerState.PLAYING,
        ...(playerDurationSec === undefined ? {} : { playerDurationSec }),
      });
      expect(kinds(commands)).not.toContain('REPORT_DURATION');
    }
  });
});

describe('volta do background', () => {
  it('re-sintoniza do relógio, sem confiar no estado anterior', () => {
    const engine = playing(NOON);
    const seqAntes = engine.snapshot().currentSeq!;

    const commands = engine.onVisible(NOON + 3 * 3_600_000);

    expect(loadOf(commands).seq).toBe(seqAntes + 18); // 3h de slots de 10 min
  });
});

describe('atualização da grade', () => {
  it('não reinicia o vídeo quando o slot no ar não mudou', () => {
    /*
     * Invariante central da inserção a quente: o slot no ar é imutável. Se um patch
     * reiniciasse o vídeo de quem está assistindo, seria o pior defeito possível num
     * produto que imita TV.
     */
    const engine = playing(NOON);
    const antes = engine.snapshot().currentSlot!;

    const commands = engine.onGridUpdated(grid.slots, NOON);

    expect(commands).toEqual([]);
    expect(engine.snapshot().currentSlot?.videoId).toBe(antes.videoId);
    expect(engine.snapshot().status).toBe('playing');
  });

  it('re-sintoniza quando o slot no ar foi substituído', () => {
    const engine = playing(NOON);

    // Grade em que o vídeo do meio-dia é outro — é o que o descarte de injogável faz.
    const substituida = grid.slots.map((s) =>
      s.startsAtMs <= NOON && NOON < s.endsAtMs ? { ...s, videoId: 'substituto' } : s,
    );
    const commands = engine.onGridUpdated(substituida, NOON);

    expect(loadOf(commands).videoId).toBe('substituto');
  });

  it('re-sintoniza quando não estava tocando', () => {
    const engine = new ChannelEngine([]);
    engine.tune(NOON);
    const commands = engine.onGridUpdated(grid.slots, NOON);
    expect(kinds(commands)).toContain('LOAD_VIDEO');
  });
});

describe('ciclo completo com falhas', () => {
  it('sobrevive a erro, re-fluxo e retomada', () => {
    const engine = new ChannelEngine(grid.slots);

    // Liga a TV.
    expect(kinds(engine.tune(NOON))).toEqual(['LOAD_VIDEO']);
    // O vídeo não é embutível.
    const falha = engine.onError(150, NOON);
    expect(kinds(falha)).toEqual(['MARK_UNPLAYABLE', 'REQUEST_REFLOW']);

    // O app re-flui e entrega a grade nova.
    const nova = grid.slots.map((s) =>
      s.startsAtMs <= NOON && NOON < s.endsAtMs
        ? { ...s, videoId: 'bom', startsAtMs: NOON, endsAtMs: NOON + 600_000, durationSec: 600 }
        : s,
    );
    const retomada = engine.onGridUpdated(nova, NOON);
    expect(loadOf(retomada).videoId).toBe('bom');
    expect(loadOf(retomada).startSeconds).toBe(0);

    // Agora toca, e o contador zera.
    engine.onStateChange(PlayerState.PLAYING, NOON + 500);
    expect(engine.snapshot()).toMatchObject({ status: 'playing', consecutiveFailures: 0 });
  });
});
