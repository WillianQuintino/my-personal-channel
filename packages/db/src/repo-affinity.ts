/**
 * Repositório de afinidade (R1) — as três fontes combinadas.
 *
 * Como a API do YouTube não expõe histórico de exibição desde 2016, o ranking vem de
 * import do Takeout, das inscrições e do tracking interno. `computeAffinity` e
 * `decayInternalScore` moram em `@minhatv/yt`; aqui só entra a persistência.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import {
  computeAffinity,
  decayInternalScore,
  DEFAULT_AFFINITY_WEIGHTS,
  type AffinityWeights,
  type WatchCount,
} from '@minhatv/yt';
import type { AffinityMap } from '@minhatv/core';
import type { Db } from './client.js';
import { schema } from './client.js';

const DAY_MS = 86_400_000;

/** Janela de eventos que alimentam o score interno. Além disso o decaimento já zerou. */
export const INTERNAL_SCORE_WINDOW_DAYS = 180;

export async function setSubscribed(
  db: Db,
  userId: string,
  subscribedChannelIds: readonly string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    // Uma inscrição cancelada tem de deixar de contar, então o flag é zerado antes.
    await tx
      .update(schema.userChannelAffinity)
      .set({ isSubscribed: false })
      .where(eq(schema.userChannelAffinity.userId, userId));

    if (subscribedChannelIds.length === 0) return;

    await tx
      .insert(schema.userChannelAffinity)
      .values(
        subscribedChannelIds.map((ytChannelId) => ({
          userId,
          ytChannelId,
          isSubscribed: true,
        })),
      )
      .onConflictDoUpdate({
        target: [schema.userChannelAffinity.userId, schema.userChannelAffinity.ytChannelId],
        set: { isSubscribed: true, updatedAt: sql`now()` },
      });
  });
}

export async function setFavorite(
  db: Db,
  userId: string,
  ytChannelId: string,
  isFavorite: boolean,
): Promise<void> {
  await db
    .insert(schema.userChannelAffinity)
    .values({ userId, ytChannelId, isFavorite })
    .onConflictDoUpdate({
      target: [schema.userChannelAffinity.userId, schema.userChannelAffinity.ytChannelId],
      set: { isFavorite, updatedAt: sql`now()` },
    });
}

/** Grava o resultado do import do Takeout. */
export async function applyTakeoutCounts(
  db: Db,
  userId: string,
  counts: readonly WatchCount[],
): Promise<number> {
  const known = counts.filter((c) => c.ytChannelId.startsWith('UC'));
  if (known.length === 0) return 0;

  await db
    .insert(schema.userChannelAffinity)
    .values(
      known.map((c) => ({
        userId,
        ytChannelId: c.ytChannelId,
        takeoutCount: c.count,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.userChannelAffinity.userId, schema.userChannelAffinity.ytChannelId],
      set: { takeoutCount: sql`excluded.takeout_count`, updatedAt: sql`now()` },
    });

  return known.length;
}

export async function recordWatchEvent(
  db: Db,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly videoId: string;
    readonly ytChannelId: string;
    readonly watchedSec: number;
    readonly atMs: number;
  },
): Promise<void> {
  await db
    .insert(schema.watchEvent)
    .values({
      id: input.id,
      userId: input.userId,
      videoId: input.videoId,
      ytChannelId: input.ytChannelId,
      watchedSec: input.watchedSec,
      at: new Date(input.atMs),
    })
    .onConflictDoNothing();
}

export interface RecomputeReport {
  readonly channels: number;
  readonly topChannelId: string | null;
}

/**
 * Recalcula os scores e materializa `combinedScore`.
 *
 * A materialização existe porque o portão de inserção a quente consulta o top-K a cada
 * varredura de novidades; recalcular o score em cada consulta multiplicaria o custo sem
 * ganho, já que os sinais mudam devagar.
 */
