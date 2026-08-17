/**
 * Testes do cache de vídeos contra Postgres real (PGlite).
 *
 * O foco é R3 — o prazo de 30 dias das Developer Policies — que aqui deixa de ser
 * convenção e vira asserção executável.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CACHE_MAX_AGE_DAYS, type VideoRecord } from '@minhatv/yt';
import {
  buildPoolForChannels,
  channelsNeedingRefresh,
  correctDuration,
  countExpired,
  getUploadsPlaylistIds,
  latestVideoIds,
  listUnplayableIds,
  listVideosByChannels,
  markUnplayable,
  purgeExpiredCache,
  upsertChannels,
  upsertVideos,
} from './repo-video.js';
import { createTestDb, seedChannel, seedVideo, TEST_NOW, useTestDb } from './testing.js';
import type { Db } from './client.js';

const DAY = 86_400_000;

// Um PGlite por arquivo, truncado entre testes: mesmo isolamento, uma fração do tempo.
// Criar o banco e migrar por teste levava a suíte a 90 s; assim são 12 s.
const ctx = useTestDb({ beforeAll, afterAll, beforeEach });
let db: Db;
beforeEach(() => {
  db = ctx.db;
});

function videoRecord(over: Partial<VideoRecord> = {}): VideoRecord {
  return {
    id: 'vid1',
    ytChannelId: 'UC0001',
    ytChannelTitle: '',
    title: 'Título',
    description: '',
    publishedAt: TEST_NOW - DAY,
    durationSec: 600,
    categoryId: '20',
    tags: [],
    embeddable: true,
    privacyStatus: 'public',
    uploadStatus: 'processed',
    madeForKids: false,
    blockedRegions: [],
    allowedRegions: [],
    hasContentRating: false,
    liveState: 'none',
    liveScheduledStartMs: null,
    liveActualStartMs: null,
    liveActualEndMs: null,
    thumbnailUrl: null,
    refreshedAtMs: TEST_NOW,
    ...over,
  };
}

describe('migrations', () => {
  it('aplicam em banco vazio e deixam o schema utilizável', async () => {
    // Se as migrations não aplicassem, qualquer consulta abaixo estouraria.
    expect(await listVideosByChannels(db, [])).toEqual([]);
    expect(await countExpired(db, TEST_NOW)).toBe(0);
  });

  it('podem ser aplicadas em bancos independentes sem interferência', async () => {
    const outro = await createTestDb();
    await seedChannel(outro.db, { id: 'UCoutro' });
    // O primeiro banco não vê nada do segundo.
    expect(await getUploadsPlaylistIds(db, ['UCoutro'])).toEqual(new Map());
    await outro.close();
  });
});

describe('upsert de canais', () => {
  it('insere e depois atualiza sem duplicar', async () => {
    await upsertChannels(db, [
      {
        id: 'UC1',
        title: 'Antes',
        uploadsPlaylistId: 'UU1',
        thumbnailUrl: null,
        refreshedAtMs: TEST_NOW,
      },
    ]);
    await upsertChannels(db, [
      {
        id: 'UC1',
        title: 'Depois',
        uploadsPlaylistId: 'UU1',
        thumbnailUrl: 'x',
        refreshedAtMs: TEST_NOW + 1000,
      },
    ]);

    const map = await getUploadsPlaylistIds(db, ['UC1']);
    expect(map.get('UC1')).toBe('UU1');
    expect(await channelsNeedingRefresh(db, TEST_NOW, 10)).toEqual([]);
  });

  it('lista vazia é no-op', async () => {
    expect(await upsertChannels(db, [])).toBe(0);
  });

  it('canal sem playlist de uploads é candidato a refresh', async () => {
    // Sem a playlist o canal não rende pool nenhum, então tem prioridade.
    await seedChannel(db, { id: 'UCsemUploads', uploadsPlaylistId: null });
    expect(await channelsNeedingRefresh(db, TEST_NOW, 10)).toEqual(['UCsemUploads']);
  });

  it('canal vencido entra na fila de refresh, em ordem de urgência', async () => {
    await seedChannel(db, { id: 'UCrecente', refreshedAtMs: TEST_NOW - 1 * DAY });
    await seedChannel(db, { id: 'UCvelho', refreshedAtMs: TEST_NOW - 28 * DAY });
    await seedChannel(db, { id: 'UCmedio', refreshedAtMs: TEST_NOW - 26 * DAY });

    // Só os que passaram de 25 dias, do mais atrasado para o menos.
    expect(await channelsNeedingRefresh(db, TEST_NOW, 10)).toEqual(['UCvelho', 'UCmedio']);
  });

  it('respeita o limite da fatia', async () => {
    for (let i = 0; i < 5; i++) {
      await seedChannel(db, { id: `UCv${i}`, refreshedAtMs: TEST_NOW - 27 * DAY });
    }
    expect(await channelsNeedingRefresh(db, TEST_NOW, 2)).toHaveLength(2);
  });
});

describe('upsert de vídeos', () => {
  beforeEach(async () => {
    await seedChannel(db, { id: 'UC0001' });
  });

  it('grava e relê os campos de R13', async () => {
    await upsertVideos(db, [
      videoRecord({
        id: 'v1',
        blockedRegions: ['BR', 'PT'],
        allowedRegions: ['US'],
        tags: ['minecraft'],
        hasContentRating: true,
      }),
    ]);

    const [rec] = await listVideosByChannels(db, ['UC0001']);
    expect(rec).toMatchObject({
      id: 'v1',
      blockedRegions: ['BR', 'PT'],
      allowedRegions: ['US'],
      tags: ['minecraft'],
      hasContentRating: true,
      embeddable: true,
    });
  });

  it('preserva duração nula de live em andamento', async () => {
    // Guardar zero em vez de nulo criaria slot de duração zero e laço de troca.
    await upsertVideos(db, [videoRecord({ id: 'vlive', durationSec: null, liveState: 'live' })]);
    const [rec] = await listVideosByChannels(db, ['UC0001']);
    expect(rec?.durationSec).toBeNull();
    expect(rec?.liveState).toBe('live');
  });

  it('atualiza metadados no conflito', async () => {
    await upsertVideos(db, [videoRecord({ id: 'v1', title: 'Antes' })]);
    await upsertVideos(db, [videoRecord({ id: 'v1', title: 'Depois', durationSec: 900 })]);

    const rows = await listVideosByChannels(db, ['UC0001']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Depois', durationSec: 900 });
  });

  it('preserva horários de transmissão', async () => {
    await upsertVideos(db, [
      videoRecord({
        id: 'vlive',
        liveState: 'live',
        liveActualStartMs: TEST_NOW - 3_600_000,
        liveScheduledStartMs: TEST_NOW - 3_660_000,
      }),
    ]);
    const [rec] = await listVideosByChannels(db, ['UC0001']);
    expect(rec?.liveActualStartMs).toBe(TEST_NOW - 3_600_000);
    expect(rec?.liveActualEndMs).toBeNull();
  });

  it('ordena do mais recente para o mais antigo', async () => {
    await upsertVideos(db, [
      videoRecord({ id: 'velho', publishedAt: TEST_NOW - 10 * DAY }),
      videoRecord({ id: 'novo', publishedAt: TEST_NOW - 1 * DAY }),
      videoRecord({ id: 'medio', publishedAt: TEST_NOW - 5 * DAY }),
    ]);
    expect((await listVideosByChannels(db, ['UC0001'])).map((v) => v.id)).toEqual([
      'novo',
      'medio',
      'velho',
    ]);
  });

  it('lista vazia é no-op', async () => {
    expect(await upsertVideos(db, [])).toBe(0);
    expect(await listVideosByChannels(db, [])).toEqual([]);
  });
});

describe('memória de vídeo injogável', () => {
  beforeEach(async () => {
    await seedChannel(db, { id: 'UC0001' });
    await upsertVideos(db, [videoRecord({ id: 'v1' })]);
  });

  it('marca e lista', async () => {
    await markUnplayable(db, 'v1', 150, 'embed desabilitado', TEST_NOW);
    expect(await listUnplayableIds(db)).toEqual(new Set(['v1']));
  });

  it('a marca sobrevive a um refresh que traz o vídeo como normal', async () => {
    /*
     * Este é o ponto do teste, e a razão de `unplayableAt` ficar fora do `set` do
     * upsert: a API costuma reportar `embeddable: true` para vídeos que na prática
     * devolvem erro 150. Sobrescrever a marca faria o mesmo vídeo quebrado voltar à
     * grade amanhã, e o usuário veria a mesma falha de novo.
     */
    await markUnplayable(db, 'v1', 150, 'embed desabilitado', TEST_NOW);
    await upsertVideos(db, [videoRecord({ id: 'v1', embeddable: true, title: 'Atualizado' })]);

    expect(await listUnplayableIds(db)).toEqual(new Set(['v1']));
    const [rec] = await listVideosByChannels(db, ['UC0001']);
    expect(rec?.title).toBe('Atualizado');
  });

  it('sem marcas, o conjunto é vazio', async () => {
    expect(await listUnplayableIds(db)).toEqual(new Set());
  });
});

