/**
 * Jobs de ingestão: inscrições, canais e pools de vídeo.
 *
 * Todos seguem o caminho barato de R2 — `subscriptions → uploads playlist →
 * playlistItems → videos`, 1 unidade por chamada de 50 itens. `search.list` (100
 * unidades) não aparece aqui e não deve aparecer: montar pool por busca custaria 20.000
 * unidades para 200 canais, o dobro da cota diária inteira.
 */

import {
  channelsNeedingRefresh,
  chargeQuota,
  favoriteChannelIds,
  getJobCursor,
  getUploadsPlaylistIds,
  listUserIds,
  recomputeAffinity,
  setJobCursor,
  setSubscribed,
  subscribedChannelIds,
  topChannels,
  upsertChannels,
  upsertVideos,
} from '@minhatv/db';
import { QuotaExhaustedError, uploadsPlaylistIdFor, YouTubeApiError } from '@minhatv/yt';
import {
  DEFAULT_BUDGET,
  ReportBuilder,
  type JobBudget,
  type JobDeps,
  type JobReport,
} from './types.js';

/** Quantos vídeos recentes por canal entram no pool. 50 = uma página. */
export const POOL_DEPTH = 50;

/**
 * Canais "quentes" — os de maior afinidade — são atualizados a cada volta; os frios,
 * uma vez por dia. O polling em camadas é o que mantém a detecção de novidade rápida
 * sem estourar a cota.
 */
export const HOT_CHANNEL_COUNT = 20;

function requireYt(deps: JobDeps): NonNullable<JobDeps['yt']> {
  if (!deps.yt) {
    throw new Error('este job precisa do cliente da API do YouTube');
  }
  return deps.yt;
}

/**
 * Executa um trecho que consome cota, convertendo o esgotamento em sinal de retomada.
 *
 * `QuotaExhaustedError` e o `quotaExceeded` da própria API não são falhas do job: são
 * "acabou o orçamento, continue depois". Tratá-los como erro encheria o relatório de
 * ruído e esconderia os problemas reais.
 */
