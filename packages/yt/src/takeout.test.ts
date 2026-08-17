/**
 * Testes do import do Takeout e do ranking combinado (R1).
 *
 * A API não expõe histórico de exibição desde 2016, então o Takeout é a única via
 * oficial para o ranking retroativo de "canais que mais assisto".
 */

import { describe, expect, it } from 'vitest';
import {
  channelIdFromUrl,
  computeAffinity,
  decayInternalScore,
  DEFAULT_AFFINITY_WEIGHTS,
  parseWatchHistory,
  parseWatchHistoryJson,
  videoIdFromUrl,
} from './takeout.js';
import type { AffinityInput, TakeoutEntry } from './takeout.js';

const NOW = Date.UTC(2026, 7, 17, 15, 0, 0);
const DAY = 86_400_000;

function entry(over: Partial<TakeoutEntry> = {}): TakeoutEntry {
  return {
    header: 'YouTube',
    title: 'Assistiu a Vídeo X',
    titleUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    time: '2026-08-16T12:00:00.000Z',
    subtitles: [
      { name: 'Canal Um', url: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaa' },
    ],
    ...over,
  };
}

describe('extração de ids de URL', () => {
  it('lê o id do canal', () => {
    expect(channelIdFromUrl('https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw')).toBe(
      'UCuAXFkgsw1L7xaCfnd5JJOw',
    );
  });

  it('devolve null para URL de @handle, que não traz o id', () => {
    expect(channelIdFromUrl('https://www.youtube.com/@algum-canal')).toBeNull();
    expect(channelIdFromUrl(undefined)).toBeNull();
  });

  it('lê o id do vídeo', () => {
    expect(videoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(videoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42')).toBe('dQw4w9WgXcQ');
  });

  it('devolve null para URL sem parâmetro v', () => {
    expect(videoIdFromUrl('https://www.youtube.com/watch')).toBeNull();
    expect(videoIdFromUrl('https://www.youtube.com/post/abc')).toBeNull();
  });
});

describe('parseWatchHistory', () => {
  it('agrega exibições por canal, do mais assistido para o menos', () => {
    const canalA = 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaa';
    const canalB = 'https://www.youtube.com/channel/UCbbbbbbbbbbbbbbbbbbbbb';
    const entries = [
      entry({ subtitles: [{ name: 'A', url: canalA }] }),
      entry({ subtitles: [{ name: 'A', url: canalA }] }),
      entry({ subtitles: [{ name: 'A', url: canalA }] }),
      entry({ subtitles: [{ name: 'B', url: canalB }] }),
    ];

    const { counts, parsedEntries, totalEntries } = parseWatchHistory(entries);

    expect(totalEntries).toBe(4);
    expect(parsedEntries).toBe(4);
    expect(counts).toHaveLength(2);
    expect(counts[0]).toMatchObject({ channelTitle: 'A', count: 3 });
    expect(counts[1]).toMatchObject({ channelTitle: 'B', count: 1 });
  });

  it('registra a exibição mais recente por canal', () => {
    const entries = [
      entry({ time: '2026-08-10T12:00:00Z' }),
      entry({ time: '2026-08-16T12:00:00Z' }),
      entry({ time: '2026-08-01T12:00:00Z' }),
    ];
    expect(parseWatchHistory(entries).counts[0]?.lastWatchedMs).toBe(
      Date.UTC(2026, 7, 16, 12, 0, 0),
    );
  });

  it('descarta entradas que não são do YouTube e conta o motivo', () => {
    const entries = [entry(), entry({ header: 'YouTube Music' }), entry({ header: 'Pesquisa' })];
    const { counts, skipped } = parseWatchHistory(entries);

    expect(counts).toHaveLength(1);
    expect(skipped['nao_e_youtube']).toBe(2);
  });

  it('descarta entradas de busca, que não têm URL de vídeo', () => {
    const entries = [
      entry(),
      entry({ titleUrl: 'https://www.youtube.com/results?search_query=minecraft' }),
    ];
    const { skipped } = parseWatchHistory(entries);
    expect(skipped['sem_id_de_video']).toBe(1);
  });

  it('descarta vídeo removido, cujo canal o Takeout omite', () => {
    // É o que explica o total importado ser menor que o número de linhas do arquivo.
    const semCanal: TakeoutEntry = { ...entry() };
    delete (semCanal as { subtitles?: unknown }).subtitles;
    const entries = [entry(), semCanal];
    const { counts, skipped } = parseWatchHistory(entries);

    expect(counts).toHaveLength(1);
    expect(skipped['sem_id_de_canal']).toBe(1);
  });

  it('descarta entrada sem data válida', () => {
    const semData: TakeoutEntry = { ...entry() };
    delete (semData as { time?: unknown }).time;
    const entries = [semData, entry({ time: 'não é data' })];
    expect(parseWatchHistory(entries).skipped['sem_data']).toBe(2);
  });

  it('aplica a janela temporal', () => {
    const entries = [
      entry({ time: '2026-08-16T12:00:00Z' }),
      entry({ time: '2023-01-01T12:00:00Z' }),
    ];
    const { counts, skipped } = parseWatchHistory(entries, { sinceMs: NOW - 90 * DAY });

    expect(counts[0]?.count).toBe(1);
    expect(skipped['fora_da_janela']).toBe(1);
  });

  it('a ordenação é determinística em caso de empate', () => {
    const mk = (id: string) =>
      entry({ subtitles: [{ name: id, url: `https://www.youtube.com/channel/${id}` }] });
    const ids = ['UCzzzzzzzzzzzzzzzzzzzzz', 'UCaaaaaaaaaaaaaaaaaaaaa'];
    const a = parseWatchHistory(ids.map(mk)).counts.map((c) => c.ytChannelId);
    const b = parseWatchHistory([...ids].reverse().map(mk)).counts.map((c) => c.ytChannelId);

    expect(a).toEqual(b);
    expect(a[0]).toBe('UCaaaaaaaaaaaaaaaaaaaaa');
  });

  it('lista vazia devolve resumo vazio', () => {
    expect(parseWatchHistory([])).toEqual({
      counts: [],
      totalEntries: 0,
      parsedEntries: 0,
      skipped: {},
    });
  });

  it('tolera campo header ausente, tratando como YouTube', () => {
    // O formato do Takeout muda sem aviso; um campo faltando não deve invalidar tudo.
    const semHeader: TakeoutEntry = { ...entry() };
    delete (semHeader as { header?: unknown }).header;
    expect(parseWatchHistory([semHeader]).parsedEntries).toBe(1);
  });
});

describe('parseWatchHistoryJson', () => {
  it('lê o conteúdo do arquivo', () => {
    const json = JSON.stringify([entry(), entry()]);
    expect(parseWatchHistoryJson(json).parsedEntries).toBe(2);
  });

  it('recusa JSON que não é um array', () => {
    expect(() => parseWatchHistoryJson('{"a":1}')).toThrow(/array/);
  });

  it('propaga erro de JSON malformado', () => {
    expect(() => parseWatchHistoryJson('{')).toThrow();
  });
});

describe('computeAffinity', () => {
  function input(over: Partial<AffinityInput> & Pick<AffinityInput, 'ytChannelId'>): AffinityInput {
    return {
      takeoutCount: 0,
      isSubscribed: false,
      isFavorite: false,
      internalScore: 0,
      ...over,
    };
  }

  it('devolve scores em [0, 1]', () => {
    const affinity = computeAffinity([
      input({
        ytChannelId: 'UC1',
        takeoutCount: 500,
        isSubscribed: true,
        isFavorite: true,
        internalScore: 900,
      }),
      input({ ytChannelId: 'UC2' }),
    ]);
    for (const v of affinity.values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('o canal mais assistido e favorito lidera', () => {
    const affinity = computeAffinity([
      input({
        ytChannelId: 'muito',
        takeoutCount: 100,
        isSubscribed: true,
        isFavorite: true,
        internalScore: 500,
      }),
      input({ ytChannelId: 'pouco', takeoutCount: 1, isSubscribed: true }),
    ]);
    expect(affinity.get('muito')!).toBeGreaterThan(affinity.get('pouco')!);
  });

  it('normaliza pelo máximo do conjunto, não por um teto fixo', () => {
    /*
     * Quem assiste 20 vídeos por dia e quem assiste 2 merecem a mesma faixa dinâmica.
     * Sem normalização relativa, um usuário leve teria todos os canais com score perto
     * de zero e o portão de inserção a quente nunca abriria para ninguém.
     */
    const pesado = computeAffinity([
      input({ ytChannelId: 'top', takeoutCount: 2_000 }),
      input({ ytChannelId: 'baixo', takeoutCount: 10 }),
    ]);
    const leve = computeAffinity([
      input({ ytChannelId: 'top', takeoutCount: 20 }),
      input({ ytChannelId: 'baixo', takeoutCount: 1 }),
    ]);
    // O canal do topo recebe o mesmo score nos dois perfis.
    expect(leve.get('top')).toBeCloseTo(pesado.get('top')!, 5);
  });

  it('favorito sozinho já dá score relevante', () => {
    const affinity = computeAffinity([
      input({ ytChannelId: 'fav', isFavorite: true, isSubscribed: true }),
      input({ ytChannelId: 'outro', isSubscribed: true }),
    ]);
    expect(affinity.get('fav')!).toBeGreaterThan(affinity.get('outro')!);
  });

  it('lida com conjunto sem nenhum sinal, sem dividir por zero', () => {
    const affinity = computeAffinity([input({ ytChannelId: 'UC1' })]);
    expect(affinity.get('UC1')).toBe(0);
  });

  it('respeita pesos customizados', () => {
    const inputs = [
      input({ ytChannelId: 'so-takeout', takeoutCount: 100 }),
      input({ ytChannelId: 'so-favorito', isFavorite: true }),
    ];
    const priorizaTakeout = computeAffinity(inputs, {
      takeout: 1,
      subscribed: 0,
      favorite: 0,
      internal: 0,
    });
    expect(priorizaTakeout.get('so-takeout')).toBe(1);
    expect(priorizaTakeout.get('so-favorito')).toBe(0);
  });

  it('pesos somando zero não geram NaN', () => {
    const affinity = computeAffinity([input({ ytChannelId: 'UC1', takeoutCount: 5 })], {
      takeout: 0,
      subscribed: 0,
      favorite: 0,
      internal: 0,
    });
    expect(Number.isFinite(affinity.get('UC1')!)).toBe(true);
  });

  it('os pesos padrão somam 1', () => {
    const w = DEFAULT_AFFINITY_WEIGHTS;
    expect(w.takeout + w.subscribed + w.favorite + w.internal).toBeCloseTo(1, 10);
  });

  it('conjunto vazio devolve mapa vazio', () => {
    expect(computeAffinity([]).size).toBe(0);
  });
});

describe('decayInternalScore', () => {
  it('pontua por minutos assistidos, não por aberturas', () => {
    // Abandonar em 5 segundos não é sinal de gosto.
    const longo = decayInternalScore([{ atMs: NOW, watchedSec: 600 }], NOW);
    const curto = decayInternalScore([{ atMs: NOW, watchedSec: 5 }], NOW);
    expect(longo).toBeCloseTo(10, 6);
    expect(curto).toBeLessThan(0.1);
  });

  it('cai à metade a cada meia-vida', () => {
    const agora = decayInternalScore([{ atMs: NOW, watchedSec: 600 }], NOW, 30);
    const umMes = decayInternalScore([{ atMs: NOW - 30 * DAY, watchedSec: 600 }], NOW, 30);
    expect(umMes).toBeCloseTo(agora / 2, 6);
  });

  it('soma vários eventos', () => {
    const score = decayInternalScore(
      [
        { atMs: NOW, watchedSec: 300 },
        { atMs: NOW, watchedSec: 300 },
      ],
      NOW,
    );
    expect(score).toBeCloseTo(10, 6);
  });

  it('sem eventos, score zero', () => {
    expect(decayInternalScore([], NOW)).toBe(0);
  });

  it('evento no futuro não é amplificado', () => {
    const futuro = decayInternalScore([{ atMs: NOW + DAY, watchedSec: 600 }], NOW);
    expect(futuro).toBeCloseTo(10, 6);
  });

  it('o ranking acompanha a mudança de gosto sem reimport', () => {
    /*
     * Canal que você assistia muito há um ano perde peso sozinho para o canal que você
     * assiste agora — é isso que dispensa reimportar o Takeout periodicamente.
     */
    const antigo = decayInternalScore([{ atMs: NOW - 365 * DAY, watchedSec: 36_000 }], NOW, 30);
    const recente = decayInternalScore([{ atMs: NOW - DAY, watchedSec: 600 }], NOW, 30);
    expect(recente).toBeGreaterThan(antigo);
  });
});