describe('correção de duração', () => {
  it('grava a duração real reportada pelo player', async () => {
    await seedChannel(db, { id: 'UC0001' });
    await upsertVideos(db, [videoRecord({ id: 'v1', durationSec: 600 })]);

    await correctDuration(db, 'v1', 637);

    const [rec] = await listVideosByChannels(db, ['UC0001']);
    expect(rec?.durationSec).toBe(637);
  });
});

describe('latestVideoIds', () => {
  it('devolve os mais recentes, limitados pela profundidade', async () => {
    await seedChannel(db, { id: 'UC0001' });
    for (let i = 0; i < 20; i++) {
      await seedVideo(db, { id: `v${i}`, ytChannelId: 'UC0001', ageDays: i + 1 });
    }
    const ids = await latestVideoIds(db, 'UC0001', 10);
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe('v0');
    expect(ids[9]).toBe('v9');
  });
});

describe('montagem de pool', () => {
  beforeEach(async () => {
    await seedChannel(db, { id: 'UC0001' });
  });

  it('aplica R13 e relata os motivos de recusa', async () => {
    await seedVideo(db, { id: 'ok', ytChannelId: 'UC0001' });
    await seedVideo(db, { id: 'sem-embed', ytChannelId: 'UC0001', embeddable: false });
    await seedVideo(db, { id: 'privado', ytChannelId: 'UC0001', privacyStatus: 'private' });
    await seedVideo(db, { id: 'short', ytChannelId: 'UC0001', durationSec: 30 });
    await seedVideo(db, { id: 'bloqueado', ytChannelId: 'UC0001', blockedRegions: ['BR'] });

    const { pool, rejected } = await buildPoolForChannels(db, ['UC0001'], {
      region: 'BR',
      minDurationSec: 60,
      maxDurationSec: 0,
      nowMs: TEST_NOW,
    });

    expect(pool.map((v) => v.id)).toEqual(['ok']);
    expect(rejected).toEqual({
      not_embeddable: 1,
      not_public: 1,
      too_short: 1,
      region_blocked: 1,
    });
  });

  it('exclui automaticamente os vídeos já marcados como injogáveis', async () => {
    await seedVideo(db, { id: 'bom', ytChannelId: 'UC0001' });
    await seedVideo(db, { id: 'ruim', ytChannelId: 'UC0001' });
    await markUnplayable(db, 'ruim', 150, 'embed', TEST_NOW);

    const { pool, rejected } = await buildPoolForChannels(db, ['UC0001'], {
      region: 'BR',
      minDurationSec: 60,
      maxDurationSec: 0,
      nowMs: TEST_NOW,
    });

    expect(pool.map((v) => v.id)).toEqual(['bom']);
    expect(rejected['marked_unplayable']).toBe(1);
  });

  it('pool vazio quando não há canal', async () => {
    const result = await buildPoolForChannels(db, [], {
      region: 'BR',
      minDurationSec: 60,
      maxDurationSec: 0,
      nowMs: TEST_NOW,
    });
    expect(result).toEqual({ pool: [], rejected: {} });
  });
});