async function withQuotaGuard<T>(
  report: ReportBuilder,
  fn: () => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof QuotaExhaustedError) {
      report.markExhausted();
      return { ok: false };
    }
    if (err instanceof YouTubeApiError && err.isQuotaError) {
      report.markExhausted();
      return { ok: false };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Inscrições
// ---------------------------------------------------------------------------

/**
 * Sincroniza as inscrições do usuário e resolve as playlists de uploads.
 *
 * Custa 1 unidade por página de 50 inscrições, mais 1 por lote de 50 canais. Para 200
 * inscrições: 4 + 4 = 8 unidades.
 */
export async function refreshSubscriptions(
  deps: JobDeps,
  userId: string,
  budget: JobBudget = DEFAULT_BUDGET,
): Promise<JobReport> {
  const report = new ReportBuilder('refreshSubscriptions');
  const yt = requireYt(deps);
  const nowMs = deps.now();

  const subs = await withQuotaGuard(report, () => yt.listMySubscriptions());
  if (!subs.ok) return report.build();

  await chargeQuota(deps.db, nowMs, 1, 'subscriptions.list');
  report.addQuota(1);

  /*
   * Os canais entram como esboço **antes** da afinidade. `user_channel_affinity` tem FK
   * para `yt_channel`, então gravar a inscrição primeiro estoura na primeira execução de
   * um usuário novo — o canal ainda não existe.
   *
   * O esboço não custa cota (é só banco) e nasce sem playlist de uploads, o que faz
   * `channelsNeedingRefresh` já o considerar pendente de enriquecimento.
   */
  await upsertChannels(
    deps.db,
    subs.value.map((id) => ({
      id,
      title: '',
      uploadsPlaylistId: null,
      thumbnailUrl: null,
      refreshedAtMs: nowMs,
    })),
  );
  await setSubscribed(deps.db, userId, subs.value);

  const semUploads = subs.value.filter((id) => uploadsPlaylistIdFor(id) === null);
  if (semUploads.length > 0) {
    deps.log?.('ids de canal fora do padrão UC…', { count: semUploads.length });
  }

  // Enriquecimento: título, miniatura e o id de uploads vindo da própria API.
  const aBuscar = subs.value.slice(0, budget.maxItems);
  const detalhes = await withQuotaGuard(report, () => yt.listChannels(aBuscar));
  if (!detalhes.ok) return report.build({ subscriptions: subs.value.length });

  await upsertChannels(deps.db, detalhes.value);
  const lotes = Math.ceil(aBuscar.length / 50);
  await chargeQuota(deps.db, nowMs, lotes, 'channels.list');
  report.addQuota(lotes);
  for (let i = 0; i < detalhes.value.length; i++) report.countItem();

  if (aBuscar.length < subs.value.length) {
    report.markExhausted();
  } else {
    report.markCompleted();
  }

  return report.build({ subscriptions: subs.value.length });
}

// ---------------------------------------------------------------------------
// Pools de vídeo
// ---------------------------------------------------------------------------

/**
 * Ordem de atualização dos canais: quentes primeiro, depois os que venceram o prazo de
 * revalidação de R3, depois o resto.
 *
 * A prioridade não é estética: o orçamento de uma invocação raramente cobre todos os
 * canais, então quem entra na fatia decide o que fica atualizado. Canal de alta
 * afinidade desatualizado significa novidade perdida, e registro vencido significa
 * violação de política.
 */
export async function poolRefreshOrder(
  deps: JobDeps,
  userId: string,
  limit: number,
): Promise<string[]> {
  const nowMs = deps.now();
  const inscritos = await subscribedChannelIds(deps.db, userId);
  const favoritos = await favoriteChannelIds(deps.db, userId);

  /*
   * O universo do refresh são os canais **atualmente** acompanhados. A tabela de
   * afinidade guarda histórico, inclusive de canais dos quais o usuário se desinscreveu:
   * sem este recorte, o job gastaria cota para sempre atualizando canais abandonados.
   */
  const relevantes = new Set([...inscritos, ...favoritos]);
  if (relevantes.size === 0) return [];

  const quentes = await topChannels(deps.db, userId, HOT_CHANNEL_COUNT);
  const vencidos = await channelsNeedingRefresh(deps.db, nowMs, limit);

  const vistos = new Set<string>();
  const ordem: string[] = [];
  for (const id of [...quentes, ...vencidos, ...inscritos, ...favoritos]) {
    if (relevantes.has(id) && !vistos.has(id)) {
      vistos.add(id);
      ordem.push(id);
    }
  }
  return ordem.slice(0, limit);
}

/**
 * Atualiza o pool de vídeos, retomando de onde a invocação anterior parou.
 *
 * O cursor guarda o último canal processado; a próxima invocação começa depois dele.
 * Quando a lista termina, o cursor é zerado e a volta reinicia.
 */
export async function refreshPools(
  deps: JobDeps,
  userId: string,
  budget: JobBudget = DEFAULT_BUDGET,
): Promise<JobReport> {
  const report = new ReportBuilder('refreshPools');
  const yt = requireYt(deps);
  const nowMs = deps.now();
  const jobName = `refreshPools:${userId}`;

  const ordem = await poolRefreshOrder(deps, userId, 10_000);
  if (ordem.length === 0) {
    report.markCompleted();
    return report.build({ channels: 0 });
  }

  const cursor = await getJobCursor(deps.db, jobName);
  const inicio = cursor?.cursor ? ordem.indexOf(cursor.cursor) + 1 : 0;
  // Cursor apontando para canal que saiu da lista: recomeça em vez de travar.
  const desde = inicio > 0 && inicio <= ordem.length ? inicio : 0;

  const fatia = ordem.slice(desde, desde + budget.maxItems);
  const uploads = await getUploadsPlaylistIds(deps.db, fatia);

  let ultimoProcessado: string | null = null;
  const idsDeVideo: string[] = [];

  for (const ytChannelId of fatia) {
    if (report.quotaSpent >= budget.quotaUnits) {
      report.markExhausted();
      break;
    }

    const playlistId = uploads.get(ytChannelId) ?? uploadsPlaylistIdFor(ytChannelId);
    if (!playlistId) {
      report.fail(ytChannelId, new Error('sem playlist de uploads'));
      ultimoProcessado = ytChannelId;
      continue;
    }

    try {
      const resultado = await withQuotaGuard(report, () =>
        yt.listUploadIds(playlistId, { maxItems: POOL_DEPTH, background: true }),
      );
      if (!resultado.ok) break;

      idsDeVideo.push(...resultado.value);
      const paginas = Math.max(1, Math.ceil(resultado.value.length / 50));
      await chargeQuota(deps.db, nowMs, paginas, 'playlistItems.list');
      report.addQuota(paginas);
      report.countItem();
      ultimoProcessado = ytChannelId;
    } catch (err) {
      // Canal apagado ou privado não deve impedir os outros da fatia.
      report.fail(ytChannelId, err);
      ultimoProcessado = ytChannelId;
    }
  }

  if (idsDeVideo.length > 0) {
    const detalhes = await withQuotaGuard(report, () =>
      yt.listVideos(idsDeVideo, { background: true }),
    );
    if (detalhes.ok) {
      await upsertVideos(deps.db, detalhes.value);
      const lotes = Math.ceil(idsDeVideo.length / 50);
      await chargeQuota(deps.db, nowMs, lotes, 'videos.list');
      report.addQuota(lotes);
    }
  }

  const acabou = desde + fatia.length >= ordem.length && !report.build().exhausted;
  await setJobCursor(deps.db, jobName, acabou ? null : ultimoProcessado, nowMs);
  if (acabou) report.markCompleted();

  return report.build({
    channels: ordem.length,
    sliceStart: desde,
    videos: idsDeVideo.length,
  });
}

// ---------------------------------------------------------------------------
// Afinidade
// ---------------------------------------------------------------------------

/**
 * Recalcula a afinidade de todos os usuários. Não gasta cota: só lê o banco.
 *
 * Roda depois de `refreshSubscriptions`, porque o flag de inscrição é uma das três
 * fontes do score.
 */
export async function refreshAffinity(
  deps: JobDeps,
  budget: JobBudget = DEFAULT_BUDGET,
): Promise<JobReport> {
  const report = new ReportBuilder('refreshAffinity');
  const nowMs = deps.now();

  const usuarios = await listUserIds(deps.db);
  for (const userId of usuarios.slice(0, budget.maxItems)) {
    try {
      await recomputeAffinity(deps.db, userId, nowMs);
      report.countItem();
    } catch (err) {
      report.fail(userId, err);
    }
  }

  if (usuarios.length > budget.maxItems) report.markExhausted();
  else report.markCompleted();

  return report.build({ users: usuarios.length });
}
