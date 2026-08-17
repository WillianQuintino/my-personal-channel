/**
 * Testes dos jobs, contra PGlite e transporte falso da API.
 *
 * Dois focos: a **retomada** (um job interrompido no meio da fatia termina o trabalho na
 * invocação seguinte, sem duplicar nem perder canal) e o **orçamento de cota**, que é o
 * que impede um job de fundo de esgotar a cota diária do usuário.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeTuneIn, localDayKey, startOfLocalDay } from '@minhatv/core';
import {
  getDayGrid,
  getJobCursor,
  getLiveStates,
  listPatches,
  listVideosByChannels,
  quotaSpentToday,
  seedChannel,
  seedTvChannel,
  seedUser,
  seedVideo,
  setFavorite,
  setSubscribed,
  slotAt,
  subscribedChannelIds,
  TEST_NOW,
  TEST_USER_ID,
  upsertLiveState,
  useTestDb,
} from './testing-support.js';
import { QuotaLedger, YouTubeClient } from '@minhatv/yt';
import { rawPlaylistItem, rawSubscription, rawVideo } from '@minhatv/yt/fixtures';
import {
  poolRefreshOrder,
  refreshAffinity,
  refreshPools,
  refreshSubscriptions,
} from './job-ingest.js';
import { applySourceFilter, hotInsertScan, materializeGrids, purgeCache } from './job-grid.js';
import { detectLives } from './job-live.js';
import { findJob, JOBS, runJob } from './registry.js';
import type { Db } from '@minhatv/db';
import type { JobDeps } from './types.js';

const DAY = 86_400_000;
const TZ = 'America/Sao_Paulo';
const DAY_KEY = localDayKey(TEST_NOW, TZ);
const DAY_START = startOfLocalDay(TEST_NOW, TZ);

/** Canais com id de comprimento real (`UC` + 22), como a API devolve. */
function canalId(i: number): string {
  return `UC${String(i).padStart(22, '0')}`;
}

const ctx = useTestDb({ beforeAll, afterAll, beforeEach });
let db: Db;
beforeEach(async () => {
  db = ctx.db;
  await seedUser(db);
});

/** Cliente com transporte falso que devolve as respostas na ordem dada. */
function fakeClient(respostas: readonly unknown[], limit = 10_000) {
  let i = 0;
  const chamadas: string[] = [];
  const ledger = new QuotaLedger(TEST_NOW, limit);
  const client = new YouTubeClient({
    credentials: { accessToken: 'token-falso' },
    ledger,
    transport: async (url) => {
      chamadas.push(url);
      const body = respostas[i++] ?? { items: [] };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    },
    now: () => TEST_NOW,
  });
  return { client, chamadas, ledger };
}

function deps(over: Partial<JobDeps> = {}): JobDeps {
  return { db, yt: null, now: () => TEST_NOW, ...over };
}

// ---------------------------------------------------------------------------

describe('registro de jobs', () => {
  it('todo job tem nome único', () => {
    const nomes = JOBS.map((j) => j.name);
    expect(new Set(nomes).size).toBe(nomes.length);
  });

  it('a detecção de lives é o job mais frequente', () => {
    // Uma live que começou e não foi detectada é tempo de canal perdido.
    expect(findJob('detectLives')?.cadence).toBe('every5min');
  });

  it('job desconhecido falha com mensagem útil', async () => {
    // Um cron que não faz nada é pior que um cron que quebra.
    await expect(runJob('naoExiste', deps())).rejects.toThrow(/desconhecido/);
  });

  it('job que consome cota exige o cliente da API', async () => {
    await expect(runJob('detectLives', deps({ yt: null }))).rejects.toThrow(/precisa do cliente/);
  });

  it('jobs sem cota rodam sem credencial nenhuma', async () => {
    // É o que permite rodar as purgas sem configurar o Google Cloud.
    const report = await runJob('purgeCache', deps({ yt: null }));
    expect(report.job).toBe('purgeCache');
  });
});

