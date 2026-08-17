/**
 * Repositórios operacionais: canais de TV, estado de live, cota e cursores de job.
 */

import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { DEFAULT_GRID_CONFIG, type ChannelMode, type GridConfig } from '@minhatv/core';
import { quotaDayKey, type LiveState, type LiveStatus } from '@minhatv/yt';
import type { Db } from './client.js';
import { schema } from './client.js';

// ---------------------------------------------------------------------------
// Canais de TV
// ---------------------------------------------------------------------------

export type SourceKind =
  'ALL_SUBSCRIPTIONS' | 'TOP_WATCHED' | 'FAVORITES' | 'CATEGORY' | 'HASHTAG' | 'CUSTOM';

export interface TvChannelRecord {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly number: number;
  readonly sourceKind: SourceKind;
  readonly sourceSpec: Record<string, unknown>;
  readonly mode: ChannelMode;
  readonly filters: Partial<GridConfig>;
}

type TvChannelRow = typeof schema.tvChannel.$inferSelect;

function rowToTvChannel(row: TvChannelRow): TvChannelRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    number: row.number,
    sourceKind: row.sourceKind as SourceKind,
    sourceSpec: (row.sourceSpec ?? {}) as Record<string, unknown>,
    mode: row.mode as ChannelMode,
    filters: (row.filters ?? {}) as Partial<GridConfig>,
  };
}

export async function listTvChannels(db: Db, userId: string): Promise<TvChannelRecord[]> {
  const rows = await db
    .select()
    .from(schema.tvChannel)
    .where(eq(schema.tvChannel.userId, userId))
    .orderBy(asc(schema.tvChannel.number));
  return rows.map(rowToTvChannel);
}

export async function getTvChannel(db: Db, id: string): Promise<TvChannelRecord | null> {
  const rows = await db.select().from(schema.tvChannel).where(eq(schema.tvChannel.id, id)).limit(1);
  const row = rows[0];
  return row ? rowToTvChannel(row) : null;
}

export async function upsertTvChannel(db: Db, rec: TvChannelRecord): Promise<void> {
  await db
    .insert(schema.tvChannel)
    .values({
      id: rec.id,
      userId: rec.userId,
      name: rec.name,
      number: rec.number,
      sourceKind: rec.sourceKind,
      sourceSpec: rec.sourceSpec,
      mode: rec.mode,
      filters: rec.filters,
    })
    .onConflictDoUpdate({
      target: schema.tvChannel.id,
      set: {
        name: sql`excluded.name`,
        number: sql`excluded.number`,
        sourceKind: sql`excluded.source_kind`,
        sourceSpec: sql`excluded.source_spec`,
        mode: sql`excluded.mode`,
        filters: sql`excluded.filters`,
      },
    });
}

export async function deleteTvChannel(db: Db, id: string): Promise<void> {
  await db.delete(schema.tvChannel).where(eq(schema.tvChannel.id, id));
}

/**
 * Configuração efetiva de um canal: os padrões, com o fuso e a região do usuário
 * aplicados por cima, e as sobrescritas do canal por último.
 *
 * A ordem importa: o fuso do usuário define a virada do dia e portanto o seed da
 * grade, mas um canal pode querer duração mínima ou janela de re-exibição próprias.
 */
