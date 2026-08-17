/**
 * Testes de R13 (vídeo injogável) e R3 (validade de 30 dias).
 *
 * R13 é a causa número um de canal travado, e R3 é uma exigência contratual das
 * Developer Policies — as duas merecem cobertura exaustiva.
 */

import { describe, expect, it } from 'vitest';
import {
  buildPool,
  CACHE_MAX_AGE_DAYS,
  CACHE_REFRESH_AFTER_DAYS,
  cacheAgeDays,
  checkEligibility,
  isCacheExpired,
  needsRefresh,
  toPoolVideo,
} from './eligibility.js';
import { NOW, videoRecord } from './fixtures.js';
import type { EligibilityOptions } from './eligibility.js';

const DAY = 86_400_000;

function opts(over: Partial<EligibilityOptions> = {}): EligibilityOptions {
  return {
    region: 'BR',
    minDurationSec: 60,
    maxDurationSec: 0,
    nowMs: NOW,
    ...over,
  };
}

describe('R3 — validade de 30 dias', () => {
  it('mede a idade do registro em dias', () => {
    expect(cacheAgeDays({ refreshedAtMs: NOW }, NOW)).toBe(0);
    expect(cacheAgeDays({ refreshedAtMs: NOW - 10 * DAY }, NOW)).toBe(10);
  });

  it('expira exatamente em 30 dias', () => {
    expect(isCacheExpired({ refreshedAtMs: NOW - 29.9 * DAY }, NOW)).toBe(false);
    expect(isCacheExpired({ refreshedAtMs: NOW - CACHE_MAX_AGE_DAYS * DAY }, NOW)).toBe(true);
    expect(isCacheExpired({ refreshedAtMs: NOW - 45 * DAY }, NOW)).toBe(true);
  });

  it('pede revalidação antes do prazo, com folga', () => {
    /*
     * A folga não é conservadorismo gratuito: sem ela, um job que atrasasse algumas
     * horas deixaria registros passarem dos 30 dias — isso é violação da política,
     * não atraso operacional.
     */
    expect(CACHE_REFRESH_AFTER_DAYS).toBeLessThan(CACHE_MAX_AGE_DAYS);
    expect(needsRefresh({ refreshedAtMs: NOW - 24 * DAY }, NOW)).toBe(false);
    expect(needsRefresh({ refreshedAtMs: NOW - 26 * DAY }, NOW)).toBe(true);
  });

  it('registro vencido é recusado antes de qualquer outra checagem', () => {
    // Mesmo um vídeo perfeitamente jogável não pode ser usado com dados vencidos.
    const verdict = checkEligibility(videoRecord({ refreshedAtMs: NOW - 31 * DAY }), opts());
    expect(verdict).toEqual({ eligible: false, reason: 'cache_expired' });
  });
});

