/**
 * Aritmética de tempo com fuso. A virada do dia define o seed da grade, então
 * errar isto significa grade diferente em dispositivos com fusos diferentes.
 * Tudo aqui é puro: o "agora" entra por parâmetro.
 */

export const MS_PER_SEC = 1_000;
export const MS_PER_DAY = 86_400_000;

const dayKeyFmt = new Map<string, Intl.DateTimeFormat>();
const partsFmt = new Map<string, Intl.DateTimeFormat>();

function getDayKeyFmt(timeZone: string): Intl.DateTimeFormat {
  let f = dayKeyFmt.get(timeZone);
  if (!f) {
    // en-CA formata como YYYY-MM-DD, que ordena lexicograficamente.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayKeyFmt.set(timeZone, f);
  }
  return f;
}

function getPartsFmt(timeZone: string): Intl.DateTimeFormat {
  let f = partsFmt.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFmt.set(timeZone, f);
  }
  return f;
}

/** Chave de dia local no formato `YYYY-MM-DD`. É metade do seed da grade. */
export function localDayKey(ms: number, timeZone: string): string {
  return getDayKeyFmt(timeZone).format(new Date(ms));
}

/**
 * Offset do fuso em ms no instante dado (positivo a leste de UTC).
 * Calculado lendo o relógio de parede local e reinterpretando-o como UTC.
 */
export function tzOffsetMs(ms: number, timeZone: string): number {
  const parts = getPartsFmt(timeZone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asIfUtc - Math.floor(ms / MS_PER_SEC) * MS_PER_SEC;
}

/**
 * Instante da meia-noite local do dia que contém `ms`.
 *
 * A dupla checagem de offset cobre a virada de horário de verão: o primeiro palpite
 * usa o offset do meio-dia UTC, que pode ser o offset "errado" para a meia-noite local.
 * Em fusos onde a meia-noite simplesmente não existe (adiantamento à meia-noite),
 * o resultado é o primeiro instante válido do dia — comportamento aceitável e coberto por teste.
 */
export function startOfLocalDay(ms: number, timeZone: string): number {
  const key = localDayKey(ms, timeZone);
  const wallMidnightAsUtc = Date.parse(`${key}T00:00:00Z`);
  const firstGuess = wallMidnightAsUtc - tzOffsetMs(wallMidnightAsUtc, timeZone);
  const refinedOffset = tzOffsetMs(firstGuess, timeZone);
  const candidate = wallMidnightAsUtc - refinedOffset;
  // Se o refinamento nos jogou para o dia anterior/seguinte, o palpite original era o correto.
  return localDayKey(candidate, timeZone) === key ? candidate : firstGuess;
}

/** Início do dia local seguinte. Usa +36h para atravessar dias de 23h com segurança. */
export function startOfNextLocalDay(ms: number, timeZone: string): number {
  return startOfLocalDay(startOfLocalDay(ms, timeZone) + MS_PER_DAY + MS_PER_DAY / 2, timeZone);
}

/** Decaimento exponencial por meia-vida. Retorna 1 no instante da publicação e →0 depois. */
export function halfLifeDecay(ageMs: number, halfLifeHours: number): number {
  if (halfLifeHours <= 0) return ageMs <= 0 ? 1 : 0;
  if (ageMs <= 0) return 1;
  const halfLifeMs = halfLifeHours * 3_600_000;
  return Math.pow(0.5, ageMs / halfLifeMs);
}
