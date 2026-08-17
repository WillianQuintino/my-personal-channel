/**
 * Conversão de duração ISO 8601 (formato de `contentDetails.duration`) para segundos.
 *
 * A duração é o que define a grade inteira: um vídeo com duração errada desalinha
 * todos os slots seguintes do dia. Por isso o parser é estrito e devolve `null` em
 * vez de zero para entrada inválida — zero seria aceito silenciosamente pela grade
 * e produziria um slot de duração nula, que trava o player em laço de troca.
 */

const ISO_DURATION =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

const SEC = {
  year: 31_536_000, // 365 dias — aproximação; nenhum vídeo do YouTube chega perto
  month: 2_592_000, // 30 dias
  week: 604_800,
  day: 86_400,
  hour: 3_600,
  minute: 60,
} as const;

/**
 * Converte `PT1H2M3S` em segundos. Devolve `null` se a entrada não for uma duração
 * ISO 8601 válida ou não tiver nenhum componente de tempo.
 */
export function parseIsoDuration(value: string | null | undefined): number | null {
  if (!value) return null;

  const m = ISO_DURATION.exec(value.trim());
  if (!m) return null;

  const [, years, months, weeks, days, hours, minutes, seconds] = m;

  // 'P' sozinho casa com a expressão, mas não é uma duração.
  if (![years, months, weeks, days, hours, minutes, seconds].some((x) => x !== undefined)) {
    return null;
  }

  const total =
    Number(years ?? 0) * SEC.year +
    Number(months ?? 0) * SEC.month +
    Number(weeks ?? 0) * SEC.week +
    Number(days ?? 0) * SEC.day +
    Number(hours ?? 0) * SEC.hour +
    Number(minutes ?? 0) * SEC.minute +
    Number(seconds ?? 0);

  return Math.round(total);
}

/**
 * Duração de um vídeo em segundos, ou `null` se não der para confiar.
 *
 * Lives em andamento vêm com `PT0S` — duração desconhecida, não duração zero. Tratar
 * as duas coisas como iguais colocaria um slot de zero segundo na grade, então o
 * chamador precisa distinguir, e é por isso que devolvemos `null` aqui.
 */
export function videoDurationSec(iso: string | null | undefined): number | null {
  const sec = parseIsoDuration(iso);
  if (sec === null || sec <= 0) return null;
  return sec;
}

/** Formata segundos como `h:mm:ss` ou `m:ss`, para o guia e para os cartões. */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(s / SEC.hour);
  const minutes = Math.floor((s % SEC.hour) / SEC.minute);
  const seconds = s % SEC.minute;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
