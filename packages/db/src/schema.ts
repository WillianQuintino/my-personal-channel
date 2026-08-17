/**
 * Schema Drizzle do MinhaTV.
 *
 * Duas decisões atravessam o schema inteiro:
 *
 * 1. **`refreshedAt` é obrigatório em tudo que vem da API do YouTube.** Não é
 *    metadado de conveniência: é a base de R3, o prazo contratual de 30 dias das
 *    Developer Policies. Sem a coluna não há como cumprir nem auditar a regra.
 *
 * 2. **Instantes são `timestamptz`, e a aplicação converte para epoch ms na borda.**
 *    O motor de grade trabalha só com números (é o que o torna determinístico e
 *    testável); o banco guarda tipos temporais de verdade, para as consultas de
 *    janela e as purgas serem SQL e não laço em memória.
 */

import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Usuário e credenciais
// ---------------------------------------------------------------------------

export const user = pgTable('user', {
  id: varchar('id', { length: 64 }).primaryKey(),
  email: text('email').notNull().unique(),
  /** ISO 3166-1 alpha-2. Governa as restrições regionais de R13. */
  region: varchar('region', { length: 2 }).notNull().default('BR'),
  /** Fuso IANA. Define a virada do dia e, portanto, o seed da grade. */
  timeZone: text('time_zone').notNull().default('America/Sao_Paulo'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const oauthAccount = pgTable(
  'oauth_account',
  {
    userId: varchar('user_id', { length: 64 })
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    /**
     * Refresh token cifrado em repouso. A coluna guarda o texto cifrado, nunca o
     * token cru — quem cifra é a camada de aplicação, para a chave não morar no banco.
     */
    refreshTokenEnc: text('refresh_token_enc').notNull(),
    scopes: text('scopes').array().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.provider] })],
);

// ---------------------------------------------------------------------------
// Cache da API do YouTube — sujeito a R3
// ---------------------------------------------------------------------------

export const ytChannel = pgTable(
  'yt_channel',
  {
    /** Id do canal (`UC…`). */
    id: varchar('id', { length: 32 }).primaryKey(),
    title: text('title').notNull().default(''),
    /**
     * Playlist de uploads (`UU…`). Nulo só enquanto o canal ainda não foi resolvido —
     * é por ela que passa o caminho barato de montagem de pool (R2).
     */
    uploadsPlaylistId: varchar('uploads_playlist_id', { length: 34 }),
    thumbnailUrl: text('thumbnail_url'),
    /** R3: base do prazo de 30 dias. */
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('yt_channel_refreshed_idx').on(t.refreshedAt)],
);

export const ytVideo = pgTable(
  'yt_video',
  {
    id: varchar('id', { length: 16 }).primaryKey(),
    ytChannelId: varchar('yt_channel_id', { length: 32 })
      .notNull()
      .references(() => ytChannel.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    description: text('description').notNull().default(''),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    /**
     * Nulo quando a duração é desconhecida — lives em andamento reportam `PT0S`.
     * Guardar zero em vez de nulo colocaria um slot de duração nula na grade, e o
     * player entraria em laço de troca.
     */
    durationSec: integer('duration_sec'),
    categoryId: varchar('category_id', { length: 8 }).notNull().default(''),
    tags: text('tags').array().notNull().default([]),

    // Campos de R13. Todos vêm de `videos.list` com part=status,contentDetails.
    embeddable: boolean('embeddable').notNull().default(false),
    privacyStatus: varchar('privacy_status', { length: 16 }).notNull().default('unknown'),
    uploadStatus: varchar('upload_status', { length: 16 }).notNull().default('unknown'),
    madeForKids: boolean('made_for_kids').notNull().default(false),
    blockedRegions: varchar('blocked_regions', { length: 2 }).array().notNull().default([]),
    allowedRegions: varchar('allowed_regions', { length: 2 }).array().notNull().default([]),
    hasContentRating: boolean('has_content_rating').notNull().default(false),

    liveState: varchar('live_state', { length: 8 }).notNull().default('none'),
    liveScheduledStart: timestamp('live_scheduled_start', { withTimezone: true }),
    liveActualStart: timestamp('live_actual_start', { withTimezone: true }),
    liveActualEnd: timestamp('live_actual_end', { withTimezone: true }),

    thumbnailUrl: text('thumbnail_url'),

    /**
     * Preenchido quando o vídeo falhou no player. É a memória entre sessões da
     * terceira camada de R13: sem ela, o mesmo vídeo quebrado voltaria à grade
     * amanhã e o usuário veria a mesma falha de novo.
     */
    unplayableAt: timestamp('unplayable_at', { withTimezone: true }),
    unplayableReason: text('unplayable_reason'),
    unplayableCode: integer('unplayable_code'),

    /** R3: base do prazo de 30 dias. */
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('yt_video_channel_idx').on(t.ytChannelId),
    index('yt_video_refreshed_idx').on(t.refreshedAt),
    // O pool é montado por canal e recência; este índice é o que sustenta R-A.
    index('yt_video_channel_published_idx').on(t.ytChannelId, t.publishedAt),
    index('yt_video_live_state_idx').on(t.liveState),
  ],
);

// ---------------------------------------------------------------------------
// Afinidade (R1) — as três fontes combinadas
// ---------------------------------------------------------------------------

export const userChannelAffinity = pgTable(
  'user_channel_affinity',
  {
    userId: varchar('user_id', { length: 64 })
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    ytChannelId: varchar('yt_channel_id', { length: 32 })
      .notNull()
      .references(() => ytChannel.id, { onDelete: 'cascade' }),
    /** Exibições vindas do import do Google Takeout. */
    takeoutCount: integer('takeout_count').notNull().default(0),
    isSubscribed: boolean('is_subscribed').notNull().default(false),
    isFavorite: boolean('is_favorite').notNull().default(false),
    /** Score do tracking interno, com decaimento já aplicado. */
    internalScore: real('internal_score').notNull().default(0),
    /** Score combinado em [0,1], materializado para o portão de inserção a quente. */
    combinedScore: real('combined_score').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.ytChannelId] }),
    // O top-K de afinidade é consultado a cada varredura de novidades.
    index('affinity_user_score_idx').on(t.userId, t.combinedScore),
  ],
);

