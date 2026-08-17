/**
 * Repositório da programação: grade materializada e log de patches.
 *
 * A grade persistida é a fonte da verdade para o EPG e para as regras de
 * não-repetição, e o log de patches é o que mantém a programação idêntica entre
 * dispositivos (`base(seed) + patches em ordem`).
 */

import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { localDayKey } from '@minhatv/core';
import type { AirHistory, ScheduleSlot, SchedulePatch, RelaxLevel } from '@minhatv/core';
import type { Db } from './client.js';
import { schema } from './client.js';

const DAY_MS = 86_400_000;

/** Retenção do histórico de programação. Depois disso nada mais influencia decisão. */
export const SCHEDULE_HISTORY_DAYS = 60;

type SlotRow = typeof schema.scheduleSlot.$inferSelect;

export function rowToSlot(row: SlotRow): ScheduleSlot {
  return {
    seq: row.seq,
    videoId: row.videoId,
    ytChannelId: row.ytChannelId,
    startsAtMs: row.startsAt.getTime(),
    endsAtMs: row.endsAt.getTime(),
    durationSec: row.durationSec,
    relaxedTo: row.relaxedTo as RelaxLevel,
    isHotInsert: row.isHotInsert,
    ...(row.truncated ? { truncated: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Grade
// ---------------------------------------------------------------------------

/**
 * Substitui a grade de um dia inteiro, em transação.
 *
 * Apagar e reinserir dentro de uma transação, em vez de fazer um diff slot a slot: o
 * re-fluxo pode mudar todos os slots da cauda de uma vez, e um diff parcial deixaria a
 * grade inconsistente se falhasse no meio — com buraco ou sobreposição, exatamente o
 * defeito que os testes do motor existem para impedir.
 */
export async function replaceDayGrid(
  db: Db,
  tvChannelId: string,
  dayKey: string,
  slots: readonly ScheduleSlot[],
): Promise<number> {
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.scheduleSlot)
      .where(
        and(
          eq(schema.scheduleSlot.tvChannelId, tvChannelId),
          eq(schema.scheduleSlot.dayKey, dayKey),
        ),
      );

    if (slots.length > 0) {
      await tx.insert(schema.scheduleSlot).values(
        slots.map((s) => ({
          tvChannelId,
          dayKey,
          seq: s.seq,
          videoId: s.videoId,
          ytChannelId: s.ytChannelId,
          startsAt: new Date(s.startsAtMs),
          endsAt: new Date(s.endsAtMs),
          durationSec: s.durationSec,
          relaxedTo: s.relaxedTo,
          isHotInsert: s.isHotInsert,
          truncated: s.truncated === true,
        })),
      );
    }
  });

  return slots.length;
}

export async function getDayGrid(
  db: Db,
  tvChannelId: string,
  dayKey: string,
): Promise<ScheduleSlot[]> {
  const rows = await db
    .select()
    .from(schema.scheduleSlot)
    .where(
      and(eq(schema.scheduleSlot.tvChannelId, tvChannelId), eq(schema.scheduleSlot.dayKey, dayKey)),
    )
    .orderBy(asc(schema.scheduleSlot.seq));
  return rows.map(rowToSlot);
}

/** `true` se a grade daquele dia já foi materializada. */
export async function hasDayGrid(db: Db, tvChannelId: string, dayKey: string): Promise<boolean> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.scheduleSlot)
    .where(
      and(eq(schema.scheduleSlot.tvChannelId, tvChannelId), eq(schema.scheduleSlot.dayKey, dayKey)),
    );
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * Slot no ar em um instante.
 *
 * A consulta é por janela e não por `dayKey`, porque um vídeo pode atravessar a
 * meia-noite: filtrar pelo dia perderia justamente o slot a cavalo na virada.
 */