describe('refreshSubscriptions', () => {
  it('grava as inscrições e os canais', async () => {
    const canais = [canalId(1), canalId(2), canalId(3)];
    const { client } = fakeClient([
      { items: canais.map(rawSubscription) },
      {
        items: canais.map((id) => ({
          id,
          snippet: { title: `Canal ${id}` },
          contentDetails: { relatedPlaylists: { uploads: `UU${id.slice(2)}` } },
        })),
      },
    ]);

    const report = await refreshSubscriptions(deps({ yt: client }), TEST_USER_ID);

    expect(report.processed).toBe(3);
    expect(report.completed).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it('contabiliza a cota gasta no banco', async () => {
    const { client } = fakeClient([
      { items: [rawSubscription(canalId(1))] },
      { items: [{ id: canalId(1), snippet: {}, contentDetails: {} }] },
    ]);

    await refreshSubscriptions(deps({ yt: client }), TEST_USER_ID);

    // 1 (subscriptions.list) + 1 (channels.list) = 2 unidades.
    expect(await quotaSpentToday(db, TEST_NOW)).toBe(2);
  });

  it('funciona na primeira execução, com o banco sem canal nenhum', async () => {
    /*
     * Regressão: `user_channel_affinity` tem FK para `yt_channel`, e o job gravava a
     * inscrição antes de o canal existir. Estourava exatamente no caso mais comum — o
     * primeiro login de um usuário novo.
     */
    const canais = [canalId(1), canalId(2)];
    const { client } = fakeClient([
      { items: canais.map(rawSubscription) },
      { items: canais.map((id) => ({ id, snippet: {}, contentDetails: {} })) },
    ]);

    const report = await refreshSubscriptions(deps({ yt: client }), TEST_USER_ID);

    expect(report.errors).toEqual([]);
    expect(await subscribedChannelIds(db, TEST_USER_ID)).toHaveLength(2);
  });

  it('marca esgotado quando a fatia não cobre todas as inscrições', async () => {
    const canais = Array.from({ length: 5 }, (_, i) => canalId(i));
    const { client } = fakeClient([{ items: canais.map(rawSubscription) }, { items: [] }]);

    const report = await refreshSubscriptions(deps({ yt: client }), TEST_USER_ID, {
      quotaUnits: 500,
      maxItems: 2,
    });

    expect(report.exhausted).toBe(true);
    expect(report.completed).toBe(false);
  });
});

describe('refreshPools', () => {
  beforeEach(async () => {
    for (let i = 0; i < 6; i++) await seedChannel(db, { id: canalId(i) });
    await setSubscribed(
      db,
      TEST_USER_ID,
      Array.from({ length: 6 }, (_, i) => canalId(i)),
    );
  });

  it('traz os vídeos dos canais e grava', async () => {
    const respostas: unknown[] = [];
    for (let i = 0; i < 6; i++) respostas.push({ items: [rawPlaylistItem(`vid${i}`)] });
    respostas.push({
      items: Array.from({ length: 6 }, (_, i) =>
        rawVideo({ id: `vid${i}`, channelId: canalId(i) }),
      ),
    });
    const { client } = fakeClient(respostas);

    const report = await refreshPools(deps({ yt: client }), TEST_USER_ID);

    expect(report.processed).toBe(6);
    expect(report.completed).toBe(true);
    expect(await listVideosByChannels(db, [canalId(0)])).toHaveLength(1);
  });

  it('retoma de onde parou, sem duplicar nem perder canal', async () => {
    /*
     * O teste central da retomada. Duas invocações de 3 canais cada precisam cobrir os 6
     * exatamente uma vez — é o que garante que um job cortado pelo `maxDuration` de 10 s
     * convirja em vez de ficar reprocessando os mesmos primeiros itens para sempre.
     */
    const respostaDeFatia = (inicio: number) => {
      const r: unknown[] = [];
      for (let i = inicio; i < inicio + 3; i++) r.push({ items: [rawPlaylistItem(`vid${i}`)] });
      r.push({
        items: Array.from({ length: 3 }, (_, k) =>
          rawVideo({ id: `vid${inicio + k}`, channelId: canalId(inicio + k) }),
        ),
      });
      return r;
    };

    const primeira = await refreshPools(
      deps({ yt: fakeClient(respostaDeFatia(0)).client }),
      TEST_USER_ID,
      { quotaUnits: 500, maxItems: 3 },
    );
    expect(primeira.processed).toBe(3);
    expect(primeira.completed).toBe(false);

    const cursor = await getJobCursor(db, `refreshPools:${TEST_USER_ID}`);
    expect(cursor?.cursor).not.toBeNull();

    const segunda = await refreshPools(
      deps({ yt: fakeClient(respostaDeFatia(3)).client }),
      TEST_USER_ID,
      { quotaUnits: 500, maxItems: 3 },
    );
    expect(segunda.processed).toBe(3);
    expect(segunda.completed).toBe(true);

    // A volta terminou: o cursor zera e a próxima invocação recomeça.
    expect((await getJobCursor(db, `refreshPools:${TEST_USER_ID}`))?.cursor).toBeNull();

    // Todos os seis canais foram cobertos, uma vez cada.
    const todos = await listVideosByChannels(
      db,
      Array.from({ length: 6 }, (_, i) => canalId(i)),
    );
    expect(todos).toHaveLength(6);
  });

  it('cursor apontando para canal que saiu da lista recomeça em vez de travar', async () => {
    const { client } = fakeClient([]);
    // Simula um cursor obsoleto: canal removido das inscrições.
    await refreshPools(deps({ yt: client }), TEST_USER_ID, { quotaUnits: 0, maxItems: 3 });

    const report = await refreshPools(deps({ yt: fakeClient([]).client }), TEST_USER_ID, {
      quotaUnits: 500,
      maxItems: 3,
    });
    expect(report.errors.length + report.processed).toBeGreaterThan(0);
  });

  it('para ao esgotar o orçamento de cota', async () => {
    const respostas: unknown[] = [];
    for (let i = 0; i < 6; i++) respostas.push({ items: [rawPlaylistItem(`vid${i}`)] });
    const { client } = fakeClient(respostas);

    const report = await refreshPools(deps({ yt: client }), TEST_USER_ID, {
      quotaUnits: 2,
      maxItems: 50,
    });

    expect(report.exhausted).toBe(true);
    expect(report.quotaSpent).toBeLessThanOrEqual(3);
    expect(report.processed).toBeLessThan(6);
  });

  it('canal sem playlist de uploads é registrado e não interrompe os outros', async () => {
    // Um canal quebrado não deve impedir os outros 49 da fatia.
    await seedChannel(db, { id: 'PLnaoEhCanal', uploadsPlaylistId: null });
    await setSubscribed(db, TEST_USER_ID, ['PLnaoEhCanal', canalId(0)]);

    const { client } = fakeClient([{ items: [rawPlaylistItem('vid0')] }, { items: [] }]);
    const report = await refreshPools(deps({ yt: client }), TEST_USER_ID);

    expect(report.errors.map((e) => e.item)).toContain('PLnaoEhCanal');
    expect(report.processed).toBeGreaterThan(0);
  });

  it('sem canais, termina imediatamente', async () => {
    await setSubscribed(db, TEST_USER_ID, []);
    const report = await refreshPools(deps({ yt: fakeClient([]).client }), TEST_USER_ID);
    expect(report).toMatchObject({ processed: 0, completed: true });
  });

  it('não atualiza canal do qual o usuário se desinscreveu', async () => {
    /*
     * Regressão: a fila vinha de `topChannels`, que lê a tabela de afinidade — e ela
     * guarda histórico, inclusive de canais abandonados. O job gastaria cota para sempre
     * atualizando canais que o usuário não acompanha mais.
     */
    await setSubscribed(db, TEST_USER_ID, [canalId(0), canalId(1)]);
    await refreshAffinity(deps());
    await setSubscribed(db, TEST_USER_ID, [canalId(0)]);

    const ordem = await poolRefreshOrder(deps(), TEST_USER_ID, 100);

    expect(ordem).toEqual([canalId(0)]);
  });

  it('canal favorito entra na fila mesmo sem inscrição', async () => {
    // Marcar como favorito é uma escolha explícita; deve valer sem depender da inscrição.
    await setSubscribed(db, TEST_USER_ID, []);
    await setFavorite(db, TEST_USER_ID, canalId(2), true);

    expect(await poolRefreshOrder(deps(), TEST_USER_ID, 100)).toEqual([canalId(2)]);
  });
});

describe('refreshAffinity', () => {
  it('recalcula sem gastar cota', async () => {
    await seedChannel(db, { id: canalId(1) });
    await setSubscribed(db, TEST_USER_ID, [canalId(1)]);

    const report = await refreshAffinity(deps());

    expect(report.processed).toBe(1);
    expect(report.quotaSpent).toBe(0);
    expect(await quotaSpentToday(db, TEST_NOW)).toBe(0);
  });
});

describe('materializeGrids', () => {
  beforeEach(async () => {
    for (let i = 0; i < 200; i++) {
      await seedChannel(db, { id: canalId(i) });
      await seedVideo(db, { id: `v${i}`, ytChannelId: canalId(i), ageDays: 1 });
    }
    await setSubscribed(
      db,
      TEST_USER_ID,
      Array.from({ length: 200 }, (_, i) => canalId(i)),
    );
    await refreshAffinity(deps());
    await seedTvChannel(db, { id: 'tv-tudo' });
  });

  it('materializa hoje e amanhã', async () => {
    const report = await materializeGrids(deps());

    expect(report.processed).toBe(1);
    expect(await getDayGrid(db, 'tv-tudo', DAY_KEY)).not.toHaveLength(0);
    expect(await getDayGrid(db, 'tv-tudo', localDayKey(TEST_NOW + DAY, TZ))).not.toHaveLength(0);
  });

  it('a grade cobre 24 horas e sintoniza a qualquer hora', async () => {
    await materializeGrids(deps());
    const slots = await getDayGrid(db, 'tv-tudo', DAY_KEY);

    const tune = computeTuneIn(slots, TEST_NOW);
    expect(tune).not.toBeNull();
    expect(tune!.startSeconds).toBeLessThan(tune!.slot.durationSec);
    expect(slots[slots.length - 1]!.endsAtMs).toBeGreaterThanOrEqual(DAY_START + 24 * 3_600_000);
  });

  it('não regenera dia já materializado', async () => {
    /*
     * Regerar descartaria os patches já aplicados e mudaria a programação embaixo de quem
     * está assistindo — o oposto do invariante que a inserção a quente protege.
     */
    await materializeGrids(deps());
    const antes = await getDayGrid(db, 'tv-tudo', DAY_KEY);

    const report = await materializeGrids(deps());
    const depois = await getDayGrid(db, 'tv-tudo', DAY_KEY);

    expect(depois).toEqual(antes);
    const dias = report.details?.['days'] as { skipped: boolean }[];
    expect(dias.every((d) => d.skipped)).toBe(true);
  });

  it('não gasta cota', async () => {
    await materializeGrids(deps());
    expect(await quotaSpentToday(db, TEST_NOW)).toBe(0);
  });

  it('canal com pool vazio não quebra o job', async () => {
    await seedTvChannel(db, {
      id: 'tv-vazio',
      number: 2,
      sourceKind: 'CUSTOM',
      sourceSpec: { ytChannelIds: [] },
    });

    const report = await materializeGrids(deps());

    expect(report.errors).toEqual([]);
    expect(await getDayGrid(db, 'tv-vazio', DAY_KEY)).toEqual([]);
  });
});

describe('filtro de fonte', () => {
  const pool = [
    {
      id: 'a',
      ytChannelId: 'UC1',
      title: 'Base #minecraft nova',
      durationSec: 600,
      publishedAt: TEST_NOW,
      categoryId: '20',
      tags: ['minecraft'],
    },
    {
      id: 'b',
      ytChannelId: 'UC2',
      title: 'Receita de bolo',
      durationSec: 600,
      publishedAt: TEST_NOW,
      categoryId: '26',
      tags: ['culinaria'],
    },
    {
      id: 'c',
      ytChannelId: 'UC3',
      title: 'Sem tag mas fala de #Minecraft',
      durationSec: 600,
      publishedAt: TEST_NOW,
      categoryId: '20',
      tags: [],
    },
  ];

  function canal(sourceKind: string, sourceSpec: Record<string, unknown>) {
    return {
      id: 'tv-x',
      userId: TEST_USER_ID,
      name: 'x',
      number: 1,
      sourceKind: sourceKind as 'CATEGORY',
      sourceSpec,
      mode: 'VOD' as const,
      filters: {},
    };
  }

  it('recorta por categoria', () => {
    const out = applySourceFilter(pool, canal('CATEGORY', { categoryId: '20' }));
    expect(out.map((v) => v.id)).toEqual(['a', 'c']);
  });

  it('recorta por hashtag em tags e em título', () => {
    // Sem endpoint de hashtag na API, o casamento é por tags e por menção no título.
    const out = applySourceFilter(pool, canal('HASHTAG', { hashtag: '#minecraft' }));
    expect(out.map((v) => v.id)).toEqual(['a', 'c']);
  });

  it('ignora maiúsculas na hashtag', () => {
    const out = applySourceFilter(pool, canal('HASHTAG', { hashtag: 'MINECRAFT' }));
    expect(out.map((v) => v.id)).toEqual(['a', 'c']);
  });

  it('sem recorte configurado, devolve o pool inteiro', () => {
    expect(applySourceFilter(pool, canal('CATEGORY', {}))).toHaveLength(3);
    expect(applySourceFilter(pool, canal('HASHTAG', {}))).toHaveLength(3);
  });
});

describe('hotInsertScan', () => {
  beforeEach(async () => {
    for (let i = 0; i < 200; i++) {
      await seedChannel(db, { id: canalId(i) });
      await seedVideo(db, { id: `v${i}`, ytChannelId: canalId(i), ageDays: 1 });
    }
    await setSubscribed(
      db,
      TEST_USER_ID,
      Array.from({ length: 200 }, (_, i) => canalId(i)),
    );
    await refreshAffinity(deps());
    await seedTvChannel(db, { id: 'tv-tudo' });
    await materializeGrids(deps());
  });

  it('insere upload novo de canal favorito e registra o patch', async () => {
    const favorito = canalId(0);
    await setFavorite(db, TEST_USER_ID, favorito, true);
    await refreshAffinity(deps());
    // Vídeo publicado agora, ainda fora da grade.
    await seedVideo(db, { id: 'novissimo', ytChannelId: favorito, ageDays: 0.01 });

    const report = await hotInsertScan(deps());

    expect(report.errors).toEqual([]);
    const slots = await getDayGrid(db, 'tv-tudo', DAY_KEY);
    expect(slots.some((s) => s.videoId === 'novissimo' && s.isHotInsert)).toBe(true);

    const patches = await listPatches(db, 'tv-tudo', DAY_KEY);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ seqNo: 1, kind: 'HOT_INSERT', videoId: 'novissimo' });
  });

  it('o slot no ar não muda com a inserção', async () => {
    /*
     * O invariante mais importante do produto: quem está assistindo não leva solavanco.
     */
    const antes = await slotAt(db, 'tv-tudo', TEST_NOW);
    const favorito = canalId(0);
    await setFavorite(db, TEST_USER_ID, favorito, true);
    await refreshAffinity(deps());
    await seedVideo(db, { id: 'novissimo', ytChannelId: favorito, ageDays: 0.01 });

    await hotInsertScan(deps());

    expect(await slotAt(db, 'tv-tudo', TEST_NOW)).toEqual(antes);
  });

  it('não insere upload de canal fora do top-K nem favorito', async () => {
    // Sem o portão, todo upload de todo canal viraria uma reordenação.
    await seedChannel(db, { id: canalId(900) });
    await seedVideo(db, { id: 'irrelevante', ytChannelId: canalId(900), ageDays: 0.01 });

    await hotInsertScan(deps());

    const slots = await getDayGrid(db, 'tv-tudo', DAY_KEY);
    expect(slots.some((s) => s.videoId === 'irrelevante')).toBe(false);
    expect(await listPatches(db, 'tv-tudo', DAY_KEY)).toEqual([]);
  });

  it('uma inserção por canal por invocação', async () => {
    const favorito = canalId(0);
    await setFavorite(db, TEST_USER_ID, favorito, true);
    await refreshAffinity(deps());
    for (let i = 0; i < 5; i++) {
      await seedVideo(db, { id: `novo${i}`, ytChannelId: favorito, ageDays: 0.01 });
    }

    await hotInsertScan(deps());

    // O intervalo mínimo de 20 min segura o resto para as invocações seguintes.
    expect(await listPatches(db, 'tv-tudo', DAY_KEY)).toHaveLength(1);
  });

  it('sem grade materializada, não faz nada', async () => {
    await seedTvChannel(db, { id: 'tv-sem-grade', number: 9 });
    const report = await hotInsertScan(deps());
    expect(await listPatches(db, 'tv-sem-grade', DAY_KEY)).toEqual([]);
    expect(report.errors).toEqual([]);
  });

  it('não gasta cota', async () => {
    await hotInsertScan(deps());
    expect(await quotaSpentToday(db, TEST_NOW)).toBe(0);
  });
});

