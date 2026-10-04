/**
 * NYSE regular session: 09:30 to 16:00 America/New_York, Monday to Friday. Exchange holidays are not
 * modelled; a Vault's own price-freshness pill is the source of truth for whether deposits are open.
 */
export type MarketState = { open: boolean; label: string };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function nyParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: DAYS.indexOf(get("weekday")), minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;

export function marketState(now = new Date()): MarketState {
  const { day, minutes } = nyParts(now);
  const weekday = day >= 1 && day <= 5;
  if (weekday && minutes >= OPEN && minutes < CLOSE) return { open: true, label: "NYSE open · closes 16:00 ET" };
  let next = day;
  if (!weekday || minutes >= CLOSE) {
    do next = (next + 1) % 7; while (next === 0 || next === 6);
  }
  const when = next === day ? "09:30 ET" : `${DAYS[next]} 09:30 ET`;
  return { open: false, label: `NYSE closed · opens ${when}` };
}