export async function recomputeAffinity(
  db: Db,
  userId: string,
  nowMs: number,
  weights: AffinityWeights = DEFAULT_AFFINITY_WEIGHTS,
): Promise<RecomputeReport> {
  const since = new Date(nowMs - INTERNAL_SCORE_WINDOW_DAYS * DAY_MS);

  const events = await db
    .select({
      ytChannelId: schema.watchEvent.ytChannelId,
      watchedSec: schema.watchEvent.watchedSec,
      at: schema.watchEvent.at,
    })
    .from(schema.watchEvent)
    .where(and(eq(schema.watchEvent.userId, userId), gte(schema.watchEvent.at, since)));

  const eventsByChannel = new Map<string, { atMs: number; watchedSec: number }[]>();
  for (const e of events) {
    const list = eventsByChannel.get(e.ytChannelId) ?? [];
    list.push({ atMs: e.at.getTime(), watchedSec: e.watchedSec });
    eventsByChannel.set(e.ytChannelId, list);
  }

  const rows = await db
    .select()
    .from(schema.userChannelAffinity)
    .where(eq(schema.userChannelAffinity.userId, userId));

  if (rows.length === 0) return { channels: 0, topChannelId: null };

  const inputs = rows.map((r) => ({
    ytChannelId: r.ytChannelId,
    takeoutCount: r.takeoutCount,
    isSubscribed: r.isSubscribed,
    isFavorite: r.isFavorite,
    internalScore: decayInternalScore(eventsByChannel.get(r.ytChannelId) ?? [], nowMs),
  }));

  const scores = computeAffinity(inputs, weights);

  await db.transaction(async (tx) => {
    for (const input of inputs) {
      await tx
        .update(schema.userChannelAffinity)
        .set({
          internalScore: input.internalScore,
          combinedScore: scores.get(input.ytChannelId) ?? 0,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.userChannelAffinity.userId, userId),
            eq(schema.userChannelAffinity.ytChannelId, input.ytChannelId),
          ),
        );
    }
  });

  let topChannelId: string | null = null;
  let topScore = -1;
  for (const [id, score] of scores) {
    if (score > topScore || (score === topScore && topChannelId !== null && id < topChannelId)) {
      topScore = score;
      topChannelId = id;
    }
  }

  return { channels: inputs.length, topChannelId };
}

/** Mapa de afinidade pronto para o motor de grade. */
export async function affinityMap(db: Db, userId: string): Promise<AffinityMap> {
  const rows = await db
    .select({
      ytChannelId: schema.userChannelAffinity.ytChannelId,
      combinedScore: schema.userChannelAffinity.combinedScore,
    })
    .from(schema.userChannelAffinity)
    .where(eq(schema.userChannelAffinity.userId, userId));
  return new Map(rows.map((r) => [r.ytChannelId, r.combinedScore]));
}

export async function favoriteChannelIds(db: Db, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ ytChannelId: schema.userChannelAffinity.ytChannelId })
    .from(schema.userChannelAffinity)
    .where(
      and(
        eq(schema.userChannelAffinity.userId, userId),
        eq(schema.userChannelAffinity.isFavorite, true),
      ),
    );
  return new Set(rows.map((r) => r.ytChannelId));
}

export async function subscribedChannelIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ ytChannelId: schema.userChannelAffinity.ytChannelId })
    .from(schema.userChannelAffinity)
    .where(
      and(
        eq(schema.userChannelAffinity.userId, userId),
        eq(schema.userChannelAffinity.isSubscribed, true),
      ),
    );
  return rows.map((r) => r.ytChannelId);
}

/** Top-N canais por score. Alimenta o canal "mais assistidos" e o polling em camadas. */
export async function topChannels(db: Db, userId: string, limit: number): Promise<string[]> {
  const rows = await db
    .select({ ytChannelId: schema.userChannelAffinity.ytChannelId })
    .from(schema.userChannelAffinity)
    .where(eq(schema.userChannelAffinity.userId, userId))
    .orderBy(
      desc(schema.userChannelAffinity.combinedScore),
      // Desempate estável: sem ele, dois canais com o mesmo score alternariam entre
      // consultas e o polling em camadas ficaria oscilando.
      schema.userChannelAffinity.ytChannelId,
    )
    .limit(limit);
  return rows.map((r) => r.ytChannelId);
}
