/**
 * Testes da grade persistida e do log de patches.
 *
 * O teste de ponta a ponta ao final é o que importa mais: prova que `yt` (com
 * transporte falso), `db` (PGlite) e `core` (motor de grade) se encaixam sem rede
 * nenhuma — desde a resposta da API até o offset que o player recebe.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildGrid,
  computeTuneIn,
  dropUnplayable,
  localDayKey,
  recencyBucket,
  RelaxLevel,
  replayPatches,
  startOfLocalDay,
} from '@minhatv/core';
import { QuotaLedger, YouTubeClient } from '@minhatv/yt';
import { rawPlaylistItem, rawSubscription, rawVideo } from '@minhatv/yt/fixtures';
import {
  airHistory,
  appendPatch,
  getDayGrid,
  hasDayGrid,
  hotInsertTimesToday,
  listPatches,
  pruneScheduleHistory,
  replaceDayGrid,
  SCHEDULE_HISTORY_DAYS,
  slotAt,
  slotsInWindow,
} from './repo-schedule.js';
import {
  buildPoolForChannels,
  listVideosByChannels,
  upsertChannels,
  upsertVideos,
} from './repo-video.js';
import { affinityMap, setSubscribed, recomputeAffinity } from './repo-affinity.js';
import { effectiveGridConfig } from './repo-ops.js';
import { seedPool, seedTvChannel, seedUser, TEST_NOW, TEST_USER_ID, useTestDb } from './testing.js';
import { schema } from './client.js';
import type { Db } from './client.js';
import type { ScheduleSlot } from '@minhatv/core';

const DAY = 86_400_000;
const TZ = 'America/Sao_Paulo';
const DAY_START = startOfLocalDay(TEST_NOW, TZ);
const DAY_KEY = localDayKey(TEST_NOW, TZ);

const ctx = useTestDb({ beforeAll, afterAll, beforeEach });
let db: Db;
beforeEach(async () => {
  db = ctx.db;
  await seedUser(db);
  await seedTvChannel(db, { id: 'tv-tudo' });
});

function slot(over: Partial<ScheduleSlot> & Pick<ScheduleSlot, 'seq'>): ScheduleSlot {
  const startsAtMs = over.startsAtMs ?? DAY_START + over.seq * 600_000;
  return {
    videoId: `v${over.seq}`,
    ytChannelId: `UC${over.seq}`,
    startsAtMs,
    endsAtMs: startsAtMs + 600_000,
    durationSec: 600,
    relaxedTo: RelaxLevel.Strict,
    isHotInsert: false,
    ...over,
  };
}

function grade(n: number): ScheduleSlot[] {
  return Array.from({ length: n }, (_, i) => slot({ seq: i }));
}

describe('grade persistida', () => {
  it('grava e relê preservando todos os campos', async () => {
    const slots = [
      slot({ seq: 0, relaxedTo: RelaxLevel.Distance2, isHotInsert: true }),
      slot({ seq: 1, truncated: true }),
    ];
    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, slots);

    const lidos = await getDayGrid(db, 'tv-tudo', DAY_KEY);
    expect(lidos).toHaveLength(2);
    expect(lidos[0]).toMatchObject({
      seq: 0,
      relaxedTo: RelaxLevel.Distance2,
      isHotInsert: true,
    });
    expect(lidos[1]?.truncated).toBe(true);
    expect(lidos[0]?.truncated).toBeUndefined();
  });

  it('substitui o dia inteiro, sem deixar resto do anterior', async () => {
    /*
     * Substituir em transação, e não fazer diff slot a slot: o re-fluxo pode mudar
     * toda a cauda de uma vez, e um diff parcial que falhasse no meio deixaria a grade
     * com buraco ou sobreposição.
     */
    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, grade(10));
    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, grade(3));

    const lidos = await getDayGrid(db, 'tv-tudo', DAY_KEY);
    expect(lidos.map((s) => s.seq)).toEqual([0, 1, 2]);
  });

  it('grade vazia apaga o dia', async () => {
    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, grade(5));
    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, []);
    expect(await getDayGrid(db, 'tv-tudo', DAY_KEY)).toEqual([]);
    expect(await hasDayGrid(db, 'tv-tudo', DAY_KEY)).toBe(false);
  });

  it('hasDayGrid distingue dia materializado de dia vazio', async () => {
    expect(await hasDayGrid(db, 'tv-tudo', DAY_KEY)).toBe(false);
    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, grade(1));
    expect(await hasDayGrid(db, 'tv-tudo', DAY_KEY)).toBe(true);
  });

  it('dias diferentes não se misturam', async () => {
    const amanha = localDayKey(TEST_NOW + DAY, TZ);
    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, grade(3));
    await replaceDayGrid(db, 'tv-tudo', amanha, grade(5));

    expect(await getDayGrid(db, 'tv-tudo', DAY_KEY)).toHaveLength(3);
    expect(await getDayGrid(db, 'tv-tudo', amanha)).toHaveLength(5);
  });
});

