/**
 * Banco de testes: Postgres real em WASM, via PGlite.
 *
 * Escolha deliberada sobre as alternativas:
 *
 * - `pg-mem` emula Postgres e divergiria justamente onde o schema é interessante
 *   (arrays, `jsonb`, `timestamptz`, índices parciais).
 * - `services: postgres` no CI funcionaria, mas obrigaria Docker também na máquina de
 *   quem desenvolve — e não há Docker no ambiente de desenvolvimento deste projeto.
 *
 * PGlite é Postgres de verdade compilado para WASM: as mesmas migrations que rodam no
 * Neon rodam aqui, então os testes exercitam o SQL que vai para produção.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.js';
import { schema } from './client.js';

export interface TestDb {
  readonly db: Db;
  /** Apaga todas as linhas, preservando o schema. Bem mais rápido que recriar o banco. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Tabelas na ordem de truncamento.
 *
 * `TRUNCATE ... CASCADE` num só comando resolve as dependências de FK sozinho, então a
 * ordem aqui é só legibilidade.
 */
const ALL_TABLES = [
  'schedule_patch',
  'schedule_slot',
  'tv_channel',
  'watch_event',
  'user_channel_affinity',
  'live_state',
  'yt_video',
  'yt_channel',
  'oauth_account',
  '"user"',
  'quota_ledger',
  'job_cursor',
] as const;

/** Localiza `migrations/` subindo a partir deste arquivo, para funcionar em `src` e `dist`. */
function migrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, 'migrations');
    if (existsSync(candidate)) return candidate;
    dir = resolve(dir, '..');
  }
  throw new Error(
    'pasta migrations/ não encontrada — rode `pnpm --filter @minhatv/db generate` antes dos testes',
  );
}

/**
 * Cria um banco em memória com as migrations aplicadas.
 *
 * Aplicar as migrations de verdade (em vez de um `push` do schema) é o que faz os testes
 * cobrirem R3 e os índices como eles existirão em produção.
 */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;

  await migrate(db as never, { migrationsFolder: migrationsFolder() });

  return {
    db,
    reset: async () => {
      await client.exec(`truncate ${ALL_TABLES.join(', ')} cascade;`);
    },
    close: async () => {
      await client.close();
    },
  };
}

/**
 * Banco compartilhado por arquivo de teste.
 *
 * Criar um PGlite e rodar as migrations custa ~2 s; fazer isso por teste levava a suíte
 * a 90 s. Reusar a instância e truncar entre testes leva ao mesmo isolamento por uma
 * fração do tempo — e uma suíte lenta é uma suíte que se deixa de rodar.
 *
 * Uso típico:
 * ```ts
 * const ctx = useTestDb();
 * it('…', async () => { await seedUser(ctx.db); });
 * ```
 */
export function useTestDb(hooks: {
  beforeAll: (fn: () => Promise<void>) => void;
  afterAll: (fn: () => Promise<void>) => void;
  beforeEach: (fn: () => Promise<void>) => void;
}): { readonly db: Db } {
  let handle: TestDb | null = null;

  hooks.beforeAll(async () => {
    handle = await createTestDb();
  });

  hooks.afterAll(async () => {
    await handle?.close();
    handle = null;
  });

  hooks.beforeEach(async () => {
    await handle?.reset();
  });

  return {
    get db(): Db {
      if (!handle) throw new Error('banco de teste não inicializado: chame useTestDb no topo');
      return handle.db;
    },
  };
}

// ---------------------------------------------------------------------------
// Semeadura
// ---------------------------------------------------------------------------

export const TEST_USER_ID = 'user-teste';

/** Instante de referência das fixtures: 2026-08-17T12:00 em São Paulo. */
export const TEST_NOW = Date.UTC(2026, 7, 17, 15, 0, 0);

export interface SeedUserOptions {
  readonly id?: string;
  readonly email?: string;
  readonly region?: string;
  readonly timeZone?: string;
}

export async function seedUser(db: Db, opts: SeedUserOptions = {}): Promise<string> {
  const id = opts.id ?? TEST_USER_ID;
  await db
    .insert(schema.user)
    .values({
      id,
      email: opts.email ?? `${id}@exemplo.test`,
      region: opts.region ?? 'BR',
      timeZone: opts.timeZone ?? 'America/Sao_Paulo',
    })
    .onConflictDoNothing();
  return id;
}

