/**
 * Repositório de vídeos e canais do YouTube — o cache sujeito a R3.
 *
 * Reaproveita `CACHE_MAX_AGE_DAYS`/`CACHE_REFRESH_AFTER_DAYS` e `buildPool` de
 * `@minhatv/yt`, para que a regra dos 30 dias tenha uma definição só no projeto.
 */

import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  buildPool,
  CACHE_MAX_AGE_DAYS,
  CACHE_REFRESH_AFTER_DAYS,
  type ChannelRecord,
  type EligibilityOptions,
  type PoolBuildResult,
  type VideoRecord,
} from '@minhatv/yt';
import type { Db } from './client.js';
import { schema } from './client.js';

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Conversão entre linha e registro
// ---------------------------------------------------------------------------

type VideoRow = typeof schema.ytVideo.$inferSelect;

/**
 * Linha → `VideoRecord`.
 *
 * O motor trabalha com epoch ms e o banco com `timestamptz`; a conversão acontece
 * aqui, na borda, e em nenhum outro lugar.
 */
export function rowToVideoRecord(row: VideoRow): VideoRecord {
  return {
    id: row.id,
    ytChannelId: row.ytChannelId,
    ytChannelTitle: '',
    title: row.title,
    description: row.description,
    publishedAt: row.publishedAt.getTime(),
    durationSec: row.durationSec,
    categoryId: row.categoryId,
    tags: row.tags,
    embeddable: row.embeddable,
    privacyStatus: row.privacyStatus,
    uploadStatus: row.uploadStatus,
    madeForKids: row.madeForKids,
    blockedRegions: row.blockedRegions,
    allowedRegions: row.allowedRegions,
    hasContentRating: row.hasContentRating,
    liveState: row.liveState as VideoRecord['liveState'],
    liveScheduledStartMs: row.liveScheduledStart?.getTime() ?? null,
    liveActualStartMs: row.liveActualStart?.getTime() ?? null,
    liveActualEndMs: row.liveActualEnd?.getTime() ?? null,
    thumbnailUrl: row.thumbnailUrl,
    refreshedAtMs: row.refreshedAt.getTime(),
  };
}

function videoRecordToRow(rec: VideoRecord): typeof schema.ytVideo.$inferInsert {
  return {
    id: rec.id,
    ytChannelId: rec.ytChannelId,
    title: rec.title,
    description: rec.description,
    publishedAt: new Date(rec.publishedAt),
    durationSec: rec.durationSec,
    categoryId: rec.categoryId,
    tags: [...rec.tags],
    embeddable: rec.embeddable,
    privacyStatus: rec.privacyStatus,
    uploadStatus: rec.uploadStatus,
    madeForKids: rec.madeForKids,
    blockedRegions: [...rec.blockedRegions],
    allowedRegions: [...rec.allowedRegions],
    hasContentRating: rec.hasContentRating,
    liveState: rec.liveState,
    liveScheduledStart:
      rec.liveScheduledStartMs === null ? null : new Date(rec.liveScheduledStartMs),
    liveActualStart: rec.liveActualStartMs === null ? null : new Date(rec.liveActualStartMs),
    liveActualEnd: rec.liveActualEndMs === null ? null : new Date(rec.liveActualEndMs),
    thumbnailUrl: rec.thumbnailUrl,
    refreshedAt: new Date(rec.refreshedAtMs),
  };
}

// ---------------------------------------------------------------------------
// Canais
// ---------------------------------------------------------------------------

export async function upsertChannels(db: Db, records: readonly ChannelRecord[]): Promise<number> {
  if (records.length === 0) return 0;

  await db
    .insert(schema.ytChannel)
    .values(
      records.map((c) => ({
        id: c.id,
        title: c.title,
        uploadsPlaylistId: c.uploadsPlaylistId,
        thumbnailUrl: c.thumbnailUrl,
        refreshedAt: new Date(c.refreshedAtMs),
      })),
    )
    .onConflictDoUpdate({
      target: schema.ytChannel.id,
      set: {
        title: sql`excluded.title`,
        uploadsPlaylistId: sql`excluded.uploads_playlist_id`,
        thumbnailUrl: sql`excluded.thumbnail_url`,
        refreshedAt: sql`excluded.refreshed_at`,
      },
    });

  return records.length;
}

