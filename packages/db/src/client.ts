/**
 * Criação da conexão.
 *
 * O driver é escolhido aqui e em nenhum outro lugar: os repositórios recebem o handle
 * por parâmetro e nunca importam `neon-http` nem `pglite`. É o que permite a mesma
 * suíte de testes rodar contra Postgres real em WASM, sem serviço para subir, enquanto
 * o código de produção fala com o Neon.
 */

import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export { schema };
export type Schema = typeof schema;

/**
 * Tipo comum aos drivers.
 *
 * `neon-http` e `pglite` produzem tipos concretos diferentes, mas ambos derivam de
 * `PgDatabase`. Tipar os repositórios contra a base é o que os mantém agnósticos —
 * a alternativa seria uma união, e aí cada consulta precisaria de narrowing.
 */
export type Db = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

export function createNeonDb(connectionString: string): Db {
  if (!connectionString) {
    throw new Error('DATABASE_URL vazia: a conexão com o Neon precisa da URL');
  }
  return drizzleNeon(neon(connectionString), { schema }) as unknown as Db;
}

/** Lê a URL do ambiente, com mensagem útil quando falta. */
export function databaseUrlFromEnv(env: Record<string, string | undefined>): string {
  const url = env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL não definida. Copie .env.example para .env e preencha com a URL do Neon.',
    );
  }
  return url;
}