export async function effectiveGridConfig(db: Db, tvChannelId: string): Promise<GridConfig | null> {
  const rows = await db
    .select({
      filters: schema.tvChannel.filters,
      timeZone: schema.user.timeZone,
    })
    .from(schema.tvChannel)
    .innerJoin(schema.user, eq(schema.tvChannel.userId, schema.user.id))
    .where(eq(schema.tvChannel.id, tvChannelId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    ...DEFAULT_GRID_CONFIG,
    timeZone: row.timeZone,
    ...((row.filters ?? {}) as Partial<GridConfig>),
  };
}

// ---------------------------------------------------------------------------
// Estado de live
// ---------------------------------------------------------------------------

export async function upsertLiveState(db: Db, state: LiveState): Promise<void> {
  await db
    .insert(schema.liveState)
    .values({
      ytChannelId: state.ytChannelId,
      status: state.status,
      videoId: state.videoId,
      scheduledStart: state.scheduledStartMs === null ? null : new Date(state.scheduledStartMs),
      checkedAt: new Date(state.checkedAtMs),
      nextCheckAt: new Date(state.nextCheckAtMs),
    })
    .onConflictDoUpdate({
      target: schema.liveState.ytChannelId,
      set: {
        status: sql`excluded.status`,
        videoId: sql`excluded.video_id`,
        scheduledStart: sql`excluded.scheduled_start`,
        checkedAt: sql`excluded.checked_at`,
        nextCheckAt: sql`excluded.next_check_at`,
      },
    });
}

export async function getLiveStates(db: Db, ytChannelIds: readonly string[]): Promise<LiveState[]> {
  if (ytChannelIds.length === 0) return [];
  const rows = await db
    .select()
    .from(schema.liveState)
    // `inArray`, não `sql\`= any(...)\``: interpolar um array JS num template do Drizzle
    // manda a lista como **um** parâmetro, e o Postgres tenta lê-la como literal de
    // array — "malformed array literal".
    .where(inArray(schema.liveState.ytChannelId, [...ytChannelIds]));

  return rows.map((r) => ({
    ytChannelId: r.ytChannelId,
    status: r.status as LiveStatus,
    videoId: r.videoId,
    scheduledStartMs: r.scheduledStart?.getTime() ?? null,
    checkedAtMs: r.checkedAt.getTime(),
    nextCheckAtMs: r.nextCheckAt.getTime(),
  }));
}

/**
 * Canais cuja checagem de live já venceu, do mais atrasado para o menos.
 *
 * A consulta é a fila do worker: polling dirigido em vez de varredura cega é o que
 * mantém a detecção de lives dentro do orçamento de cota.
 */
export async function channelsDueForLiveCheck(
  db: Db,
  nowMs: number,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ ytChannelId: schema.liveState.ytChannelId })
    .from(schema.liveState)
    .where(lte(schema.liveState.nextCheckAt, new Date(nowMs)))
    .orderBy(asc(schema.liveState.nextCheckAt))
    .limit(limit);
  return rows.map((r) => r.ytChannelId);
}

/** Canais que ainda não têm estado de live registrado — precisam da primeira checagem. */
export async function channelsWithoutLiveState(db: Db, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: schema.ytChannel.id })
    .from(schema.ytChannel)
    .leftJoin(schema.liveState, eq(schema.liveState.ytChannelId, schema.ytChannel.id))
    .where(isNull(schema.liveState.ytChannelId))
    .limit(limit);
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Cota (R2)
// ---------------------------------------------------------------------------

/**
 * Soma unidades ao dia corrente. A chave é o dia do **Pacífico**, porque é quando a
 * cota do YouTube zera — contabilizar no fuso do usuário faria o orçamento parecer
 * disponível quando não está.
 */
export async function chargeQuota(
  db: Db,
  nowMs: number,
  units: number,
  method: string,
): Promise<void> {
  const day = quotaDayKey(nowMs);
  await db
    .insert(schema.quotaLedger)
    .values({ day, units, byMethod: { [method]: units } })
    .onConflictDoUpdate({
      target: schema.quotaLedger.day,
      set: {
        units: sql`${schema.quotaLedger.units} + ${units}`,
        // `jsonb_set` com fallback: a primeira ocorrência do método cria a chave.
        byMethod: sql`jsonb_set(
          ${schema.quotaLedger.byMethod},
          array[${method}],
          to_jsonb(coalesce((${schema.quotaLedger.byMethod} ->> ${method})::int, 0) + ${units})
        )`,
        updatedAt: sql`now()`,
      },
    });
}

export async function quotaSpentToday(db: Db, nowMs: number): Promise<number> {
  const day = quotaDayKey(nowMs);
  const rows = await db
    .select({ units: schema.quotaLedger.units })
    .from(schema.quotaLedger)
    .where(eq(schema.quotaLedger.day, day))
    .limit(1);
  return rows[0]?.units ?? 0;
}

