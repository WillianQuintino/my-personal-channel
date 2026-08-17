/**
 * Reexporta os utilitários de banco usados pelos testes dos jobs.
 *
 * Um só ponto de entrada em vez de dois imports (`@minhatv/db` e `@minhatv/db/testing`)
 * em cada arquivo de teste — e deixa explícito que os jobs são verificados contra o
 * mesmo Postgres em WASM que o pacote de dados usa.
 */

export {
  createTestDb,
  seedChannel,
  seedPool,
  seedTvChannel,
  seedUser,
  seedVideo,
  TEST_NOW,
  TEST_USER_ID,
  useTestDb,
} from '@minhatv/db/testing';

export {
  getDayGrid,
  getJobCursor,
  getLiveStates,
  listPatches,
  listVideosByChannels,
  quotaSpentToday,
  setFavorite,
  setSubscribed,
  slotAt,
  subscribedChannelIds,
  upsertLiveState,
} from '@minhatv/db';