export const watchEvent = pgTable(
  'watch_event',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    userId: varchar('user_id', { length: 64 })
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    videoId: varchar('video_id', { length: 16 }).notNull(),
    ytChannelId: varchar('yt_channel_id', { length: 32 }).notNull(),
    /** Segundos efetivamente assistidos. Abandonar em 5s não é sinal de gosto. */
    watchedSec: integer('watched_sec').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (t) => [index('watch_event_user_at_idx').on(t.userId, t.at)],
);

// ---------------------------------------------------------------------------
// Canais de TV e programação
// ---------------------------------------------------------------------------

export const tvChannel = pgTable(
  'tv_channel',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    userId: varchar('user_id', { length: 64 })
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Número do canal, para o zapping. */
    number: integer('number').notNull(),
    /** `ALL_SUBSCRIPTIONS` | `TOP_WATCHED` | `FAVORITES` | `CATEGORY` | `HASHTAG` | `CUSTOM` */
    sourceKind: varchar('source_kind', { length: 24 }).notNull(),
    /** Parâmetros da fonte: lista de canais, id de categoria, hashtag. */
    sourceSpec: jsonb('source_spec').notNull().default({}),
    /** `LIVE` | `VOD` | `BOTH` */
    mode: varchar('mode', { length: 8 }).notNull().default('VOD'),
    /** Sobrescritas de `GridConfig`: duração mínima, janela de re-exibição, etc. */
    filters: jsonb('filters').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tv_channel_user_number_idx').on(t.userId, t.number)],
);

/**
 * Grade materializada.
 *
 * A retenção de 60 dias serve às regras de não-repetição: "já exibido" e "canal usado
 * recentemente" são consultas locais nesta tabela, sem custo de cota. Passado esse
 * prazo o histórico não influencia mais nenhuma decisão e só ocupa espaço.
 */
export const scheduleSlot = pgTable(
  'schedule_slot',
  {
    tvChannelId: varchar('tv_channel_id', { length: 64 })
      .notNull()
      .references(() => tvChannel.id, { onDelete: 'cascade' }),
    /** Dia local (`YYYY-MM-DD`) a que o slot pertence. Metade do seed da grade. */
    dayKey: varchar('day_key', { length: 10 }).notNull(),
    seq: integer('seq').notNull(),
    videoId: varchar('video_id', { length: 16 }).notNull(),
    /** Desnormalizado de propósito: R-B consulta canal por slot a cada geração. */
    ytChannelId: varchar('yt_channel_id', { length: 32 }).notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    durationSec: integer('duration_sec').notNull(),
    /** Nível de relaxamento de R-B (0..3). >0 sinaliza pool estreito na interface. */
    relaxedTo: integer('relaxed_to').notNull().default(0),
    isHotInsert: boolean('is_hot_insert').notNull().default(false),
    /** Slot cortado antes do fim do vídeo, por falha no player. */
    truncated: boolean('truncated').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.tvChannelId, t.dayKey, t.seq] }),
    // Sintonizar é achar o slot que contém "agora": é a consulta mais frequente do app.
    index('schedule_slot_channel_window_idx').on(t.tvChannelId, t.startsAt, t.endsAt),
    // Retenção de 60 dias e "já exibido".
    index('schedule_slot_video_idx').on(t.videoId, t.startsAt),
    index('schedule_slot_starts_idx').on(t.startsAt),
  ],
);

