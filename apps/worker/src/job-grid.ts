/**
 * Jobs de programação: materialização da grade e inserção a quente.
 *
 * Nenhum destes gasta cota — trabalham sobre o que a ingestão já trouxe. Toda a lógica
 * de decisão vive em `@minhatv/core`; aqui só há orquestração e persistência.
 */

import {
  applyHotInsert,
  buildGrid,
  evaluateHotInsertGate,
  gridSeed,
  localDayKey,
  startOfLocalDay,
  startOfNextLocalDay,
} from '@minhatv/core';
import {
  affinityMap,
  airHistory,
  appendPatch,
  buildPoolForChannels,
  effectiveGridConfig,
  favoriteChannelIds,
  getDayGrid,
  getUser,
  hasDayGrid,
  hotInsertTimesToday,
  listTvChannels,
  listUserIds,
  pruneScheduleHistory,
  purgeExpiredCache,
  replaceDayGrid,
  subscribedChannelIds,
  topChannels,
} from '@minhatv/db';
import {
  DEFAULT_BUDGET,
  ReportBuilder,
  type JobBudget,
  type JobDeps,
  type JobReport,
} from './types.js';
import type { AffinityMap, GridConfig, PoolVideo, TvChannelId } from '@minhatv/core';
import type { Db, TvChannelRecord } from '@minhatv/db';

/** Quantos dias à frente materializar. Hoje e amanhã bastam para o guia de 24h. */
export const MATERIALIZE_DAYS_AHEAD = 1;

/**
 * Resolve o conjunto de canais do YouTube que alimenta um canal de TV.
 *
 * A resolução por categoria e por hashtag filtra o pool **depois**, e não busca no
 * YouTube: `search.list` custaria 100 unidades por consulta. O preço é cobertura menor
 * (só o que já está no cache), e o ganho é um canal temático que não consome cota.
 */
export async function resolveSourceChannels(db: Db, channel: TvChannelRecord): Promise<string[]> {
  switch (channel.sourceKind) {
    case 'ALL_SUBSCRIPTIONS':
      return subscribedChannelIds(db, channel.userId);
    case 'TOP_WATCHED': {
      const n = Number(channel.sourceSpec['topN'] ?? 20);
      return topChannels(db, channel.userId, Number.isFinite(n) ? n : 20);
    }
    case 'FAVORITES':
      return [...(await favoriteChannelIds(db, channel.userId))];
    case 'CUSTOM': {
      const ids = channel.sourceSpec['ytChannelIds'];
      return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
    }
    case 'CATEGORY':
    case 'HASHTAG':
      // O universo é o mesmo das inscrições; o recorte vem do filtro de pool.
      return subscribedChannelIds(db, channel.userId);
  }
}