describe('slotAt', () => {
  beforeEach(async () => {
    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, grade(144));
  });

  it('acha o slot no ar', async () => {
    const s = await slotAt(db, 'tv-tudo', DAY_START + 90 * 60_000);
    expect(s?.seq).toBe(9);
  });

  it('o início pertence ao slot; o fim, ao seguinte', async () => {
    expect((await slotAt(db, 'tv-tudo', DAY_START + 600_000))?.seq).toBe(1);
    expect((await slotAt(db, 'tv-tudo', DAY_START + 600_000 - 1))?.seq).toBe(0);
  });

  it('devolve null fora da cobertura', async () => {
    expect(await slotAt(db, 'tv-tudo', DAY_START - 1)).toBeNull();
    expect(await slotAt(db, 'tv-tudo', DAY_START + 200 * 600_000)).toBeNull();
  });

  it('encontra slot que atravessa a meia-noite', async () => {
    /*
     * A consulta é por janela e não por `dayKey` justamente por isto: filtrar pelo dia
     * perderia o slot a cavalo na virada, e o canal ficaria "fora do ar" à meia-noite.
     */
    const virada = DAY_START + 24 * 3_600_000;
    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, [
      slot({ seq: 0, startsAtMs: virada - 300_000 }), // começa 5 min antes, termina depois
    ]);

    const s = await slotAt(db, 'tv-tudo', virada + 60_000);
    expect(s?.seq).toBe(0);
  });
});

describe('slotsInWindow', () => {
  it('devolve os slots que se sobrepõem à janela, agrupados por canal', async () => {
    await seedTvChannel(db, { id: 'tv-2', number: 2 });
    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, grade(10));
    await replaceDayGrid(db, 'tv-2', DAY_KEY, grade(10));

    const janela = await slotsInWindow(
      db,
      ['tv-tudo', 'tv-2'],
      DAY_START + 25 * 60_000,
      DAY_START + 45 * 60_000,
    );

    // Slots 2, 3 e 4 se sobrepõem à janela de 25–45 min.
    expect(janela.get('tv-tudo')?.map((s) => s.seq)).toEqual([2, 3, 4]);
    expect(janela.get('tv-2')?.map((s) => s.seq)).toEqual([2, 3, 4]);
  });

  it('lista vazia devolve mapa vazio', async () => {
    expect(await slotsInWindow(db, [], DAY_START, DAY_START + DAY)).toEqual(new Map());
  });
});

describe('histórico para as regras de não-repetição', () => {
  it('reúne os vídeos exibidos na janela', async () => {
    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, [
      slot({ seq: 0, videoId: 'antigo', startsAtMs: TEST_NOW - 20 * DAY }),
      slot({ seq: 1, videoId: 'recente', startsAtMs: TEST_NOW - 2 * DAY }),
      slot({ seq: 2, videoId: 'futuro', startsAtMs: TEST_NOW + DAY }),
    ]);

    const { airedVideoIds } = await airHistory(db, 'tv-tudo', TEST_NOW, 14);

    // Fora da janela e ainda-não-exibido não contam.
    expect(airedVideoIds).toEqual(new Set(['recente']));
  });

  it('janela zero não considera nada', async () => {
    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, [
      slot({ seq: 0, videoId: 'v', startsAtMs: TEST_NOW - 3_600_000 }),
    ]);
    expect((await airHistory(db, 'tv-tudo', TEST_NOW, 0)).airedVideoIds.size).toBe(0);
  });
});