/**
 * Log de mutações da grade — o que mantém a programação idêntica entre dispositivos.
 *
 * A grade materializada é `base(seed) + patches em ordem de seqNo`. O índice único em
 * `(tvChannelId, dayKey, seqNo)` é o que garante a ordem total exigida pelo replay:
 * sem ele, dois jobs concorrentes poderiam gravar o mesmo `seqNo` e o replay
 * divergiria silenciosamente entre dispositivos.
 */
export const schedulePatch = pgTable(
  'schedule_patch',
  {
    tvChannelId: varchar('tv_channel_id', { length: 64 })
      .notNull()
      .references(() => tvChannel.id, { onDelete: 'cascade' }),
    dayKey: varchar('day_key', { length: 10 }).notNull(),
    seqNo: integer('seq_no').notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull(),
    /** `HOT_INSERT` | `DROP_UNPLAYABLE` | `AFFINITY_REFLOW` */
    kind: varchar('kind', { length: 24 }).notNull(),
    videoId: varchar('video_id', { length: 16 }),
    reason: text('reason').notNull().default(''),
  },
  (t) => [primaryKey({ columns: [t.tvChannelId, t.dayKey, t.seqNo] })],
);

// ---------------------------------------------------------------------------
// Estado operacional
// ---------------------------------------------------------------------------

export const liveState = pgTable(
  'live_state',
  {
    ytChannelId: varchar('yt_channel_id', { length: 32 })
      .notNull()
      .references(() => ytChannel.id, { onDelete: 'cascade' })
      .primaryKey(),
    /** `live` | `upcoming` | `offline` */
    status: varchar('status', { length: 8 }).notNull().default('offline'),
    videoId: varchar('video_id', { length: 16 }),
    scheduledStart: timestamp('scheduled_start', { withTimezone: true }),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
    /** Polling dirigido: o worker só checa quem já venceu. */
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('live_state_next_check_idx').on(t.nextCheckAt)],
);

/**
 * Livro-caixa de cota (R2), por dia do Pacífico — que é quando a cota do YouTube
 * zera, e não à meia-noite do usuário.
 */
export const quotaLedger = pgTable('quota_ledger', {
  /** `YYYY-MM-DD` no fuso America/Los_Angeles. */
  day: varchar('day', { length: 10 }).primaryKey(),
  units: integer('units').notNull().default(0),
  byMethod: jsonb('by_method').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Progresso de jobs fatiados.
 *
 * Existe por causa do teto de 10 s do Vercel Cron no plano Hobby: cada invocação
 * processa uma fatia e grava o cursor, convergindo ao longo de várias execuções. Um job
 * que só deixa o estado consistente se rodar até o fim quebra no primeiro timeout.
 */
export const jobCursor = pgTable('job_cursor', {
  job: varchar('job', { length: 48 }).primaryKey(),
  /** Última chave processada. Semântica definida por cada job. */
  cursor: text('cursor'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Relações
// ---------------------------------------------------------------------------

export const userRelations = relations(user, ({ many }) => ({
  oauthAccounts: many(oauthAccount),
  tvChannels: many(tvChannel),
  affinities: many(userChannelAffinity),
}));

export const ytChannelRelations = relations(ytChannel, ({ many }) => ({
  videos: many(ytVideo),
}));

export const ytVideoRelations = relations(ytVideo, ({ one }) => ({
  channel: one(ytChannel, {
    fields: [ytVideo.ytChannelId],
    references: [ytChannel.id],
  }),
}));

export const tvChannelRelations = relations(tvChannel, ({ one, many }) => ({
  owner: one(user, { fields: [tvChannel.userId], references: [user.id] }),
  slots: many(scheduleSlot),
  patches: many(schedulePatch),
}));
