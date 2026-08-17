/**
 * Import do histórico de exibição do Google Takeout (R1).
 *
 * A API do YouTube não expõe histórico de exibição desde 2016 — as playlists
 * `watchHistory` e `watchLater` retornam `HL`/`WL` e listas vazias. O Takeout é a
 * única via **oficial** para o ranking retroativo de "canais que mais assisto";
 * raspar a página de histórico seria violação direta da ToS (R4).
 *
 * O parser é tolerante de propósito: o formato do Takeout muda sem aviso, e um campo
 * novo ou faltando não deve invalidar 50 mil linhas de histórico.
 */

export interface TakeoutEntry {
  readonly header?: string;
  readonly title?: string;
  readonly titleUrl?: string;
  readonly time?: string;
  readonly subtitles?: readonly { readonly name?: string; readonly url?: string }[];
  readonly activityControls?: readonly string[];
}

export interface WatchCount {
  readonly ytChannelId: string;
  readonly channelTitle: string;
  readonly count: number;
  /** epoch ms da exibição mais recente registrada para o canal. */
  readonly lastWatchedMs: number;
}

/** Extrai o id do canal de uma URL `https://www.youtube.com/channel/UC…`. */
export function channelIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = /\/channel\/(UC[\w-]{20,})/.exec(url);
  return m?.[1] ?? null;
}

/** Extrai o id do vídeo de uma URL `watch?v=…`. */
export function videoIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = /[?&]v=([\w-]{11})(?:&|$)/.exec(url);
  return m?.[1] ?? null;
}

export interface ParseTakeoutOptions {
  /**
   * Ignora exibições mais antigas que isto. O gosto de três anos atrás não deveria
   * pesar igual ao do mês passado no ranking.
   */
  readonly sinceMs?: number;
  /** Descarta entradas sem id de canal resolvível. */
  readonly requireChannelId?: boolean;
}

export interface TakeoutSummary {
  readonly counts: readonly WatchCount[];
  readonly totalEntries: number;
  readonly parsedEntries: number;
  readonly skipped: Readonly<Record<string, number>>;
}

/**
 * Agrega `watch-history.json` em contagem de exibições por canal.
 *
 * As entradas de "Anúncios exibidos" e as de vídeo removido não têm `subtitles` com
 * canal — são descartadas com o motivo registrado, para o usuário entender por que o
 * total importado é menor que o número de linhas do arquivo.
 */
export function parseWatchHistory(
  entries: readonly TakeoutEntry[],
  opts: ParseTakeoutOptions = {},
): TakeoutSummary {
  const byChannel = new Map<string, { title: string; count: number; lastMs: number }>();
  const skipped: Record<string, number> = {};
  let parsed = 0;

  const skip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  for (const entry of entries) {
    // O arquivo de histórico do YouTube traz também buscas e anúncios.
    if (entry.header !== undefined && entry.header !== 'YouTube') {
      skip('nao_e_youtube');
      continue;
    }
    if (!videoIdFromUrl(entry.titleUrl)) {
      skip('sem_id_de_video');
      continue;
    }

    const subtitle = entry.subtitles?.[0];
    const channelId = channelIdFromUrl(subtitle?.url);
    if (!channelId) {
      // Vídeo removido ou privado: o Takeout omite o canal.
      if (opts.requireChannelId !== false) {
        skip('sem_id_de_canal');
        continue;
      }
    }

    const timeMs = entry.time ? Date.parse(entry.time) : Number.NaN;
    if (Number.isNaN(timeMs)) {
      skip('sem_data');
      continue;
    }
    if (opts.sinceMs !== undefined && timeMs < opts.sinceMs) {
      skip('fora_da_janela');
      continue;
    }

    const key = channelId ?? `desconhecido:${subtitle?.name ?? '?'}`;
    const prev = byChannel.get(key);
    byChannel.set(key, {
      title: subtitle?.name ?? prev?.title ?? '',
      count: (prev?.count ?? 0) + 1,
      lastMs: Math.max(prev?.lastMs ?? 0, timeMs),
    });
    parsed++;
  }

  const counts: WatchCount[] = [...byChannel.entries()]
    .map(([ytChannelId, v]) => ({
      ytChannelId,
      channelTitle: v.title,
      count: v.count,
      lastWatchedMs: v.lastMs,
    }))
    // Desempate por id mantém a saída determinística, o que os testes exigem.
    .sort((a, b) =>
      b.count !== a.count
        ? b.count - a.count
        : a.ytChannelId < b.ytChannelId
          ? -1
          : a.ytChannelId > b.ytChannelId
            ? 1
            : 0,
    );

  return { counts, totalEntries: entries.length, parsedEntries: parsed, skipped };
}