/**
 * Canais que precisam ser revalidados, em ordem de urgência.
 *
 * Inclui os que passaram de `CACHE_REFRESH_AFTER_DAYS` e os que nunca resolveram a
 * playlist de uploads — sem ela o canal não rende pool nenhum.
 */
export async function channelsNeedingRefresh(
  db: Db,
  nowMs: number,
  limit: number,
): Promise<string[]> {
  const cutoff = new Date(nowMs - CACHE_REFRESH_AFTER_DAYS * DAY_MS);
  const rows = await db
    .select({ id: schema.ytChannel.id })
    .from(schema.ytChannel)
    // `lte`, não `lt`: `needsRefresh` usa `>=`, e divergir do predicado da aplicação
    // deixaria registros na zona cinzenta entre "vencido" e "não recolhido".
    .where(
      or(lte(schema.ytChannel.refreshedAt, cutoff), isNull(schema.ytChannel.uploadsPlaylistId)),
    )
    .orderBy(asc(schema.ytChannel.refreshedAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function getUploadsPlaylistIds(
  db: Db,
  ytChannelIds: readonly string[],
): Promise<Map<string, string>> {
  if (ytChannelIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: schema.ytChannel.id,
      uploadsPlaylistId: schema.ytChannel.uploadsPlaylistId,
    })
    .from(schema.ytChannel)
    .where(inArray(schema.ytChannel.id, [...ytChannelIds]));

  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.uploadsPlaylistId) out.set(row.id, row.uploadsPlaylistId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vídeos
// ---------------------------------------------------------------------------

/**
 * Grava metadados de vídeo.
 *
 * `unplayableAt` **não** é sobrescrito no conflito: um vídeo que já falhou no player
 * continua marcado mesmo depois de um refresh que o traga como perfeitamente normal.
 * A API costuma reportar `embeddable: true` para vídeos que na prática devolvem erro
 * 150, e perder essa memória faria o mesmo vídeo quebrado voltar à grade amanhã.
 */
export async function upsertVideos(db: Db, records: readonly VideoRecord[]): Promise<number> {
  if (records.length === 0) return 0;

  await db
    .insert(schema.ytVideo)
    .values(records.map(videoRecordToRow))
    .onConflictDoUpdate({
      target: schema.ytVideo.id,
      set: {
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        publishedAt: sql`excluded.published_at`,
        durationSec: sql`excluded.duration_sec`,
        categoryId: sql`excluded.category_id`,
        tags: sql`excluded.tags`,
        embeddable: sql`excluded.embeddable`,
        privacyStatus: sql`excluded.privacy_status`,
        uploadStatus: sql`excluded.upload_status`,
        madeForKids: sql`excluded.made_for_kids`,
        blockedRegions: sql`excluded.blocked_regions`,
        allowedRegions: sql`excluded.allowed_regions`,
        hasContentRating: sql`excluded.has_content_rating`,
        liveState: sql`excluded.live_state`,
        liveScheduledStart: sql`excluded.live_scheduled_start`,
        liveActualStart: sql`excluded.live_actual_start`,
        liveActualEnd: sql`excluded.live_actual_end`,
        thumbnailUrl: sql`excluded.thumbnail_url`,
        refreshedAt: sql`excluded.refreshed_at`,
      },
    });

  return records.length;
}

/** Marca um vídeo como injogável, para ele não voltar à grade (terceira camada de R13). */
export async function markUnplayable(
  db: Db,
  videoId: string,
  code: number,
  reason: string,
  nowMs: number,
): Promise<void> {
  await db
    .update(schema.ytVideo)
    .set({
      unplayableAt: new Date(nowMs),
      unplayableCode: code,
      unplayableReason: reason,
    })
    .where(eq(schema.ytVideo.id, videoId));
}

export async function listUnplayableIds(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ id: schema.ytVideo.id })
    .from(schema.ytVideo)
    .where(isNotNull(schema.ytVideo.unplayableAt));
  return new Set(rows.map((r) => r.id));
}

/** Corrige a duração quando o player reporta valor diferente do armazenado. */
export async function correctDuration(db: Db, videoId: string, actualSec: number): Promise<void> {
  await db
    .update(schema.ytVideo)
    .set({ durationSec: actualSec })
    .where(eq(schema.ytVideo.id, videoId));
}

export async function listVideosByChannels(
  db: Db,
  ytChannelIds: readonly string[],
  limitPerQuery = 5_000,
): Promise<VideoRecord[]> {
  if (ytChannelIds.length === 0) return [];
  const rows = await db
    .select()
    .from(schema.ytVideo)
    .where(inArray(schema.ytVideo.ytChannelId, [...ytChannelIds]))
    .orderBy(desc(schema.ytVideo.publishedAt))
    .limit(limitPerQuery);
  return rows.map(rowToVideoRecord);
}

/** Ids dos vídeos mais recentes de um canal — a sondagem de live e de novidade. */
export async function latestVideoIds(
  db: Db,
  ytChannelId: string,
  depth: number,
): Promise<string[]> {
  const rows = await db
    .select({ id: schema.ytVideo.id })
    .from(schema.ytVideo)
    .where(eq(schema.ytVideo.ytChannelId, ytChannelId))
    .orderBy(desc(schema.ytVideo.publishedAt))
    .limit(depth);
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Montagem de pool
// ---------------------------------------------------------------------------

/**
 * Monta o pool de um conjunto de canais, já aplicando R13.
 *
 * Delega a decisão a `buildPool` de `@minhatv/yt` em vez de reimplementar os filtros
 * em SQL: manter a regra em um lugar só é o que garante que a interface e os jobs
 * concordem sobre o que é elegível — e o relatório de recusas é o que permite explicar
 * um pool pequeno ao usuário.
 */
export async function buildPoolForChannels(
  db: Db,
  ytChannelIds: readonly string[],
  opts: EligibilityOptions,
): Promise<PoolBuildResult> {
  const videos = await listVideosByChannels(db, ytChannelIds);
  const unplayable = opts.unplayableIds ?? (await listUnplayableIds(db));
  return buildPool(videos, { ...opts, unplayableIds: unplayable });
}

// ---------------------------------------------------------------------------
// R3 — purga do cache
// ---------------------------------------------------------------------------

export interface PurgeReport {
  readonly videosDeleted: number;
  readonly channelsDeleted: number;
  readonly cutoffMs: number;
}

/**
 * Apaga tudo que passou dos 30 dias.
 *
 * As Developer Policies exigem apagar **ou** revalidar; apagar é o que sempre funciona,
 * porque revalidar depende de cota disponível e de o vídeo ainda existir. O job de
 * refresh cuida da revalidação antes do prazo (aos 25 dias), e esta purga é a rede de
 * segurança que garante o cumprimento mesmo se o refresh falhar por dias.
 */
export async function purgeExpiredCache(db: Db, nowMs: number): Promise<PurgeReport> {
  const cutoff = new Date(nowMs - CACHE_MAX_AGE_DAYS * DAY_MS);

  /*
   * `lte` casa com o `>=` de `isCacheExpired`. Um `lt` estrito deixaria o registro de
   * exatamente 30 dias num limbo: recusado pela elegibilidade, porém não apagado —
   * exatamente o estado que R3 proíbe.
   */
  const videos = await db
    .delete(schema.ytVideo)
    .where(lte(schema.ytVideo.refreshedAt, cutoff))
    .returning({ id: schema.ytVideo.id });

  /*
   * Canais vencidos só saem se não tiverem vídeo vivo dependendo deles: a FK é
   * `on delete cascade`, então apagar um canal ainda referenciado levaria vídeos
   * dentro do prazo junto.
   */
  const channels = await db
    .delete(schema.ytChannel)
    .where(
      and(
        lte(schema.ytChannel.refreshedAt, cutoff),
        sql`not exists (select 1 from ${schema.ytVideo} where ${schema.ytVideo.ytChannelId} = ${schema.ytChannel.id})`,
      ),
    )
    .returning({ id: schema.ytChannel.id });

  return {
    videosDeleted: videos.length,
    channelsDeleted: channels.length,
    cutoffMs: cutoff.getTime(),
  };
}

/** Auditoria de R3: quantos registros passaram do prazo. Deve ser sempre zero. */
export async function countExpired(db: Db, nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - CACHE_MAX_AGE_DAYS * DAY_MS);
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.ytVideo)
    .where(lte(schema.ytVideo.refreshedAt, cutoff));
  return rows[0]?.n ?? 0;
}
