/**
 * Testes dos repositórios operacionais: canais de TV, lives, cota (R2) e cursores.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GRID_CONFIG } from '@minhatv/core';
import { detectLiveState, quotaDayKey, resolveLiveChannel } from '@minhatv/yt';
import {
  channelsDueForLiveCheck,
  channelsWithoutLiveState,
  chargeQuota,
  deleteTvChannel,
  effectiveGridConfig,
  getJobCursor,
  getLiveStates,
  getOauthAccount,
  getTvChannel,
  getUser,
  listTvChannels,
  listUserIds,
  quotaBreakdownToday,
  quotaSpentToday,
  saveOauthAccount,
  setJobCursor,
  upsertLiveState,
  upsertTvChannel,
  upsertUser,
} from './repo-ops.js';
import {
  seedChannel,
  seedTvChannel,
  seedUser,
  seedVideo,
  TEST_NOW,
  TEST_USER_ID,
  useTestDb,
} from './testing.js';
import { listVideosByChannels } from './repo-video.js';
import { schema } from './client.js';
import type { Db } from './client.js';
import type { TvChannelRecord } from './repo-ops.js';

const MIN = 60_000;

const ctx = useTestDb({ beforeAll, afterAll, beforeEach });
let db: Db;
beforeEach(async () => {
  db = ctx.db;
  await seedUser(db);
});

function tvChannel(over: Partial<TvChannelRecord> = {}): TvChannelRecord {
  return {
    id: 'tv-1',
    userId: TEST_USER_ID,
    name: 'Tudo',
    number: 1,
    sourceKind: 'ALL_SUBSCRIPTIONS',
    sourceSpec: {},
    mode: 'VOD',
    filters: {},
    ...over,
  };
}

describe('canais de TV', () => {
  it('grava e relê, preservando jsonb', async () => {
    await upsertTvChannel(
      db,
      tvChannel({
        sourceKind: 'HASHTAG',
        sourceSpec: { hashtag: 'minecraft', extras: ['UC1'] },
        filters: { minDurationSec: 300, coverageSec: 43_200 },
        mode: 'BOTH',
      }),
    );

    const lido = await getTvChannel(db, 'tv-1');
    expect(lido).toMatchObject({
      sourceKind: 'HASHTAG',
      sourceSpec: { hashtag: 'minecraft', extras: ['UC1'] },
      filters: { minDurationSec: 300, coverageSec: 43_200 },
      mode: 'BOTH',
    });
  });

  it('atualiza no conflito de id', async () => {
    await upsertTvChannel(db, tvChannel({ name: 'Antes' }));
    await upsertTvChannel(db, tvChannel({ name: 'Depois', number: 7 }));

    const canais = await listTvChannels(db, TEST_USER_ID);
    expect(canais).toHaveLength(1);
    expect(canais[0]).toMatchObject({ name: 'Depois', number: 7 });
  });

  it('lista em ordem de número, que é a ordem do zapping', async () => {
    await upsertTvChannel(db, tvChannel({ id: 'tv-c', number: 3 }));
    await upsertTvChannel(db, tvChannel({ id: 'tv-a', number: 1 }));
    await upsertTvChannel(db, tvChannel({ id: 'tv-b', number: 2 }));

    expect((await listTvChannels(db, TEST_USER_ID)).map((c) => c.id)).toEqual([
      'tv-a',
      'tv-b',
      'tv-c',
    ]);
  });

  it('recusa dois canais com o mesmo número para o mesmo usuário', async () => {
    // O número é o endereço do canal no zapping: duplicá-lo tornaria o destino ambíguo.
    await upsertTvChannel(db, tvChannel({ id: 'tv-1', number: 5 }));
    await expect(upsertTvChannel(db, tvChannel({ id: 'tv-2', number: 5 }))).rejects.toThrow();
  });

  it('permite o mesmo número para usuários diferentes', async () => {
    await seedUser(db, { id: 'outro', email: 'outro@exemplo.test' });
    await upsertTvChannel(db, tvChannel({ id: 'tv-1', number: 1 }));
    await upsertTvChannel(db, tvChannel({ id: 'tv-2', userId: 'outro', number: 1 }));

    expect(await listTvChannels(db, TEST_USER_ID)).toHaveLength(1);
    expect(await listTvChannels(db, 'outro')).toHaveLength(1);
  });

  it('devolve null para canal inexistente', async () => {
    expect(await getTvChannel(db, 'nao-existe')).toBeNull();
  });

  it('apagar remove o canal', async () => {
    await upsertTvChannel(db, tvChannel());
    await deleteTvChannel(db, 'tv-1');
    expect(await getTvChannel(db, 'tv-1')).toBeNull();
  });
});

describe('configuração efetiva do canal', () => {
  it('aplica o fuso do usuário sobre os padrões', async () => {
    await seedUser(db, { id: 'lisboa', email: 'l@exemplo.test', timeZone: 'Europe/Lisbon' });
    await upsertTvChannel(db, tvChannel({ id: 'tv-pt', userId: 'lisboa' }));

    const config = await effectiveGridConfig(db, 'tv-pt');
    // O fuso define a virada do dia e, portanto, o seed da grade.
    expect(config?.timeZone).toBe('Europe/Lisbon');
    expect(config?.coverageSec).toBe(DEFAULT_GRID_CONFIG.coverageSec);
  });

  it('as sobrescritas do canal vencem os padrões', async () => {
    await upsertTvChannel(db, tvChannel({ filters: { minDurationSec: 900, jitterPct: 0 } }));

    const config = await effectiveGridConfig(db, 'tv-1');
    expect(config).toMatchObject({ minDurationSec: 900, jitterPct: 0 });
    expect(config?.recencyBucketHours).toBe(DEFAULT_GRID_CONFIG.recencyBucketHours);
  });

  it('devolve null para canal inexistente', async () => {
    expect(await effectiveGridConfig(db, 'nao-existe')).toBeNull();
  });
});

describe('estado de live', () => {
  beforeEach(async () => {
    await seedChannel(db, { id: 'UC0001' });
    await seedChannel(db, { id: 'UC0002' });
  });

  it('grava e relê', async () => {
    await upsertLiveState(db, {
      ytChannelId: 'UC0001',
      status: 'live',
      videoId: 'live1',
      scheduledStartMs: TEST_NOW - MIN,
      checkedAtMs: TEST_NOW,
      nextCheckAtMs: TEST_NOW + 5 * MIN,
    });

    const [state] = await getLiveStates(db, ['UC0001']);
    expect(state).toMatchObject({ status: 'live', videoId: 'live1' });
    expect(state?.nextCheckAtMs).toBe(TEST_NOW + 5 * MIN);
  });

  it('atualiza no conflito', async () => {
    const base = {
      ytChannelId: 'UC0001',
      videoId: null,
      scheduledStartMs: null,
      checkedAtMs: TEST_NOW,
      nextCheckAtMs: TEST_NOW + 3_600_000,
    };
    await upsertLiveState(db, { ...base, status: 'offline' });
    await upsertLiveState(db, { ...base, status: 'live', videoId: 'v1' });

    const states = await getLiveStates(db, ['UC0001']);
    expect(states).toHaveLength(1);
    expect(states[0]?.status).toBe('live');
  });

  it('a fila do worker traz só quem venceu, do mais atrasado ao menos', async () => {
    await upsertLiveState(db, {
      ytChannelId: 'UC0001',
      status: 'offline',
      videoId: null,
      scheduledStartMs: null,
      checkedAtMs: TEST_NOW,
      nextCheckAtMs: TEST_NOW - 10 * MIN,
    });
    await upsertLiveState(db, {
      ytChannelId: 'UC0002',
      status: 'offline',
      videoId: null,
      scheduledStartMs: null,
      checkedAtMs: TEST_NOW,
      nextCheckAtMs: TEST_NOW + 10 * MIN,
    });

    // Polling dirigido: é o que mantém a detecção dentro do orçamento de cota.
    expect(await channelsDueForLiveCheck(db, TEST_NOW, 10)).toEqual(['UC0001']);
  });

  it('canais sem estado registrado precisam da primeira checagem', async () => {
    await upsertLiveState(db, {
      ytChannelId: 'UC0001',
      status: 'offline',
      videoId: null,
      scheduledStartMs: null,
      checkedAtMs: TEST_NOW,
      nextCheckAtMs: TEST_NOW + MIN,
    });

    expect(await channelsWithoutLiveState(db, 10)).toEqual(['UC0002']);
  });

  it('integra com a detecção do pacote yt', async () => {
    await seedVideo(db, {
      id: 'live-agora',
      ytChannelId: 'UC0001',
      liveState: 'live',
      durationSec: null,
    });

    const videos = await listVideosByChannels(db, ['UC0001']);
    const state = detectLiveState('UC0001', videos, { nowMs: TEST_NOW });
    await upsertLiveState(db, state);

    const resolucao = resolveLiveChannel(await getLiveStates(db, ['UC0001']), TEST_NOW);
    expect(resolucao).toEqual({ kind: 'live', videoId: 'live-agora', ytChannelId: 'UC0001' });
  });

  it('sem ninguém ao vivo, a resolução cai para a grade VOD', async () => {
    await upsertLiveState(db, {
      ytChannelId: 'UC0001',
      status: 'offline',
      videoId: null,
      scheduledStartMs: null,
      checkedAtMs: TEST_NOW,
      nextCheckAtMs: TEST_NOW + 3_600_000,
    });
    // "Sem sinal" é a experiência que o produto existe para evitar.
    expect(resolveLiveChannel(await getLiveStates(db, ['UC0001']), TEST_NOW)).toEqual({
      kind: 'vod_fallback',
    });
  });

  it('lista vazia devolve nada', async () => {
    expect(await getLiveStates(db, [])).toEqual([]);
  });
});

describe('cota (R2)', () => {
  it('acumula unidades no dia', async () => {
    await chargeQuota(db, TEST_NOW, 1, 'videos.list');
    await chargeQuota(db, TEST_NOW, 100, 'search.list');

    expect(await quotaSpentToday(db, TEST_NOW)).toBe(101);
  });

  it('detalha por método', async () => {
    await chargeQuota(db, TEST_NOW, 1, 'videos.list');
    await chargeQuota(db, TEST_NOW, 1, 'videos.list');
    await chargeQuota(db, TEST_NOW, 100, 'search.list');

    expect(await quotaBreakdownToday(db, TEST_NOW)).toEqual({
      'videos.list': 2,
      'search.list': 100,
    });
  });

  it('a virada é à meia-noite do Pacífico, não do usuário', async () => {
    /*
     * A cota do YouTube zera no fuso do Pacífico. Contabilizar no fuso do usuário faria
     * o orçamento parecer disponível quando na verdade já estava gasto.
     */
    const antes = Date.UTC(2026, 7, 17, 6, 59, 0); // 16/08 no Pacífico
    const depois = Date.UTC(2026, 7, 17, 7, 1, 0); // 17/08 no Pacífico

    await chargeQuota(db, antes, 500, 'search.list');

    expect(quotaDayKey(antes)).not.toBe(quotaDayKey(depois));
    expect(await quotaSpentToday(db, antes)).toBe(500);
    expect(await quotaSpentToday(db, depois)).toBe(0);
  });

  it('dia sem registro reporta zero', async () => {
    expect(await quotaSpentToday(db, TEST_NOW)).toBe(0);
    expect(await quotaBreakdownToday(db, TEST_NOW)).toEqual({});
  });
});