describe('retenção de 60 dias', () => {
  it('apaga slots e patches antigos, preservando os recentes', async () => {
    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, [
      slot({ seq: 0, startsAtMs: TEST_NOW - 90 * DAY }),
      slot({ seq: 1, startsAtMs: TEST_NOW - 10 * DAY }),
    ]);
    await appendPatch(db, {
      tvChannelId: 'tv-tudo',
      dayKey: DAY_KEY,
      appliedAtMs: TEST_NOW - 90 * DAY,
      kind: 'HOT_INSERT',
      videoId: 'v',
      reason: 'antigo',
    });

    const report = await pruneScheduleHistory(db, TEST_NOW);

    expect(report.slotsDeleted).toBe(1);
    expect(report.patchesDeleted).toBe(1);
    expect(await getDayGrid(db, 'tv-tudo', DAY_KEY)).toHaveLength(1);
  });

  it('o corte respeita a constante de retenção', async () => {
    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, [
      slot({ seq: 0, startsAtMs: TEST_NOW - (SCHEDULE_HISTORY_DAYS - 1) * DAY }),
      slot({ seq: 1, startsAtMs: TEST_NOW - (SCHEDULE_HISTORY_DAYS + 1) * DAY }),
    ]);
    const report = await pruneScheduleHistory(db, TEST_NOW);
    expect(report.slotsDeleted).toBe(1);
  });

  it('é idempotente', async () => {
    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, [
      slot({ seq: 0, startsAtMs: TEST_NOW - 90 * DAY }),
    ]);
    expect((await pruneScheduleHistory(db, TEST_NOW)).slotsDeleted).toBe(1);
    expect((await pruneScheduleHistory(db, TEST_NOW)).slotsDeleted).toBe(0);
  });
});

describe('log de patches', () => {
  const base = { tvChannelId: 'tv-tudo', dayKey: DAY_KEY, reason: '' } as const;

  it('atribui seqNo sequencial começando em 1', async () => {
    const a = await appendPatch(db, {
      ...base,
      appliedAtMs: TEST_NOW,
      kind: 'HOT_INSERT',
      videoId: 'v1',
    });
    const b = await appendPatch(db, {
      ...base,
      appliedAtMs: TEST_NOW + 1000,
      kind: 'DROP_UNPLAYABLE',
      videoId: 'v2',
    });

    expect([a, b]).toEqual([1, 2]);
  });

  it('a sequência é por canal e por dia', async () => {
    await seedTvChannel(db, { id: 'tv-2', number: 2 });
    const amanha = localDayKey(TEST_NOW + DAY, TZ);

    const a = await appendPatch(db, {
      ...base,
      appliedAtMs: TEST_NOW,
      kind: 'HOT_INSERT',
      videoId: 'v',
    });
    const b = await appendPatch(db, {
      ...base,
      tvChannelId: 'tv-2',
      appliedAtMs: TEST_NOW,
      kind: 'HOT_INSERT',
      videoId: 'v',
    });
    const c = await appendPatch(db, {
      ...base,
      dayKey: amanha,
      appliedAtMs: TEST_NOW + DAY,
      kind: 'HOT_INSERT',
      videoId: 'v',
    });

    // Cada combinação começa a própria contagem.
    expect([a, b, c]).toEqual([1, 1, 1]);
  });

  it('devolve os patches em ordem de seqNo', async () => {
    for (let i = 0; i < 5; i++) {
      await appendPatch(db, {
        ...base,
        appliedAtMs: TEST_NOW + i * 60_000,
        kind: 'HOT_INSERT',
        videoId: `v${i}`,
      });
    }
    const patches = await listPatches(db, 'tv-tudo', DAY_KEY);
    expect(patches.map((p) => p.seqNo)).toEqual([1, 2, 3, 4, 5]);
    expect(patches.map((p) => p.videoId)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4']);
  });

  it('conta as inserções a quente do dia para os limites anti-turbulência', async () => {
    await appendPatch(db, { ...base, appliedAtMs: TEST_NOW, kind: 'HOT_INSERT', videoId: 'a' });
    await appendPatch(db, {
      ...base,
      appliedAtMs: TEST_NOW + 60_000,
      kind: 'DROP_UNPLAYABLE',
      videoId: 'b',
    });
    await appendPatch(db, {
      ...base,
      appliedAtMs: TEST_NOW + 120_000,
      kind: 'HOT_INSERT',
      videoId: 'c',
    });

    const tempos = await hotInsertTimesToday(db, 'tv-tudo', TEST_NOW, TZ);
    // Só HOT_INSERT conta; o descarte de injogável não gasta o orçamento de inserções.
    expect(tempos).toHaveLength(2);
    expect(Math.max(...tempos)).toBe(TEST_NOW + 120_000);
  });

  it('o replay do log reproduz a grade materializada', async () => {
    /*
     * A propriedade central: `base(seed) + patches em ordem` reconstrói exatamente o
     * que está no banco. É o que permite a um dispositivo que ficou offline recuperar a
     * programação baixando só os patches que perdeu.
     */
    await seedPool(db, 200, 1, 600);
    const config = (await effectiveGridConfig(db, 'tv-tudo'))!;
    const { pool } = await buildPoolForChannels(db, await todosOsCanais(db), {
      region: 'BR',
      minDurationSec: 60,
      maxDurationSec: 0,
      nowMs: TEST_NOW,
    });

    const baseGrid = buildGrid({
      tvChannelId: 'tv-tudo',
      pool,
      affinity: new Map(pool.map((v) => [v.ytChannelId, 0.5])),
      history: { airedVideoIds: new Set() },
      config,
      startAtMs: DAY_START,
    });

    const alvo = baseGrid.slots.find((s) => s.startsAtMs > TEST_NOW)!;
    const derrubado = dropUnplayable({
      slots: baseGrid.slots,
      unplayableVideoId: alvo.videoId,
      pool,
      nowMs: TEST_NOW,
      seed: baseGrid.seed,
      affinity: new Map(pool.map((v) => [v.ytChannelId, 0.5])),
      history: { airedVideoIds: new Set() },
      config,
    });

    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, derrubado.slots);
    await appendPatch(db, {
      ...base,
      appliedAtMs: TEST_NOW,
      kind: 'DROP_UNPLAYABLE',
      videoId: alvo.videoId,
      reason: 'erro 150',
    });

    // Reconstrução a partir da base e do log lido do banco.
    const reconstruido = replayPatches({
      base: baseGrid,
      patches: await listPatches(db, 'tv-tudo', DAY_KEY),
      pool,
      affinity: new Map(pool.map((v) => [v.ytChannelId, 0.5])),
      favorites: new Set(),
      history: { airedVideoIds: new Set() },
      config,
    });

    const materializado = await getDayGrid(db, 'tv-tudo', DAY_KEY);
    expect(reconstruido.slots.map((s) => s.videoId)).toEqual(materializado.map((s) => s.videoId));
  });
});