export interface SeedChannelOptions {
  readonly id: string;
  readonly title?: string;
  readonly refreshedAtMs?: number;
  readonly uploadsPlaylistId?: string | null;
}

export async function seedChannel(db: Db, opts: SeedChannelOptions): Promise<void> {
  await db
    .insert(schema.ytChannel)
    .values({
      id: opts.id,
      title: opts.title ?? `Canal ${opts.id}`,
      uploadsPlaylistId:
        opts.uploadsPlaylistId === undefined ? `UU${opts.id.slice(2)}` : opts.uploadsPlaylistId,
      refreshedAt: new Date(opts.refreshedAtMs ?? TEST_NOW),
    })
    .onConflictDoNothing();
}

export interface SeedVideoOptions {
  readonly id: string;
  readonly ytChannelId: string;
  readonly durationSec?: number | null;
  /** Dias antes de `TEST_NOW`. Aceita fração. */
  readonly ageDays?: number;
  readonly embeddable?: boolean;
  readonly privacyStatus?: string;
  readonly uploadStatus?: string;
  readonly refreshedAtMs?: number;
  readonly liveState?: string;
  readonly blockedRegions?: readonly string[];
  readonly categoryId?: string;
  readonly tags?: readonly string[];
  readonly unplayableAtMs?: number | null;
}

export async function seedVideo(db: Db, opts: SeedVideoOptions): Promise<void> {
  const ageDays = opts.ageDays ?? 1;
  await db
    .insert(schema.ytVideo)
    .values({
      id: opts.id,
      ytChannelId: opts.ytChannelId,
      title: `Vídeo ${opts.id}`,
      publishedAt: new Date(TEST_NOW - ageDays * 86_400_000),
      durationSec: opts.durationSec === undefined ? 600 : opts.durationSec,
      categoryId: opts.categoryId ?? '20',
      tags: [...(opts.tags ?? [])],
      embeddable: opts.embeddable ?? true,
      privacyStatus: opts.privacyStatus ?? 'public',
      uploadStatus: opts.uploadStatus ?? 'processed',
      blockedRegions: [...(opts.blockedRegions ?? [])],
      liveState: opts.liveState ?? 'none',
      refreshedAt: new Date(opts.refreshedAtMs ?? TEST_NOW),
      unplayableAt:
        opts.unplayableAtMs === null || opts.unplayableAtMs === undefined
          ? null
          : new Date(opts.unplayableAtMs),
    })
    .onConflictDoNothing();
}

export interface SeedTvChannelOptions {
  readonly id: string;
  readonly userId?: string;
  readonly name?: string;
  readonly number?: number;
  readonly sourceKind?: string;
  readonly sourceSpec?: Record<string, unknown>;
  readonly mode?: string;
}

export async function seedTvChannel(db: Db, opts: SeedTvChannelOptions): Promise<void> {
  await db
    .insert(schema.tvChannel)
    .values({
      id: opts.id,
      userId: opts.userId ?? TEST_USER_ID,
      name: opts.name ?? `Canal ${opts.id}`,
      number: opts.number ?? 1,
      sourceKind: opts.sourceKind ?? 'ALL_SUBSCRIPTIONS',
      sourceSpec: opts.sourceSpec ?? {},
      mode: opts.mode ?? 'VOD',
    })
    .onConflictDoNothing();
}

/** Semeia `channels` canais × `perChannel` vídeos, com idades escalonadas. */
export async function seedPool(
  db: Db,
  channels: number,
  perChannel: number,
  durationSec = 600,
): Promise<void> {
  for (let c = 0; c < channels; c++) {
    const ytChannelId = `UC${String(c).padStart(4, '0')}`;
    await seedChannel(db, { id: ytChannelId });
    for (let v = 0; v < perChannel; v++) {
      await seedVideo(db, {
        id: `vid-c${c}-n${v}`,
        ytChannelId,
        ageDays: v + 1,
        durationSec,
      });
    }
  }
}
