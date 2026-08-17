/**
 * Tipos do motor de grade. Tudo aqui é serializável e livre de I/O — o pacote
 * `core` nunca toca rede, banco ou `Date.now()`. O tempo entra sempre por parâmetro,
 * porque é a única forma de testar grade, deriva e virada de dia de forma determinística.
 */

export type VideoId = string;
export type YtChannelId = string;
export type TvChannelId = string;

/** Um vídeo elegível a entrar na grade. Já passou pelos filtros de conformidade. */
export interface PoolVideo {
  readonly id: VideoId;
  readonly ytChannelId: YtChannelId;
  readonly title: string;
  readonly durationSec: number;
  /** epoch ms */
  readonly publishedAt: number;
  readonly categoryId: string;
  readonly tags: readonly string[];
  /** `true` quando o vídeo é (ou foi) uma transmissão ao vivo. */
  readonly isLive?: boolean;
}

/**
 * Nível de relaxamento da regra R-B ("não repetir canal no mesmo dia").
 * O preenchimento tenta sempre do 0 para cima e registra onde parou, para que
 * a UI possa sinalizar pool degenerado em vez de falhar em silêncio.
 */
export enum RelaxLevel {
  /** Canal ainda não usado no dia. O ideal. */
  Strict = 0,
  /** Canal reaparece, mas a ≥6 slots de distância. */
  Distance6 = 1,
  /** Canal reaparece a ≥2 slots — nunca dois seguidos. */
  Distance2 = 2,
  /** Pool degenerado: aceita qualquer um. Sinalizado na UI. */
  Any = 3,
}

export interface ScheduleSlot {
  readonly seq: number;
  readonly videoId: VideoId;
  readonly ytChannelId: YtChannelId;
  /** epoch ms */
  readonly startsAtMs: number;
  /** epoch ms — sempre `startsAtMs + durationSec * 1000` */
  readonly endsAtMs: number;
  readonly durationSec: number;
  readonly relaxedTo: RelaxLevel;
  /** `true` se o slot entrou por inserção a quente (§2b), não pela grade base. */
  readonly isHotInsert: boolean;
  /**
   * `true` quando o slot foi cortado antes do fim do vídeo — o caso do vídeo que
   * começou a tocar e falhou. `durationSec` passa a ser o tempo que de fato foi ao
   * ar, e esta marca registra por que ele difere da duração do vídeo.
   */
  readonly truncated?: boolean;
}

/** Resultado de uma geração ou re-fluxo de grade. */
export interface Grid {
  readonly slots: readonly ScheduleSlot[];
  /** Fim da cobertura: `endsAtMs` do último slot. O dia seguinte encadeia aqui. */
  readonly coverageEndMs: number;
}

/** Afinidade normalizada por canal do YouTube, em [0, 1]. */
export type AffinityMap = ReadonlyMap<YtChannelId, number>;

/**
 * O que já foi ao ar, para as regras de não-repetição. Vem de `schedule_slot`
 * dos dias anteriores — consulta local, sem custo de quota.
 */
export interface AirHistory {
  /** Vídeos exibidos dentro da janela de re-exibição. */
  readonly airedVideoIds: ReadonlySet<VideoId>;
}

export interface GridConfig {
  /** Fuso do usuário, IANA (ex.: 'America/Sao_Paulo'). Define a virada do dia. */
  readonly timeZone: string;
  /** Cobertura mínima de uma grade diária. Padrão 86400. */
  readonly coverageSec: number;
  /** Janela em que um vídeo já exibido é despriorizado. Padrão 14 dias. */
  readonly rewatchWindowDays: number;
  /** Amplitude do jitter de desempate, em fração. Padrão 0.10 (±10%). */
  readonly jitterPct: number;
  /**
   * Largura da janela de recência de R-A, em horas. Padrão 6.
   *
   * É o botão que equilibra as duas metades da regra: janela menor faz a grade seguir
   * a cronologia mais de perto; janela maior dá mais espaço ao jitter e à afinidade
   * para variar a programação entre dias.
   */
  readonly recencyBucketHours: number;
  /** Duração mínima para entrar na grade. Padrão 60 (descarta Shorts). */
  readonly minDurationSec: number;
  /** Duração máxima, ou 0 para sem limite. */
  readonly maxDurationSec: number;
  /** Zona congelada à frente do relógio: o EPG já prometeu. Padrão 600. */
  readonly frozenHorizonSec: number;
  /** Teto de inserções a quente por dia, por canal de TV. Padrão 6. */
  readonly maxHotInsertsPerDay: number;
  /** Intervalo mínimo entre inserções a quente. Padrão 1200. */
  readonly minHotInsertGapSec: number;
  /** Meia-vida do impulso de recência, em horas. Padrão 6. */
  readonly recencyHalfLifeHours: number;
  /** Quantos canais do topo da afinidade são elegíveis a inserção a quente. Padrão 20. */
  readonly topKAffinity: number;
}

export const DEFAULT_GRID_CONFIG: GridConfig = {
  timeZone: 'America/Sao_Paulo',
  coverageSec: 86_400,
  rewatchWindowDays: 14,
  jitterPct: 0.1,
  recencyBucketHours: 6,
  minDurationSec: 60,
  maxDurationSec: 0,
  frozenHorizonSec: 600,
  maxHotInsertsPerDay: 6,
  minHotInsertGapSec: 1_200,
  recencyHalfLifeHours: 6,
  topKAffinity: 20,
};

/** Modo de conteúdo de um canal de TV. */
export type ChannelMode = 'LIVE' | 'VOD' | 'BOTH';

/** Registro de uma mutação da grade, para replay determinístico entre dispositivos. */
export interface SchedulePatch {
  readonly seqNo: number;
  readonly tvChannelId: TvChannelId;
  readonly dayKey: string;
  readonly appliedAtMs: number;
  readonly kind: 'HOT_INSERT' | 'DROP_UNPLAYABLE' | 'AFFINITY_REFLOW';
  readonly videoId: VideoId | null;
  readonly reason: string;
}
