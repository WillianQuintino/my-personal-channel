/**
 * Registro de jobs.
 *
 * Existe para que o agendador (GitHub Actions batendo em rotas da Vercel) e a CLI local
 * chamem exatamente o mesmo código. Um job registrado aqui é executável dos dois lados
 * sem adaptação, o que evita o modo de falha clássico: o job funciona na máquina de
 * quem desenvolve e nunca roda em produção porque o endpoint chama outra coisa.
 */

import { refreshAffinity, refreshPools, refreshSubscriptions } from './job-ingest.js';
import { hotInsertScan, materializeGrids, prunePrograms, purgeCache } from './job-grid.js';
import { detectLives } from './job-live.js';
import { listUserIds } from '@minhatv/db';
import { DEFAULT_BUDGET, type JobBudget, type JobDeps, type JobReport } from './types.js';

/** Cadência sugerida, para o workflow do agendador. */
export type Cadence = 'daily' | 'every15min' | 'every5min';

export interface JobDefinition {
  readonly name: string;
  readonly cadence: Cadence;
  /** `true` se o job consome cota da API. Os que não consomem rodam sem credenciais. */
  readonly usesQuota: boolean;
  readonly describe: string;
  run(deps: JobDeps, budget: JobBudget): Promise<JobReport>;
}

/**
 * Aplica um job por usuário e consolida um relatório único.
 *
 * Vários jobs de ingestão são por usuário (as inscrições são de alguém), mas o
 * agendador chama um endpoint só. Consolidar aqui evita repetir o laço em cada job.
 */
async function forEachUser(
  name: string,
  deps: JobDeps,
  budget: JobBudget,
  fn: (userId: string) => Promise<JobReport>,
): Promise<JobReport> {
  const usuarios = await listUserIds(deps.db);
  const relatorios: JobReport[] = [];

  for (const userId of usuarios) {
    relatorios.push(await fn(userId));
  }

  return {
    job: name,
    processed: relatorios.reduce((n, r) => n + r.processed, 0),
    quotaSpent: relatorios.reduce((n, r) => n + r.quotaSpent, 0),
    exhausted: relatorios.some((r) => r.exhausted),
    // Só está completo se **todos** os usuários terminaram a volta.
    completed: relatorios.length > 0 && relatorios.every((r) => r.completed),
    errors: relatorios.flatMap((r) => r.errors),
    details: { users: usuarios.length, budget },
  };
}

export const JOBS: readonly JobDefinition[] = [
  {
    name: 'refreshSubscriptions',
    cadence: 'daily',
    usesQuota: true,
    describe: 'Sincroniza inscrições e resolve as playlists de uploads',
    run: (deps, budget) =>
      forEachUser('refreshSubscriptions', deps, budget, (userId) =>
        refreshSubscriptions(deps, userId, budget),
      ),
  },
  {
    name: 'refreshPools',
    cadence: 'every15min',
    usesQuota: true,
    describe: 'Atualiza os pools de vídeo, em camadas e retomável',
    run: (deps, budget) =>
      forEachUser('refreshPools', deps, budget, (userId) => refreshPools(deps, userId, budget)),
  },
  {
    name: 'refreshAffinity',
    cadence: 'daily',
    usesQuota: false,
    describe: 'Recalcula o ranking de afinidade a partir das três fontes',
    run: (deps, budget) => refreshAffinity(deps, budget),
  },
  {
    name: 'detectLives',
    cadence: 'every5min',
    usesQuota: true,
    describe: 'Detecta transmissões ao vivo pelo caminho barato',
    run: (deps, budget) => detectLives(deps, budget),
  },
  {
    name: 'materializeGrids',
    cadence: 'daily',
    usesQuota: false,
    describe: 'Materializa a grade de hoje e de amanhã',
    run: (deps, budget) => materializeGrids(deps, budget),
  },
  {
    name: 'hotInsertScan',
    cadence: 'every15min',
    usesQuota: false,
    describe: 'Insere na grade do dia os vídeos novos que passam pelo portão',
    run: (deps, budget) => hotInsertScan(deps, budget),
  },
  {
    name: 'purgeCache',
    cadence: 'daily',
    usesQuota: false,
    describe: 'R3: apaga o cache com mais de 30 dias',
    run: (deps) => purgeCache(deps),
  },
  {
    name: 'prunePrograms',
    cadence: 'daily',
    usesQuota: false,
    describe: 'Retenção de 60 dias do histórico de programação',
    run: (deps) => prunePrograms(deps),
  },
];

export function findJob(name: string): JobDefinition | undefined {
  return JOBS.find((j) => j.name === name);
}

export function jobsByCadence(cadence: Cadence): readonly JobDefinition[] {
  return JOBS.filter((j) => j.cadence === cadence);
}

/**
 * Executa um job por nome.
 *
 * Erro de job desconhecido é explícito: um endpoint com nome errado falharia em silêncio
 * de outra forma, e um cron que não faz nada é pior que um cron que quebra.
 */
export async function runJob(
  name: string,
  deps: JobDeps,
  budget: JobBudget = DEFAULT_BUDGET,
): Promise<JobReport> {
  const job = findJob(name);
  if (!job) {
    throw new Error(
      `job desconhecido: ${name}. Disponíveis: ${JOBS.map((j) => j.name).join(', ')}`,
    );
  }
  if (job.usesQuota && !deps.yt) {
    throw new Error(`job ${name} consome cota e precisa do cliente da API`);
  }
  return job.run(deps, budget);
}
