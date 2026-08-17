/**
 * Testes do ranking de afinidade (R1).
 *
 * Como a API não expõe histórico de exibição desde 2016, o ranking combina três fontes:
 * import do Takeout, inscrições e tracking interno com decaimento.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseWatchHistory } from '@minhatv/yt';
import {
  affinityMap,
  applyTakeoutCounts,
  favoriteChannelIds,
  recomputeAffinity,
  recordWatchEvent,
  setFavorite,
  setSubscribed,
  subscribedChannelIds,
  topChannels,
} from './repo-affinity.js';
import { seedChannel, seedUser, TEST_NOW, TEST_USER_ID, useTestDb } from './testing.js';
import type { Db } from './client.js';

const DAY = 86_400_000;

/*
 * Ids com o comprimento real (`UC` + 22 caracteres). Não é preciosismo: o parser do
 * Takeout extrai o id por regex de URL e exige esse comprimento, então ids curtos de
 * fixture passariam nos testes de banco e falhariam na integração com o parser.
 */
const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const C = 'UCcccccccccccccccccccccc';
const D = 'UCdddddddddddddddddddddd';
const CANAIS = [A, B, C, D];

const ctx = useTestDb({ beforeAll, afterAll, beforeEach });
let db: Db;
beforeEach(async () => {
  db = ctx.db;
  await seedUser(db);
  for (const id of CANAIS) await seedChannel(db, { id });
});

describe('inscrições', () => {
  it('marca os canais inscritos', async () => {
    await setSubscribed(db, TEST_USER_ID, [A, B]);
    expect((await subscribedChannelIds(db, TEST_USER_ID)).sort()).toEqual([A, B]);
  });

  it('desmarca quem saiu da lista', async () => {
    /*
     * Uma inscrição cancelada tem de deixar de contar no ranking. Sem zerar o flag
     * antes, o canal ficaria pontuando para sempre como se ainda fosse acompanhado.
     */
    await setSubscribed(db, TEST_USER_ID, [A, B]);
    await setSubscribed(db, TEST_USER_ID, [B]);

    expect(await subscribedChannelIds(db, TEST_USER_ID)).toEqual([B]);
  });

  it('lista vazia desmarca todos', async () => {
    await setSubscribed(db, TEST_USER_ID, [A]);
    await setSubscribed(db, TEST_USER_ID, []);
    expect(await subscribedChannelIds(db, TEST_USER_ID)).toEqual([]);
  });

  it('é idempotente', async () => {
    await setSubscribed(db, TEST_USER_ID, [A]);
    await setSubscribed(db, TEST_USER_ID, [A]);
    expect(await subscribedChannelIds(db, TEST_USER_ID)).toEqual([A]);
  });
});

describe('favoritos', () => {
  it('marca e desmarca', async () => {
    await setFavorite(db, TEST_USER_ID, A, true);
    expect(await favoriteChannelIds(db, TEST_USER_ID)).toEqual(new Set([A]));

    await setFavorite(db, TEST_USER_ID, A, false);
    expect(await favoriteChannelIds(db, TEST_USER_ID)).toEqual(new Set());
  });

  it('convive com a marca de inscrição no mesmo registro', async () => {
    await setSubscribed(db, TEST_USER_ID, [A]);
    await setFavorite(db, TEST_USER_ID, A, true);

    expect(await subscribedChannelIds(db, TEST_USER_ID)).toEqual([A]);
    expect(await favoriteChannelIds(db, TEST_USER_ID)).toEqual(new Set([A]));
  });
});

describe('import do Takeout', () => {
  it('grava as contagens dos canais conhecidos', async () => {
    const importado = await applyTakeoutCounts(db, TEST_USER_ID, [
      { ytChannelId: A, channelTitle: 'A', count: 50, lastWatchedMs: TEST_NOW },
      { ytChannelId: B, channelTitle: 'B', count: 10, lastWatchedMs: TEST_NOW },
    ]);

    expect(importado).toBe(2);
    await recomputeAffinity(db, TEST_USER_ID, TEST_NOW);
    const scores = await affinityMap(db, TEST_USER_ID);
    expect(scores.get(A)!).toBeGreaterThan(scores.get(B)!);
  });

  it('descarta entradas cujo canal o Takeout não identificou', async () => {
    // O parser usa a chave `desconhecido:` quando o vídeo foi removido e não há id.
    const importado = await applyTakeoutCounts(db, TEST_USER_ID, [
      { ytChannelId: 'desconhecido:Canal Sumido', channelTitle: '', count: 99, lastWatchedMs: 0 },
    ]);
    expect(importado).toBe(0);
  });

  it('integra com o parser do arquivo real', async () => {
    const entries = Array.from({ length: 7 }, () => ({
      header: 'YouTube',
      titleUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      time: '2026-08-16T12:00:00Z',
      subtitles: [{ name: 'A', url: `https://www.youtube.com/channel/${A}` }],
    }));
    const { counts } = parseWatchHistory(entries);

    await applyTakeoutCounts(db, TEST_USER_ID, counts);
    await recomputeAffinity(db, TEST_USER_ID, TEST_NOW);

    expect((await affinityMap(db, TEST_USER_ID)).get(A)!).toBeGreaterThan(0);
  });
});