/** Lê e agrega o conteúdo bruto do arquivo. Lança se o JSON não for um array. */
export function parseWatchHistoryJson(
  json: string,
  opts: ParseTakeoutOptions = {},
): TakeoutSummary {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error('watch-history.json deveria conter um array de entradas');
  }
  return parseWatchHistory(parsed as TakeoutEntry[], opts);
}

// ---------------------------------------------------------------------------
// Ranking combinado (R1)
// ---------------------------------------------------------------------------

export interface AffinityWeights {
  readonly takeout: number;
  readonly subscribed: number;
  readonly favorite: number;
  readonly internal: number;
}

export const DEFAULT_AFFINITY_WEIGHTS: AffinityWeights = {
  takeout: 0.4,
  subscribed: 0.15,
  favorite: 0.2,
  internal: 0.25,
};

export interface AffinityInput {
  readonly ytChannelId: string;
  /** Exibições vindas do Takeout. */
  readonly takeoutCount: number;
  readonly isSubscribed: boolean;
  readonly isFavorite: boolean;
  /** Score do tracking interno, já com decaimento aplicado. */
  readonly internalScore: number;
}

/**
 * Combina as três fontes num score de afinidade em [0, 1].
 *
 * As contagens do Takeout e do tracking interno são normalizadas pelo máximo do
 * conjunto, não por um teto fixo: quem assiste 20 vídeos por dia e quem assiste 2
 * merecem a mesma faixa dinâmica. Sem normalização relativa, um usuário leve teria
 * todos os canais com score perto de zero e o portão de inserção a quente nunca
 * abriria para ninguém.
 */
export function computeAffinity(
  inputs: readonly AffinityInput[],
  weights: AffinityWeights = DEFAULT_AFFINITY_WEIGHTS,
): Map<string, number> {
  const maxTakeout = Math.max(1, ...inputs.map((i) => i.takeoutCount));
  const maxInternal = Math.max(1, ...inputs.map((i) => i.internalScore));
  const totalWeight =
    weights.takeout + weights.subscribed + weights.favorite + weights.internal || 1;

  const out = new Map<string, number>();
  for (const input of inputs) {
    const raw =
      weights.takeout * (input.takeoutCount / maxTakeout) +
      weights.subscribed * (input.isSubscribed ? 1 : 0) +
      weights.favorite * (input.isFavorite ? 1 : 0) +
      weights.internal * (input.internalScore / maxInternal);
    out.set(input.ytChannelId, clamp01(raw / totalWeight));
  }
  return out;
}

/**
 * Decaimento exponencial do score interno, por meia-vida em dias.
 *
 * É o que faz o ranking acompanhar a mudança de gosto sem precisar de reimport:
 * o que você assistia muito no ano passado perde peso sozinho.
 */
export function decayInternalScore(
  events: readonly { readonly atMs: number; readonly watchedSec: number }[],
  nowMs: number,
  halfLifeDays = 30,
): number {
  const halfLifeMs = Math.max(1, halfLifeDays) * 86_400_000;
  let score = 0;
  for (const e of events) {
    const age = Math.max(0, nowMs - e.atMs);
    // Minutos assistidos, e não número de aberturas: abandonar em 5s não é sinal de gosto.
    const minutes = e.watchedSec / 60;
    score += minutes * Math.pow(0.5, age / halfLifeMs);
  }
  return score;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