describe('R3 — purga dos 30 dias', () => {
  beforeEach(async () => {
    await seedChannel(db, { id: 'UC0001' });
  });

  it('apaga o que passou do prazo e mantém o que está dentro', async () => {
    await seedVideo(db, { id: 'novo', ytChannelId: 'UC0001', refreshedAtMs: TEST_NOW - 10 * DAY });
    await seedVideo(db, {
      id: 'limite',
      ytChannelId: 'UC0001',
      refreshedAtMs: TEST_NOW - 26 * DAY,
    });
    await seedVideo(db, {
      id: 'vencido',
      ytChannelId: 'UC0001',
      refreshedAtMs: TEST_NOW - 40 * DAY,
    });

    const report = await purgeExpiredCache(db, TEST_NOW);

    expect(report.videosDeleted).toBe(1);
    const restantes = (await listVideosByChannels(db, ['UC0001'])).map((v) => v.id);
    expect(restantes.sort()).toEqual(['limite', 'novo']);
  });

  it('depois da purga, nada sobrevive além de 30 dias', async () => {
    /*
     * A asserção que traduz a exigência contratual: as Developer Policies obrigam a
     * apagar ou revalidar em 30 dias corridos, e `countExpired` é a auditoria disso.
     */
    for (const dias of [1, 10, 26, 30, 31, 45, 120]) {
      await seedVideo(db, {
        id: `v${dias}`,
        ytChannelId: 'UC0001',
        refreshedAtMs: TEST_NOW - dias * DAY,
      });
    }

    expect(await countExpired(db, TEST_NOW)).toBeGreaterThan(0);
    await purgeExpiredCache(db, TEST_NOW);
    expect(await countExpired(db, TEST_NOW)).toBe(0);
  });

  it('o corte fica exatamente em 30 dias', async () => {
    await seedVideo(db, {
      id: 'quase',
      ytChannelId: 'UC0001',
      refreshedAtMs: TEST_NOW - (CACHE_MAX_AGE_DAYS * DAY - 60_000),
    });
    await seedVideo(db, {
      id: 'no-limite',
      ytChannelId: 'UC0001',
      refreshedAtMs: TEST_NOW - CACHE_MAX_AGE_DAYS * DAY,
    });

    await purgeExpiredCache(db, TEST_NOW);

    expect((await listVideosByChannels(db, ['UC0001'])).map((v) => v.id)).toEqual(['quase']);
  });

  it('é idempotente: rodar de novo não apaga mais nada', async () => {
    await seedVideo(db, {
      id: 'vencido',
      ytChannelId: 'UC0001',
      refreshedAtMs: TEST_NOW - 40 * DAY,
    });

    expect((await purgeExpiredCache(db, TEST_NOW)).videosDeleted).toBe(1);
    expect((await purgeExpiredCache(db, TEST_NOW)).videosDeleted).toBe(0);
  });

  it('não apaga canal que ainda tem vídeo dentro do prazo', async () => {
    /*
     * A FK é `on delete cascade`: apagar um canal vencido que ainda tem vídeos vivos
     * levaria vídeos dentro do prazo junto — perda de dados disfarçada de conformidade.
     */
    await seedChannel(db, { id: 'UCvencido', refreshedAtMs: TEST_NOW - 40 * DAY });
    await seedVideo(db, { id: 'vivo', ytChannelId: 'UCvencido', refreshedAtMs: TEST_NOW });

    const report = await purgeExpiredCache(db, TEST_NOW);

    expect(report.channelsDeleted).toBe(0);
    expect(await listVideosByChannels(db, ['UCvencido'])).toHaveLength(1);
  });

  it('apaga canal vencido sem vídeos', async () => {
    await seedChannel(db, { id: 'UCorfao', refreshedAtMs: TEST_NOW - 40 * DAY });
    expect((await purgeExpiredCache(db, TEST_NOW)).channelsDeleted).toBe(1);
  });

  it('banco vazio não gera erro', async () => {
    const report = await purgeExpiredCache(db, TEST_NOW);
    expect(report).toMatchObject({ videosDeleted: 0, channelsDeleted: 0 });
  });
});
