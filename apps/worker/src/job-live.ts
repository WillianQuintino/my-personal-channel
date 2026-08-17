/**
 * Job de detecção de transmissões ao vivo.
 *
 * Pelo caminho barato: uploads playlist → `videos.list` nos mais recentes. Uma live é
 * sempre um dos uploads recentes do canal, e `snippet.liveBroadcastContent` já diz se
 * está no ar. `search.list` com `eventType=live` resolveria em uma chamada e custaria
 * 100 unidades **por canal** — checar 50 canais uma vez estouraria metade da cota.
 */

import {
  channelsDueForLiveCheck,
  channelsWithoutLiveState,
  chargeQuota,
  getUploadsPlaylistIds,
  listVideosByChannels,
  upsertLiveState,
  upsertVideos,
} from '@minhatv/db';
import {
  detectLiveState,
  LIVE_PROBE_DEPTH,
  QuotaExhaustedError,
  uploadsPlaylistIdFor,
  YouTubeApiError,
} from '@minhatv/yt';
import {
  DEFAULT_BUDGET,
  ReportBuilder,
  type JobBudget,
  type JobDeps,
  type JobReport,
} from './types.js';

/**
 * Detecta o estado de live dos canais cuja checagem venceu.
 *
 * A fila vem de `nextCheckAt`: polling dirigido em vez de varredura cega. Canais que
 * nunca foram checados entram primeiro, porque sem estado registrado o app não sabe nem
 * se o canal transmite.
 */
export async function detectLives(
  deps: JobDeps,
  budget: JobBudget = DEFAULT_BUDGET,
): Promise<JobReport> {
  const report = new ReportBuilder('detectLives');
  const nowMs = deps.now();

  if (!deps.yt) throw new Error('detectLives precisa do cliente da API do YouTube');
  const yt = deps.yt;

  const novos = await channelsWithoutLiveState(deps.db, budget.maxItems);
  const vencidos = await channelsDueForLiveCheck(
    deps.db,
    nowMs,
    Math.max(0, budget.maxItems - novos.length),
  );

  const fila = [...novos, ...vencidos];
  if (fila.length === 0) {
    report.markCompleted();
    return report.build({ queue: 0 });
  }

  const uploads = await getUploadsPlaylistIds(deps.db, fila);
  const detectados: Record<string, string> = {};

  for (const ytChannelId of fila) {
    if (report.quotaSpent >= budget.quotaUnits) {
      report.markExhausted();
      break;
    }

    const playlistId = uploads.get(ytChannelId) ?? uploadsPlaylistIdFor(ytChannelId);
    if (!playlistId) {
      report.fail(ytChannelId, new Error('sem playlist de uploads'));
      continue;
    }

    try {
      /*
       * Só os `LIVE_PROBE_DEPTH` uploads mais recentes. Aumentar a profundidade
       * multiplica o custo em `videos.list` sem ganho de detecção: uma transmissão ao
       * vivo nunca está enterrada no acervo.
       */
      const ids = await yt.listUploadIds(playlistId, {
        maxItems: LIVE_PROBE_DEPTH,
        background: true,
      });
      await chargeQuota(deps.db, nowMs, 1, 'playlistItems.list');
      report.addQuota(1);

      if (ids.length > 0) {
        const videos = await yt.listVideos(ids, { background: true });
        await upsertVideos(deps.db, videos);
        await chargeQuota(deps.db, nowMs, 1, 'videos.list');
        report.addQuota(1);
      }

      // A detecção lê do banco, não da resposta: assim o estado reflete o que a
      // aplicação de fato tem, inclusive vídeos de checagens anteriores.
      const recentes = await listVideosByChannels(deps.db, [ytChannelId], LIVE_PROBE_DEPTH);
      const state = detectLiveState(ytChannelId, recentes, { nowMs });
      await upsertLiveState(deps.db, state);

      if (state.status !== 'offline') detectados[ytChannelId] = state.status;
      report.countItem();
    } catch (err) {
      if (err instanceof QuotaExhaustedError) {
        report.markExhausted();
        break;
      }
      if (err instanceof YouTubeApiError && err.isQuotaError) {
        report.markExhausted();
        break;
      }
      /*
       * Canal removido ou com playlist inacessível: registra e segue. Sem isto, um
       * canal quebrado impediria a detecção de todos os outros da fila para sempre.
       */
      report.fail(ytChannelId, err);
    }
  }

  if (!report.build().exhausted) report.markCompleted();

  return report.build({ queue: fila.length, detected: detectados });
}