describe('detectLives', () => {
  beforeEach(async () => {
    for (let i = 0; i < 3; i++) await seedChannel(db, { id: canalId(i) });
  });

  it('detecta transmissão no ar e grava o estado', async () => {
    const canal = canalId(0);
    const respostas: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      respostas.push({ items: [rawPlaylistItem(`live${i}`)] });
      respostas.push({
        items: [
          rawVideo({
            id: `live${i}`,
            channelId: canalId(i),
            duration: 'PT0S',
            liveBroadcastContent: i === 0 ? 'live' : 'none',
            ...(i === 0 ? { actualStartTime: new Date(TEST_NOW - 600_000).toISOString() } : {}),
          }),
        ],
      });
    }
    const { client } = fakeClient(respostas);

    const report = await detectLives(deps({ yt: client }));

    expect(report.errors).toEqual([]);
    const [state] = await getLiveStates(db, [canal]);
    expect(state?.status).toBe('live');
    expect(state?.videoId).toBe('live0');
  });

  it('o custo é de 2 unidades por canal, não 100', async () => {
    /*
     * A prova numérica da decisão de projeto: `search.list eventType=live` custaria 100
     * unidades por canal, e checar 50 canais uma vez estouraria metade da cota diária.
     */
    const respostas: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      respostas.push({ items: [rawPlaylistItem(`v${i}`)] });
      respostas.push({ items: [rawVideo({ id: `v${i}`, channelId: canalId(i) })] });
    }
    const { client } = fakeClient(respostas);

    const report = await detectLives(deps({ yt: client }));

    expect(report.processed).toBe(3);
    expect(report.quotaSpent).toBe(6);
    expect(await quotaSpentToday(db, TEST_NOW)).toBe(6);
  });

  it('respeita o polling dirigido: só checa quem venceu', async () => {
    for (let i = 0; i < 3; i++) {
      await upsertLiveState(db, {
        ytChannelId: canalId(i),
        status: 'offline',
        videoId: null,
        scheduledStartMs: null,
        checkedAtMs: TEST_NOW,
        // Só o canal 0 venceu.
        nextCheckAtMs: i === 0 ? TEST_NOW - 60_000 : TEST_NOW + 3_600_000,
      });
    }

    const respostas: unknown[] = [
      { items: [rawPlaylistItem('v0')] },
      { items: [rawVideo({ id: 'v0', channelId: canalId(0) })] },
    ];
    const report = await detectLives(deps({ yt: fakeClient(respostas).client }));

    expect(report.processed).toBe(1);
    expect(report.details?.['queue']).toBe(1);
  });

  it('para ao esgotar o orçamento', async () => {
    const respostas: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      respostas.push({ items: [rawPlaylistItem(`v${i}`)] });
      respostas.push({ items: [rawVideo({ id: `v${i}`, channelId: canalId(i) })] });
    }
    const report = await detectLives(deps({ yt: fakeClient(respostas).client }), {
      quotaUnits: 2,
      maxItems: 50,
    });

    expect(report.exhausted).toBe(true);
    expect(report.processed).toBeLessThan(3);
  });

  it('fila vazia termina imediatamente', async () => {
    for (let i = 0; i < 3; i++) {
      await upsertLiveState(db, {
        ytChannelId: canalId(i),
        status: 'offline',
        videoId: null,
        scheduledStartMs: null,
        checkedAtMs: TEST_NOW,
        nextCheckAtMs: TEST_NOW + 3_600_000,
      });
    }

    const report = await detectLives(deps({ yt: fakeClient([]).client }));
    expect(report).toMatchObject({ processed: 0, completed: true });
  });
});

describe('purgeCache', () => {
  it('apaga o cache vencido e reporta', async () => {
    await seedChannel(db, { id: canalId(1) });
    await seedVideo(db, {
      id: 'vencido',
      ytChannelId: canalId(1),
      refreshedAtMs: TEST_NOW - 40 * DAY,
    });
    await seedVideo(db, { id: 'vivo', ytChannelId: canalId(1), refreshedAtMs: TEST_NOW });

    const report = await purgeCache(deps());

    expect(report.details?.['videosDeleted']).toBe(1);
    expect((await listVideosByChannels(db, [canalId(1)])).map((v) => v.id)).toEqual(['vivo']);
  });
});