describe('cursores de job', () => {
  it('grava e relê o progresso', async () => {
    await setJobCursor(db, 'refreshPools', 'UC0042', TEST_NOW);

    const cursor = await getJobCursor(db, 'refreshPools');
    expect(cursor).toMatchObject({ job: 'refreshPools', cursor: 'UC0042', lastError: null });
    expect(cursor?.finishedAtMs).toBeNull();
  });

  it('cursor nulo marca a volta como concluída', async () => {
    // É o sinal de "terminou a volta": a próxima invocação começa do início.
    await setJobCursor(db, 'refreshPools', 'UC0042', TEST_NOW);
    await setJobCursor(db, 'refreshPools', null, TEST_NOW + MIN);

    const cursor = await getJobCursor(db, 'refreshPools');
    expect(cursor?.cursor).toBeNull();
    expect(cursor?.finishedAtMs).toBe(TEST_NOW + MIN);
  });

  it('registra o último erro', async () => {
    await setJobCursor(db, 'detectLives', 'UC0001', TEST_NOW, 'quotaExceeded');
    expect((await getJobCursor(db, 'detectLives'))?.lastError).toBe('quotaExceeded');
  });

  it('job desconhecido devolve null', async () => {
    expect(await getJobCursor(db, 'nunca-rodou')).toBeNull();
  });

  it('jobs diferentes têm cursores independentes', async () => {
    await setJobCursor(db, 'a', 'x', TEST_NOW);
    await setJobCursor(db, 'b', 'y', TEST_NOW);

    expect((await getJobCursor(db, 'a'))?.cursor).toBe('x');
    expect((await getJobCursor(db, 'b'))?.cursor).toBe('y');
  });
});