/** Aplica o recorte de categoria ou hashtag sobre um pool já montado. */
export function applySourceFilter(
  pool: readonly PoolVideo[],
  channel: TvChannelRecord,
): PoolVideo[] {
  if (channel.sourceKind === 'CATEGORY') {
    const categoryId = String(channel.sourceSpec['categoryId'] ?? '');
    return categoryId ? pool.filter((v) => v.categoryId === categoryId) : [...pool];
  }

  if (channel.sourceKind === 'HASHTAG') {
    const raw = String(channel.sourceSpec['hashtag'] ?? '').replace(/^#/, '');
    if (!raw) return [...pool];
    const needle = raw.toLowerCase();
    /*
     * Não há endpoint de hashtag na API. O casamento é por `snippet.tags` e por
     * ocorrência de `#tag` no título — aproximação assumida, e a alternativa (APIs de
     * terceiros que raspam o YouTube) violaria a proibição de scraping.
     */
    return pool.filter(
      (v) =>
        v.tags.some((t) => t.toLowerCase() === needle) ||
        v.title.toLowerCase().includes(`#${needle}`),
    );
  }

  return [...pool];
}

export interface ChannelContext {
  readonly config: GridConfig;
  readonly pool: readonly PoolVideo[];
  readonly affinity: AffinityMap;
  readonly rejected: Readonly<Record<string, number>>;
}

/** Reúne tudo que o motor de grade precisa para um canal de TV. */
export async function loadChannelContext(
  deps: JobDeps,
  channel: TvChannelRecord,
): Promise<ChannelContext | null> {
  const config = await effectiveGridConfig(deps.db, channel.id);
  if (!config) return null;

  const user = await getUser(deps.db, channel.userId);
  const sourceChannels = await resolveSourceChannels(deps.db, channel);

  const { pool, rejected } = await buildPoolForChannels(deps.db, sourceChannels, {
    region: user?.region ?? 'BR',
    minDurationSec: config.minDurationSec,
    maxDurationSec: config.maxDurationSec,
    nowMs: deps.now(),
    // Canal VOD não escala live em andamento: duração indefinida arruinaria a grade.
    excludeLive: channel.mode === 'VOD',
  });

  return {
    config,
    pool: applySourceFilter(pool, channel),
    affinity: await affinityMap(deps.db, channel.userId),
    rejected,
  };
}

/**
 * Materializa a grade de um canal para um dia, se ainda não existir.
 *
 * Só materializa o que falta: regerar um dia já materializado descartaria os patches já
 * aplicados e mudaria a programação embaixo de quem está assistindo.
 */
export async function materializeDay(
  deps: JobDeps,
  channel: TvChannelRecord,
  dayAnchorMs: number,
  ctx: ChannelContext,
): Promise<{ readonly dayKey: string; readonly slots: number; readonly skipped: boolean }> {
  const dayKey = localDayKey(dayAnchorMs, ctx.config.timeZone);

  if (await hasDayGrid(deps.db, channel.id, dayKey)) {
    return { dayKey, slots: 0, skipped: true };
  }

  const built = buildGrid({
    tvChannelId: channel.id,
    pool: ctx.pool,
    affinity: ctx.affinity,
    history: await airHistory(deps.db, channel.id, dayAnchorMs, ctx.config.rewatchWindowDays),
    config: ctx.config,
    startAtMs: startOfLocalDay(dayAnchorMs, ctx.config.timeZone),
  });

  if (built.poolExhausted && built.slots.length === 0) {
    deps.log?.('pool vazio: canal sem programação', {
      tvChannelId: channel.id,
      dayKey,
      rejected: ctx.rejected,
    });
  }

  await replaceDayGrid(deps.db, channel.id, dayKey, built.slots);
  return { dayKey, slots: built.slots.length, skipped: false };
}

/** Materializa hoje e amanhã para todos os canais de TV de todos os usuários. */
export async function materializeGrids(
  deps: JobDeps,
  budget: JobBudget = DEFAULT_BUDGET,
): Promise<JobReport> {
  const report = new ReportBuilder('materializeGrids');
  const nowMs = deps.now();
  const detalhes: Record<string, unknown>[] = [];

  const usuarios = await listUserIds(deps.db);
  for (const userId of usuarios) {
    for (const channel of await listTvChannels(deps.db, userId)) {
      if (report.processed >= budget.maxItems) {
        report.markExhausted();
        return report.build({ days: detalhes });
      }

      try {
        const ctx = await loadChannelContext(deps, channel);
        if (!ctx) {
          report.fail(channel.id, new Error('canal sem configuração'));
          continue;
        }

        let anchor = nowMs;
        for (let d = 0; d <= MATERIALIZE_DAYS_AHEAD; d++) {
          const resultado = await materializeDay(deps, channel, anchor, ctx);
          detalhes.push({ tvChannelId: channel.id, ...resultado });
          anchor = startOfNextLocalDay(anchor, ctx.config.timeZone);
        }
        report.countItem();
      } catch (err) {
        report.fail(channel.id, err);
      }
    }
  }

  report.markCompleted();
  return report.build({ days: detalhes });
}

// ---------------------------------------------------------------------------
// Inserção a quente
// ---------------------------------------------------------------------------

export interface HotInsertOutcomeSummary {
  readonly tvChannelId: TvChannelId;
  readonly videoId: string;
  readonly applied: boolean;
  readonly reason: string;
}

/**
 * Varre vídeos novos e insere na grade do dia os que passam pelo portão de relevância.
 *
 * O portão é o que impede a grade de nunca assentar: sem ele, todo upload de todo canal
 * do pool viraria uma reordenação. Só passa conteúdo de canal no top-K de afinidade, de
 * favorito, ou live começando agora.
 */
export async function hotInsertScan(
  deps: JobDeps,
  budget: JobBudget = DEFAULT_BUDGET,
): Promise<JobReport> {
  const report = new ReportBuilder('hotInsertScan');
  const nowMs = deps.now();
  const resultados: HotInsertOutcomeSummary[] = [];

  const usuarios = await listUserIds(deps.db);
  for (const userId of usuarios) {
    const favoritos = await favoriteChannelIds(deps.db, userId);

    for (const channel of await listTvChannels(deps.db, userId)) {
      if (report.processed >= budget.maxItems) {
        report.markExhausted();
        return report.build({ outcomes: resultados });
      }

      try {
        const ctx = await loadChannelContext(deps, channel);
        if (!ctx) continue;

        const dayKey = localDayKey(nowMs, ctx.config.timeZone);
        const slots = await getDayGrid(deps.db, channel.id, dayKey);
        if (slots.length === 0) continue;

        // Já escalado hoje não é novidade; o resto passa pelo portão.
        const jaNaGrade = new Set(slots.map((s) => s.videoId));
        const candidatos = ctx.pool
          .filter((v) => !jaNaGrade.has(v.id))
          .filter(
            (v) =>
              evaluateHotInsertGate({
                video: v,
                nowMs,
                affinity: ctx.affinity,
                favorites: favoritos,
                config: ctx.config,
              }).eligible,
          )
          // Mais recente primeiro: se só um couber, que seja o mais novo.
          .sort((a, b) => b.publishedAt - a.publishedAt);

        let grade = slots;
        for (const candidato of candidatos) {
          const outcome = applyHotInsert({
            slots: grade,
            newVideo: candidato,
            pool: ctx.pool,
            nowMs,
            /*
             * O seed tem de ser o mesmo que `buildGrid` usou para este dia. Recalculá-lo
             * com outra função ordenaria os candidatos de forma diferente da grade base,
             * e o replay divergiria da grade materializada — daí usar `gridSeed` do core
             * em vez de reimplementar o hash aqui.
             */
            seed: gridSeed(channel.id, dayKey),
            affinity: ctx.affinity,
            favorites: favoritos,
            history: await airHistory(deps.db, channel.id, nowMs, ctx.config.rewatchWindowDays),
            config: ctx.config,
            priorHotInsertsAtMs: await hotInsertTimesToday(
              deps.db,
              channel.id,
              nowMs,
              ctx.config.timeZone,
            ),
          });

          if (!outcome.applied) {
            resultados.push({
              tvChannelId: channel.id,
              videoId: candidato.id,
              applied: false,
              reason: outcome.reason,
            });
            // `rate_limited` e `too_soon_after_last` valem para o canal inteiro:
            // insistir com o próximo candidato daria o mesmo resultado.
            if (outcome.reason === 'rate_limited' || outcome.reason === 'too_soon_after_last') {
              break;
            }
            continue;
          }

          grade = [...outcome.slots];
          await replaceDayGrid(deps.db, channel.id, dayKey, grade);
          await appendPatch(deps.db, {
            tvChannelId: channel.id,
            dayKey,
            appliedAtMs: nowMs,
            kind: 'HOT_INSERT',
            videoId: candidato.id,
            reason: outcome.gateReason,
          });

          resultados.push({
            tvChannelId: channel.id,
            videoId: candidato.id,
            applied: true,
            reason: outcome.gateReason,
          });
          break; // Uma inserção por canal por invocação: o resto espera o intervalo.
        }

        report.countItem();
      } catch (err) {
        report.fail(channel.id, err);
      }
    }
  }

  report.markCompleted();
  return report.build({ outcomes: resultados });
}

// ---------------------------------------------------------------------------
// Manutenção
// ---------------------------------------------------------------------------

/** R3: apaga o cache que passou dos 30 dias. Rede de segurança do refresh. */
export async function purgeCache(deps: JobDeps): Promise<JobReport> {
  const report = new ReportBuilder('purgeCache');
  const resultado = await purgeExpiredCache(deps.db, deps.now());
  for (let i = 0; i < resultado.videosDeleted; i++) report.countItem();
  report.markCompleted();
  return report.build({ ...resultado });
}

/** Retenção de 60 dias do histórico de programação. */
export async function prunePrograms(deps: JobDeps): Promise<JobReport> {
  const report = new ReportBuilder('prunePrograms');
  const resultado = await pruneScheduleHistory(deps.db, deps.now());
  for (let i = 0; i < resultado.slotsDeleted; i++) report.countItem();
  report.markCompleted();
  return report.build({ ...resultado });
}