export async function slotAt(
  db: Db,
  tvChannelId: string,
  atMs: number,
): Promise<ScheduleSlot | null> {
  const at = new Date(atMs);
  const rows = await db
    .select()
    .from(schema.scheduleSlot)
    .where(
      and(
        eq(schema.scheduleSlot.tvChannelId, tvChannelId),
        lte(schema.scheduleSlot.startsAt, at),
        sql`${schema.scheduleSlot.endsAt} > ${at}`,
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? rowToSlot(row) : null;
}

/** Janela de EPG: slots que se sobrepõem ao intervalo pedido. */
export async function slotsInWindow(
  db: Db,
  tvChannelIds: readonly string[],
  fromMs: number,
  toMs: number,
): Promise<Map<string, ScheduleSlot[]>> {
  if (tvChannelIds.length === 0) return new Map();

  const rows = await db
    .select()
    .from(schema.scheduleSlot)
    .where(
      and(
        inArray(schema.scheduleSlot.tvChannelId, [...tvChannelIds]),
        lt(schema.scheduleSlot.startsAt, new Date(toMs)),
        sql`${schema.scheduleSlot.endsAt} > ${new Date(fromMs)}`,
      ),
    )
    .orderBy(asc(schema.scheduleSlot.tvChannelId), asc(schema.scheduleSlot.startsAt));

  const out = new Map<string, ScheduleSlot[]>();
  for (const row of rows) {
    const list = out.get(row.tvChannelId) ?? [];
    list.push(rowToSlot(row));
    out.set(row.tvChannelId, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Histórico para as regras de não-repetição
// ---------------------------------------------------------------------------

/**
 * Vídeos exibidos na janela de re-exibição, para o bucket "já exibido" de R-A.
 *
 * Consulta local, sem custo de cota — é o que torna viável despriorizar o que passou
 * recentemente sem precisar guardar estado no cliente.
 */
export async function airHistory(
  db: Db,
  tvChannelId: string,
  nowMs: number,
  windowDays: number,
): Promise<AirHistory> {
  const since = new Date(nowMs - windowDays * DAY_MS);
  const rows = await db
    .select({ videoId: schema.scheduleSlot.videoId })
    .from(schema.scheduleSlot)
    .where(
      and(
        eq(schema.scheduleSlot.tvChannelId, tvChannelId),
        gte(schema.scheduleSlot.startsAt, since),
        lt(schema.scheduleSlot.startsAt, new Date(nowMs)),
      ),
    );
  return { airedVideoIds: new Set(rows.map((r) => r.videoId)) };
}

export interface PruneReport {
  readonly slotsDeleted: number;
  readonly patchesDeleted: number;
}

export async function pruneScheduleHistory(db: Db, nowMs: number): Promise<PruneReport> {
  const cutoff = new Date(nowMs - SCHEDULE_HISTORY_DAYS * DAY_MS);

  const slots = await db
    .delete(schema.scheduleSlot)
    .where(lt(schema.scheduleSlot.startsAt, cutoff))
    .returning({ seq: schema.scheduleSlot.seq });

  const patches = await db
    .delete(schema.schedulePatch)
    .where(lt(schema.schedulePatch.appliedAt, cutoff))
    .returning({ seqNo: schema.schedulePatch.seqNo });

  return { slotsDeleted: slots.length, patchesDeleted: patches.length };
}

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

export interface AppendPatchInput {
  readonly tvChannelId: string;
  readonly dayKey: string;
  readonly appliedAtMs: number;
  readonly kind: SchedulePatch['kind'];
  readonly videoId: string | null;
  readonly reason: string;
}

/**
 * Acrescenta um patch, atribuindo o próximo `seqNo` do dia dentro da transação.
 *
 * Calcular o `seqNo` fora da transação abriria janela para dois jobs concorrentes
 * gravarem o mesmo número. A chave primária composta rejeitaria o segundo, mas o
 * resultado seria um patch perdido — pior que um erro, porque o replay seguiria
 * "funcionando" com uma grade diferente da materializada.
 */
export async function appendPatch(db: Db, input: AppendPatchInput): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ maxSeq: sql<number | null>`max(${schema.schedulePatch.seqNo})` })
      .from(schema.schedulePatch)
      .where(
        and(
          eq(schema.schedulePatch.tvChannelId, input.tvChannelId),
          eq(schema.schedulePatch.dayKey, input.dayKey),
        ),
      );

    const seqNo = (rows[0]?.maxSeq ?? 0) + 1;

    await tx.insert(schema.schedulePatch).values({
      tvChannelId: input.tvChannelId,
      dayKey: input.dayKey,
      seqNo,
      appliedAt: new Date(input.appliedAtMs),
      kind: input.kind,
      videoId: input.videoId,
      reason: input.reason,
    });

    return seqNo;
  });
}

export async function listPatches(
  db: Db,
  tvChannelId: string,
  dayKey: string,
): Promise<SchedulePatch[]> {
  const rows = await db
    .select()
    .from(schema.schedulePatch)
    .where(
      and(
        eq(schema.schedulePatch.tvChannelId, tvChannelId),
        eq(schema.schedulePatch.dayKey, dayKey),
      ),
    )
    .orderBy(asc(schema.schedulePatch.seqNo));

  return rows.map((r) => ({
    seqNo: r.seqNo,
    tvChannelId: r.tvChannelId,
    dayKey: r.dayKey,
    appliedAtMs: r.appliedAt.getTime(),
    kind: r.kind as SchedulePatch['kind'],
    videoId: r.videoId,
    reason: r.reason,
  }));
}

/** Quantas inserções a quente já foram aplicadas hoje, para os limites anti-turbulência. */
export async function hotInsertTimesToday(
  db: Db,
  tvChannelId: string,
  nowMs: number,
  timeZone: string,
): Promise<number[]> {
  const dayKey = localDayKey(nowMs, timeZone);
  const rows = await db
    .select({ appliedAt: schema.schedulePatch.appliedAt })
    .from(schema.schedulePatch)
    .where(
      and(
        eq(schema.schedulePatch.tvChannelId, tvChannelId),
        eq(schema.schedulePatch.dayKey, dayKey),
        eq(schema.schedulePatch.kind, 'HOT_INSERT'),
      ),
    )
    .orderBy(desc(schema.schedulePatch.appliedAt));
  return rows.map((r) => r.appliedAt.getTime());
}