export async function quotaBreakdownToday(db: Db, nowMs: number): Promise<Record<string, number>> {
  const day = quotaDayKey(nowMs);
  const rows = await db
    .select({ byMethod: schema.quotaLedger.byMethod })
    .from(schema.quotaLedger)
    .where(eq(schema.quotaLedger.day, day))
    .limit(1);
  return (rows[0]?.byMethod ?? {}) as Record<string, number>;
}

// ---------------------------------------------------------------------------
// Cursores de job
// ---------------------------------------------------------------------------

export interface JobCursor {
  readonly job: string;
  readonly cursor: string | null;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly lastError: string | null;
}

export async function getJobCursor(db: Db, job: string): Promise<JobCursor | null> {
  const rows = await db
    .select()
    .from(schema.jobCursor)
    .where(eq(schema.jobCursor.job, job))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    job: row.job,
    cursor: row.cursor,
    startedAtMs: row.startedAt?.getTime() ?? null,
    finishedAtMs: row.finishedAt?.getTime() ?? null,
    lastError: row.lastError,
  };
}

/**
 * Grava o progresso de um job fatiado.
 *
 * `cursor === null` significa "terminou a volta": a próxima invocação começa do início.
 * É o que permite a um job com teto de 10 s convergir ao longo de várias execuções.
 */
export async function setJobCursor(
  db: Db,
  job: string,
  cursor: string | null,
  nowMs: number,
  lastError: string | null = null,
): Promise<void> {
  await db
    .insert(schema.jobCursor)
    .values({
      job,
      cursor,
      startedAt: new Date(nowMs),
      finishedAt: cursor === null ? new Date(nowMs) : null,
      lastError,
    })
    .onConflictDoUpdate({
      target: schema.jobCursor.job,
      set: {
        cursor: sql`excluded.cursor`,
        finishedAt: sql`excluded.finished_at`,
        lastError: sql`excluded.last_error`,
        updatedAt: sql`now()`,
      },
    });
}

// ---------------------------------------------------------------------------
// Usuário
// ---------------------------------------------------------------------------

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly region: string;
  readonly timeZone: string;
}

export async function getUser(db: Db, id: string): Promise<UserRecord | null> {
  const rows = await db.select().from(schema.user).where(eq(schema.user.id, id)).limit(1);
  const row = rows[0];
  return row ? { id: row.id, email: row.email, region: row.region, timeZone: row.timeZone } : null;
}

export async function listUserIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .orderBy(asc(schema.user.id));
  return rows.map((r) => r.id);
}

export async function upsertUser(db: Db, rec: UserRecord): Promise<void> {
  await db
    .insert(schema.user)
    .values(rec)
    .onConflictDoUpdate({
      target: schema.user.id,
      set: {
        email: sql`excluded.email`,
        region: sql`excluded.region`,
        timeZone: sql`excluded.time_zone`,
      },
    });
}

export async function saveOauthAccount(
  db: Db,
  input: {
    readonly userId: string;
    readonly provider: string;
    readonly refreshTokenEnc: string;
    readonly scopes: readonly string[];
    readonly expiresAtMs: number | null;
  },
): Promise<void> {
  await db
    .insert(schema.oauthAccount)
    .values({
      userId: input.userId,
      provider: input.provider,
      refreshTokenEnc: input.refreshTokenEnc,
      scopes: [...input.scopes],
      expiresAt: input.expiresAtMs === null ? null : new Date(input.expiresAtMs),
    })
    .onConflictDoUpdate({
      target: [schema.oauthAccount.userId, schema.oauthAccount.provider],
      set: {
        refreshTokenEnc: sql`excluded.refresh_token_enc`,
        scopes: sql`excluded.scopes`,
        expiresAt: sql`excluded.expires_at`,
        updatedAt: sql`now()`,
      },
    });
}

export async function getOauthAccount(
  db: Db,
  userId: string,
  provider: string,
): Promise<{ refreshTokenEnc: string; scopes: string[] } | null> {
  const rows = await db
    .select({
      refreshTokenEnc: schema.oauthAccount.refreshTokenEnc,
      scopes: schema.oauthAccount.scopes,
    })
    .from(schema.oauthAccount)
    .where(and(eq(schema.oauthAccount.userId, userId), eq(schema.oauthAccount.provider, provider)))
    .limit(1);
  return rows[0] ?? null;
}
