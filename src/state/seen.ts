/*
 * Counting the devices in use, with the operator's consent: when the update
 * check is on and asks the project's own address, the browser also tells
 * check.espkvm.io this device's random id (installId, made on the device, not
 * taken from the hardware), its board and its version - at most once a day.
 * The device itself still never reaches out. A failed report changes nothing.
 */

export const SEEN_URL = "https://check.espkvm.io/v1/seen";
/* The hosts that publish the project's own builds. A fork's manifest is not counted. */
const OWN_HOSTS = new Set(["fw.espkvm.io", "espkvm.github.io"]);
const SEEN_KEY = "espkvm.seen";

/** The report's address, or null when this check is not one to count. */
export function seenUrl(
  manifestUrl: string,
  id: string | undefined,
  board: string | undefined,
  version: string | undefined,
): string | null {
  let host = "";
  try {
    host = new URL(manifestUrl).hostname;
  } catch {
    return null;
  }
  if (!OWN_HOSTS.has(host) || !id || !/^[0-9a-f]{32}$/.test(id)) return null;
  const q = new URLSearchParams({ id, board: board ?? "", ver: version ?? "" });
  return `${SEEN_URL}?${q}`;
}

/** Send the report unless this device was reported today from this browser. */
export function reportSeen(url: string | null, id: string | undefined, today = new Date()) {
  if (!url || !id) return;
  const day = today.toISOString().slice(0, 10);
  const key = `${SEEN_KEY}.${id}`;
  try {
    if (localStorage.getItem(key) === day) return;
    localStorage.setItem(key, day);
  } catch {
    /* no storage: the server counts a device once a month anyway */
  }
  fetch(url, {
    method: "POST",
    mode: "no-cors",
    cache: "no-store",
    credentials: "omit",
    keepalive: true,
  }).catch(() => {
    /* nobody to tell; the update check itself already worked */
  });
}
