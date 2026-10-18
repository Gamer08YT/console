/*
 * The clipboard, with the old way kept as the fallback.
 *
 * navigator.clipboard does not exist outside a secure context, and the console
 * is served over plain HTTP in hotspot mode - which is exactly the situation
 * where someone is reading a serial number off a BIOS screen and wants to paste
 * it somewhere. The textarea trick still works there.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through and try the old way */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