describe('ponta a ponta, sem rede', () => {
  it('resposta da API → banco → grade → offset do player', async () => {
    /*
     * Prova que as quatro camadas se encaixam: transporte falso do `yt`, PGlite,
     * motor de grade e sintonização. Se este teste passa, o caminho crítico do produto
     * funciona sem nunca tocar a rede.
     */
    /*
     * Vinte canais, não três: um pool pequeno esgota antes de cobrir 24 h (a reciclagem
     * tem teto), a grade termina de manhã e sintonizar ao meio-dia daria "fora do ar".
     * 20 canais × 1 vídeo de 10 min, com reciclagem, cobrem o dia inteiro.
     */
    const canais = Array.from({ length: 20 }, (_, i) => `UCcanal${String(i).padStart(3, '0')}`);

    // 1. Ingestão pelo caminho barato, com transporte falso.
    const respostas: unknown[] = [
      { items: canais.map(rawSubscription) },
      ...canais.map((id) => ({ items: [rawPlaylistItem(`vid-${id}`)] })),
      {
        items: canais.map((id, i) =>
          rawVideo({
            id: `vid-${id}`,
            channelId: id,
            duration: 'PT10M',
            // Idades escalonadas de 6 h: buckets de recência distintos, para R-A ter o
            // que ordenar de forma inequívoca.
            publishedAt: new Date(TEST_NOW - (i + 1) * 6 * 3_600_000).toISOString(),
          }),
        ),
      },
    ];
    let i = 0;
    const client = new YouTubeClient({
      credentials: { accessToken: 'token-falso' },
      ledger: new QuotaLedger(TEST_NOW),
      transport: async () => {
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

    const inscritos = await client.listMySubscriptions();
    expect(inscritos).toEqual(canais);

    await upsertChannels(
      db,
      inscritos.map((id) => ({
        id,
        title: `Canal ${id}`,
        uploadsPlaylistId: `UU${id.slice(2)}`,
        thumbnailUrl: null,
        refreshedAtMs: TEST_NOW,
      })),
    );
    await setSubscribed(db, TEST_USER_ID, inscritos);

    const videoIds: string[] = [];
    for (const id of inscritos) {
      videoIds.push(...(await client.listUploadIds(`UU${id.slice(2)}`)));
    }
    await upsertVideos(db, await client.listVideos(videoIds));

    /*
     * A cota gasta é a prova numérica de R2: 1 (subs) + 20 (uploads, 1 por canal) +
     * 1 (videos, um lote de 50 ids) = 22 unidades. Pelo caminho de `search.list` seriam
     * 2.000 — um quinto da cota diária inteira para vinte canais.
     */
    expect(client.ledger.snapshot(TEST_NOW).spent).toBe(22);

    // 2. Afinidade e pool.
    await recomputeAffinity(db, TEST_USER_ID, TEST_NOW);
    const config = (await effectiveGridConfig(db, 'tv-tudo'))!;
    const { pool, rejected } = await buildPoolForChannels(db, inscritos, {
      region: 'BR',
      minDurationSec: 60,
      maxDurationSec: 0,
      nowMs: TEST_NOW,
    });

    expect(rejected).toEqual({});
    expect(pool).toHaveLength(20);

    // 3. Grade materializada.
    const built = buildGrid({
      tvChannelId: 'tv-tudo',
      pool,
      affinity: await affinityMap(db, TEST_USER_ID),
      history: await airHistory(db, 'tv-tudo', TEST_NOW, config.rewatchWindowDays),
      config,
      startAtMs: DAY_START,
    });
    await replaceDayGrid(db, 'tv-tudo', DAY_KEY, built.slots);

    // 4. Sintonização: o que o player receberia agora.
    const slots = await getDayGrid(db, 'tv-tudo', DAY_KEY);
    const tune = computeTuneIn(slots, TEST_NOW);

    expect(tune).not.toBeNull();
    expect(tune!.startSeconds).toBeGreaterThanOrEqual(0);
    expect(tune!.startSeconds).toBeLessThan(tune!.slot.durationSec);
    expect(videoIds).toContain(tune!.slot.videoId);

    // O slot no ar contém de fato o instante atual.
    const noAr = await slotAt(db, 'tv-tudo', TEST_NOW);
    expect(noAr?.videoId).toBe(tune!.slot.videoId);

    // A grade cobre as 24 h pedidas, então sintonizar a qualquer hora funciona.
    expect(slots[slots.length - 1]!.endsAtMs).toBeGreaterThanOrEqual(DAY_START + 24 * 3_600_000);

    /*
     * E R-A valeu ao longo da grade inteira: os buckets de recência são monotonicamente
     * não-decrescentes. Asseverar "o vídeo X abre a grade" seria especificar demais —
     * dentro de um mesmo bucket de 6 h a ordem vem do jitter, de propósito, para a
     * programação variar entre dias.
     */
    const publishedById = new Map(
      (await listVideosByChannels(db, inscritos)).map((v) => [v.id, v.publishedAt]),
    );

    /*
     * A verificação é sobre a **primeira volta** do pool. Cobrir 24 h com 20 vídeos
     * exige reciclagem, e cada volta reinicia a ordenação do mais recente — então o
     * bucket cai de novo a zero na virada da volta. Isso é o comportamento correto:
     * R-A ordena candidatos disponíveis, e reciclar repõe todos eles.
     */
    const primeiraVolta = slots.slice(0, pool.length);
    const buckets = primeiraVolta.map((sl) =>
      recencyBucket(publishedById.get(sl.videoId)!, DAY_START, config.recencyBucketHours),
    );
    for (let k = 1; k < buckets.length; k++) {
      expect(buckets[k]!).toBeGreaterThanOrEqual(buckets[k - 1]!);
    }
    // A primeira volta usa cada vídeo do pool uma única vez.
    expect(new Set(primeiraVolta.map((sl) => sl.videoId)).size).toBe(pool.length);

    // R-B: nenhum canal do YouTube se repete na primeira volta.
    const canaisDaVolta = primeiraVolta.map((sl) => sl.ytChannelId);
    expect(new Set(canaisDaVolta).size).toBe(canaisDaVolta.length);
  });
});

/** Todos os canais do YouTube conhecidos pelo banco. */
async function todosOsCanais(database: Db): Promise<string[]> {
  const rows = await database.select({ id: schema.ytChannel.id }).from(schema.ytChannel);
  return rows.map((r) => r.id);
}