describe('tracking interno', () => {
  it('minutos assistidos elevam o score', async () => {
    await setSubscribed(db, TEST_USER_ID, [A, B]);
    await recordWatchEvent(db, {
      id: 'e1',
      userId: TEST_USER_ID,
      videoId: 'v1',
      ytChannelId: A,
      watchedSec: 1_800,
      atMs: TEST_NOW - 3_600_000,
    });

    await recomputeAffinity(db, TEST_USER_ID, TEST_NOW);
    const scores = await affinityMap(db, TEST_USER_ID);
    expect(scores.get(A)!).toBeGreaterThan(scores.get(B)!);
  });

  it('eventos antigos pesam menos que recentes', async () => {
    await setSubscribed(db, TEST_USER_ID, [A, B]);
    await recordWatchEvent(db, {
      id: 'antigo',
      userId: TEST_USER_ID,
      videoId: 'v1',
      ytChannelId: A,
      watchedSec: 3_600,
      atMs: TEST_NOW - 150 * DAY,
    });
    await recordWatchEvent(db, {
      id: 'recente',
      userId: TEST_USER_ID,
      videoId: 'v2',
      ytChannelId: B,
      watchedSec: 600,
      atMs: TEST_NOW - DAY,
    });

    await recomputeAffinity(db, TEST_USER_ID, TEST_NOW);
    const scores = await affinityMap(db, TEST_USER_ID);
    // Uma hora de cinco meses atrás vale menos que dez minutos de ontem: é o que faz o
    // ranking acompanhar a mudança de gosto sem precisar reimportar o Takeout.
    expect(scores.get(B)!).toBeGreaterThan(scores.get(A)!);
  });

  it('evento duplicado não conta duas vezes', async () => {
    await setSubscribed(db, TEST_USER_ID, [A]);
    const evento = {
      id: 'mesmo-id',
      userId: TEST_USER_ID,
      videoId: 'v1',
      ytChannelId: A,
      watchedSec: 600,
      atMs: TEST_NOW,
    };
    await recordWatchEvent(db, evento);
    await recordWatchEvent(db, evento);

    const { channels } = await recomputeAffinity(db, TEST_USER_ID, TEST_NOW);
    expect(channels).toBe(1);
  });
});

describe('score combinado', () => {
  it('fica em [0,1] e é materializado', async () => {
    await setSubscribed(db, TEST_USER_ID, CANAIS);
    await applyTakeoutCounts(db, TEST_USER_ID, [
      { ytChannelId: A, channelTitle: 'A', count: 500, lastWatchedMs: TEST_NOW },
    ]);
    await setFavorite(db, TEST_USER_ID, A, true);

    await recomputeAffinity(db, TEST_USER_ID, TEST_NOW);

    for (const score of (await affinityMap(db, TEST_USER_ID)).values()) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('reporta o canal do topo', async () => {
    await setSubscribed(db, TEST_USER_ID, CANAIS);
    await applyTakeoutCounts(db, TEST_USER_ID, [
      { ytChannelId: C, channelTitle: 'C', count: 900, lastWatchedMs: TEST_NOW },
    ]);
    await setFavorite(db, TEST_USER_ID, C, true);

    const report = await recomputeAffinity(db, TEST_USER_ID, TEST_NOW);
    expect(report).toMatchObject({ channels: 4, topChannelId: C });
  });

  it('sem nenhum canal registrado, o relatório é vazio', async () => {
    expect(await recomputeAffinity(db, TEST_USER_ID, TEST_NOW)).toEqual({
      channels: 0,
      topChannelId: null,
    });
  });

  it('recalcular é idempotente', async () => {
    await setSubscribed(db, TEST_USER_ID, CANAIS);
    await recomputeAffinity(db, TEST_USER_ID, TEST_NOW);
    const primeiro = await affinityMap(db, TEST_USER_ID);
    await recomputeAffinity(db, TEST_USER_ID, TEST_NOW);
    expect(await affinityMap(db, TEST_USER_ID)).toEqual(primeiro);
  });
});

describe('topChannels', () => {
  beforeEach(async () => {
    await setSubscribed(db, TEST_USER_ID, CANAIS);
    await applyTakeoutCounts(db, TEST_USER_ID, [
      { ytChannelId: A, channelTitle: 'A', count: 100, lastWatchedMs: TEST_NOW },
      { ytChannelId: B, channelTitle: 'B', count: 50, lastWatchedMs: TEST_NOW },
      { ytChannelId: C, channelTitle: 'C', count: 10, lastWatchedMs: TEST_NOW },
    ]);
    await recomputeAffinity(db, TEST_USER_ID, TEST_NOW);
  });

  it('devolve os melhores, em ordem', async () => {
    expect(await topChannels(db, TEST_USER_ID, 2)).toEqual([A, B]);
  });

  it('a ordem é estável entre consultas', async () => {
    /*
     * O desempate por id importa: sem ele, canais com o mesmo score alternariam entre
     * consultas e o polling em camadas ficaria oscilando de fatia em fatia.
     */
    const a = await topChannels(db, TEST_USER_ID, 4);
    const b = await topChannels(db, TEST_USER_ID, 4);
    expect(b).toEqual(a);
  });

  it('limite maior que o total devolve tudo', async () => {
    expect(await topChannels(db, TEST_USER_ID, 99)).toHaveLength(4);
  });
});

describe('isolamento entre usuários', () => {
  it('o ranking de um usuário não vaza para o outro', async () => {
    await seedUser(db, { id: 'outro', email: 'outro@exemplo.test' });
    await setSubscribed(db, TEST_USER_ID, [A]);
    await setSubscribed(db, 'outro', [B]);

    expect(await subscribedChannelIds(db, TEST_USER_ID)).toEqual([A]);
    expect(await subscribedChannelIds(db, 'outro')).toEqual([B]);
  });
});