describe('R13 — filtros de vídeo injogável', () => {
  it('aceita um vídeo público, embutível e processado', () => {
    expect(checkEligibility(videoRecord(), opts())).toEqual({ eligible: true });
  });

  it('recusa vídeo não-embutível', () => {
    expect(checkEligibility(videoRecord({ embeddable: false }), opts())).toEqual({
      eligible: false,
      reason: 'not_embeddable',
    });
  });

  it('trata embeddable ausente como não-embutível', () => {
    // Presumir que toca produziria erro 150 no ar, com o canal já no vídeo.
    expect(checkEligibility(videoRecord({ embeddable: false }), opts()).eligible).toBe(false);
  });

  it('recusa vídeo privado ou não listado', () => {
    for (const privacyStatus of ['private', 'unlisted', 'unknown']) {
      expect(checkEligibility(videoRecord({ privacyStatus }), opts())).toEqual({
        eligible: false,
        reason: 'not_public',
      });
    }
  });

  it('recusa upload ainda em processamento ou rejeitado', () => {
    for (const uploadStatus of ['uploaded', 'processing', 'rejected', 'failed']) {
      expect(checkEligibility(videoRecord({ uploadStatus }), opts())).toEqual({
        eligible: false,
        reason: 'not_processed',
      });
    }
  });

  it('recusa conteúdo com classificação indicativa (portão de idade)', () => {
    const v = videoRecord({ hasContentRating: true });
    expect(checkEligibility(v, opts())).toEqual({ eligible: false, reason: 'age_gated' });
  });

  describe('restrições regionais', () => {
    it('recusa quando a região do usuário está bloqueada', () => {
      const v = videoRecord({ blockedRegions: ['BR', 'PT'] });
      expect(checkEligibility(v, opts({ region: 'BR' }))).toEqual({
        eligible: false,
        reason: 'region_blocked',
      });
    });

    it('aceita quando o bloqueio é de outra região', () => {
      const v = videoRecord({ blockedRegions: ['DE', 'US'] });
      expect(checkEligibility(v, opts({ region: 'BR' })).eligible).toBe(true);
    });

    it('recusa quando existe lista de permitidos e a região não está nela', () => {
      const v = videoRecord({ allowedRegions: ['US', 'CA'] });
      expect(checkEligibility(v, opts({ region: 'BR' }))).toEqual({
        eligible: false,
        reason: 'region_not_allowed',
      });
    });

    it('aceita quando a região está na lista de permitidos', () => {
      const v = videoRecord({ allowedRegions: ['BR', 'US'] });
      expect(checkEligibility(v, opts({ region: 'BR' })).eligible).toBe(true);
    });

    it('compara região sem diferenciar maiúsculas', () => {
      const v = videoRecord({ blockedRegions: ['br'] });
      expect(checkEligibility(v, opts({ region: 'BR' })).eligible).toBe(false);
    });
  });

  it('recusa vídeo marcado como injogável depois de falhar no player', () => {
    const v = videoRecord({ id: 'ruim' });
    const verdict = checkEligibility(v, opts({ unplayableIds: new Set(['ruim']) }));
    expect(verdict).toEqual({ eligible: false, reason: 'marked_unplayable' });
  });

  describe('duração', () => {
    it('recusa duração desconhecida', () => {
      expect(checkEligibility(videoRecord({ durationSec: null }), opts())).toEqual({
        eligible: false,
        reason: 'unknown_duration',
      });
    });

    it('recusa Shorts abaixo do mínimo', () => {
      expect(checkEligibility(videoRecord({ durationSec: 45 }), opts())).toEqual({
        eligible: false,
        reason: 'too_short',
      });
    });

    it('aceita exatamente no mínimo', () => {
      expect(checkEligibility(videoRecord({ durationSec: 60 }), opts()).eligible).toBe(true);
    });

    it('respeita duração máxima quando configurada', () => {
      const v = videoRecord({ durationSec: 9_000 });
      expect(checkEligibility(v, opts({ maxDurationSec: 3_600 }))).toEqual({
        eligible: false,
        reason: 'too_long',
      });
      expect(checkEligibility(v, opts({ maxDurationSec: 0 })).eligible).toBe(true);
    });
  });

  describe('lives', () => {
    it('recusa live agendada sempre — não há nada para tocar ainda', () => {
      const v = videoRecord({ liveState: 'upcoming' });
      expect(checkEligibility(v, opts())).toEqual({
        eligible: false,
        reason: 'live_in_progress',
      });
    });

    it('recusa live em andamento em canal VOD', () => {
      const v = videoRecord({ liveState: 'live' });
      expect(checkEligibility(v, opts({ excludeLive: true }))).toEqual({
        eligible: false,
        reason: 'live_in_progress',
      });
    });

    it('aceita live em andamento quando o canal admite lives', () => {
      const v = videoRecord({ liveState: 'live', durationSec: 3_600 });
      expect(checkEligibility(v, opts({ excludeLive: false })).eligible).toBe(true);
    });
  });
});

describe('toPoolVideo', () => {
  it('converte um registro elegível', () => {
    const pv = toPoolVideo(videoRecord({ tags: ['minecraft'] }));
    expect(pv).toMatchObject({
      id: 'vid1',
      ytChannelId: 'UC1',
      durationSec: 600,
      categoryId: '20',
      tags: ['minecraft'],
    });
    expect(pv?.isLive).toBeUndefined();
  });

  it('marca isLive para transmissão em andamento', () => {
    expect(toPoolVideo(videoRecord({ liveState: 'live' }))?.isLive).toBe(true);
  });

  it('devolve null quando a duração é desconhecida', () => {
    expect(toPoolVideo(videoRecord({ durationSec: null }))).toBeNull();
  });
});

describe('buildPool', () => {
  it('separa elegíveis de recusados e conta os motivos', () => {
    const videos = [
      videoRecord({ id: 'ok1' }),
      videoRecord({ id: 'ok2' }),
      videoRecord({ id: 'sem-embed', embeddable: false }),
      videoRecord({ id: 'privado', privacyStatus: 'private' }),
      videoRecord({ id: 'short', durationSec: 30 }),
      videoRecord({ id: 'bloqueado', blockedRegions: ['BR'] }),
      videoRecord({ id: 'vencido', refreshedAtMs: NOW - 40 * DAY }),
    ];

    const { pool, rejected } = buildPool(videos, opts());

    expect(pool.map((v) => v.id)).toEqual(['ok1', 'ok2']);
    expect(rejected).toEqual({
      not_embeddable: 1,
      not_public: 1,
      too_short: 1,
      region_blocked: 1,
      cache_expired: 1,
    });
  });

  it('a contagem de recusas explica um pool vazio', () => {
    /*
     * Não é telemetria decorativa: é o que permite dizer "seu canal de #minecraft tem
     * 3 vídeos porque 40 não são embutíveis", em vez de mostrar um canal vazio sem
     * explicação nenhuma.
     */
    const videos = Array.from({ length: 40 }, (_, i) =>
      videoRecord({ id: `v${i}`, embeddable: false }),
    );
    const { pool, rejected } = buildPool(videos, opts());

    expect(pool).toEqual([]);
    expect(rejected['not_embeddable']).toBe(40);
  });

  it('pool vazio na entrada devolve resultado vazio, sem erro', () => {
    expect(buildPool([], opts())).toEqual({ pool: [], rejected: {} });
  });
});