describe('usuário e credenciais', () => {
  it('grava e relê o usuário', async () => {
    await upsertUser(db, {
      id: 'novo',
      email: 'novo@exemplo.test',
      region: 'PT',
      timeZone: 'Europe/Lisbon',
    });

    expect(await getUser(db, 'novo')).toEqual({
      id: 'novo',
      email: 'novo@exemplo.test',
      region: 'PT',
      timeZone: 'Europe/Lisbon',
    });
  });

  it('lista os ids em ordem estável', async () => {
    await upsertUser(db, { id: 'zzz', email: 'z@x.test', region: 'BR', timeZone: 'UTC' });
    await upsertUser(db, { id: 'aaa', email: 'a@x.test', region: 'BR', timeZone: 'UTC' });

    const ids = await listUserIds(db);
    expect(ids.indexOf('aaa')).toBeLessThan(ids.indexOf('zzz'));
  });

  it('guarda o token cifrado e os escopos', async () => {
    await saveOauthAccount(db, {
      userId: TEST_USER_ID,
      provider: 'google',
      refreshTokenEnc: 'cifrado-abc',
      scopes: ['https://www.googleapis.com/auth/youtube.readonly', 'openid'],
      expiresAtMs: TEST_NOW + 3_600_000,
    });

    const conta = await getOauthAccount(db, TEST_USER_ID, 'google');
    expect(conta?.refreshTokenEnc).toBe('cifrado-abc');
    expect(conta?.scopes).toContain('https://www.googleapis.com/auth/youtube.readonly');
  });

  it('substitui o token no reconsentimento', async () => {
    const base = {
      userId: TEST_USER_ID,
      provider: 'google',
      scopes: ['openid'],
      expiresAtMs: null,
    };
    await saveOauthAccount(db, { ...base, refreshTokenEnc: 'antigo' });
    await saveOauthAccount(db, { ...base, refreshTokenEnc: 'novo' });

    expect((await getOauthAccount(db, TEST_USER_ID, 'google'))?.refreshTokenEnc).toBe('novo');
  });

  it('conta inexistente devolve null', async () => {
    expect(await getOauthAccount(db, TEST_USER_ID, 'google')).toBeNull();
  });
});

describe('cascata de exclusão', () => {
  it('apagar o usuário leva canais e afinidades', async () => {
    await seedChannel(db, { id: 'UC0001' });
    await seedTvChannel(db, { id: 'tv-x' });
    await saveOauthAccount(db, {
      userId: TEST_USER_ID,
      provider: 'google',
      refreshTokenEnc: 'x',
      scopes: [],
      expiresAtMs: null,
    });

    await db.delete(schema.user);

    expect(await listTvChannels(db, TEST_USER_ID)).toEqual([]);
    expect(await getOauthAccount(db, TEST_USER_ID, 'google')).toBeNull();
    // O cache do YouTube é compartilhado e não pertence ao usuário: sobrevive.
    expect(await listVideosByChannels(db, ['UC0001'])).toEqual([]);
  });
});
