/*
 * A fully in-browser stand-in for the device, for the static demo at /demo/.
 * It patches fetch and WebSocket so the real console runs with no device behind
 * it: GETs are served from fixtures captured from actual firmware (so the demo
 * matches the product), settings changes are kept in memory, input is swallowed,
 * and the video screen is drawn locally (see ScreenView's demo path).
 *
 * This whole module is only imported when the app is built with `--mode demo`
 * (see main.ts), so it is tree-shaken out of the firmware bundle entirely.
 */
import capabilities from "./fixtures/capabilities.json";
import pins from "./fixtures/pins.json";
import schema from "./fixtures/schema.json";
import settingsFixture from "./fixtures/settings.json";
import systemInfo from "./fixtures/system-info.json";
import videoStatus from "./fixtures/video-status.json";
import storageImages from "./fixtures/storage-images.json";
import usbprobe from "./fixtures/usbprobe.json";
import systemLogText from "./fixtures/system-log.txt?raw";
import { DemoSerial } from "./serial";
import authSession from "./fixtures/auth-session.json";
import {
  demoAsk,
  demoCrash,
  demoKeys,
  demoLauncher,
  demoMachine,
  demoMedia,
  demoMountMedia,
  demoPower,
  demoScene,
  demoBox,
  demoCecBox,
  demoCecKey,
  demoCecPower,
  demoSceneMs,
  demoScreenText,
} from "./machine";
import {
  demoCaptureDelete,
  demoCaptures,
  demoCaptureSearch,
  demoFile,
  demoRecordEvent,
  demoRecordStart,
  demoRecordStatus,
  demoRecordStop,
  demoScreenshot,
} from "./captures";

type Json = Record<string, unknown>;

/* Settings the visitor changes live here, so toggles and dropdowns behave. */
let settings: Json = { ...(settingsFixture as Json) };

/* Device profiles as the firmware keeps them (kvm_config/kvm_profiles.c):
   `settings` is Default, a profile holds only its own values. */
interface DemoProfile {
  id: number;
  name: string;
  match?: { cecName: string; cecVendor: string; usbOs: string };
  set?: Json;
}
const PROFILE_KEYS = new Set(
  (schema as { settings: { key: string; profile?: boolean }[] }).settings
    .filter((x) => x.profile)
    .map((x) => x.key),
);
const PRESETS = [
  {
    id: "steamdeck",
    name: "Steam Deck",
    match: { cecName: "Steam Deck", cecVendor: "e0319e", usbOs: "" },
    set: { target_os: 3, mouse_mode: 1, ptr_desk_w: 0, ptr_desk_h: 0, ui_hidden: "netlog,serial" },
  },
  {
    id: "switch",
    name: "Nintendo Switch",
    match: { cecName: "Nintendo", cecVendor: "0009bf", usbOs: "" },
    set: { usb_pad: 2, ui_hidden: "copy,keyboard,keylock,netlog,padmouse,select,serial" },
  },
  {
    id: "androidtv",
    name: "Android TV",
    match: { cecName: "", cecVendor: "", usbOs: "android" },
    set: { target_os: 4, mouse_mode: 1, ui_hidden: "copy,netlog,select,serial" },
  },
  {
    id: "mitvstick",
    name: "Mi TV Stick",
    match: { cecName: "Mi TV Stick", cecVendor: "", usbOs: "" },
    set: {
      target_os: 4,
      mouse_mode: 1,
      ui_hidden: "copy,gamepad,keyboard,keylock,netlog,padmouse,select,serial,touch",
    },
  },
];
let profileActive = 0;
let profileManual = false;
let profileList: DemoProfile[] = [{ id: 0, name: "Default" }];

function activeDemoProfile(): DemoProfile | undefined {
  return profileList.find((p) => p.id === profileActive);
}

/** What /api/v1/settings shows: Default with the active profile's values over it. */
function effectiveSettings(): Json {
  return { ...settings, ...(activeDemoProfile()?.set ?? {}) };
}

/* The first-run question: asked once per browser here, as the device asks
   once after its first password. */
const WELCOME_KEY = "espkvm.demo.welcome";
let profileWelcome = (() => {
  try {
    return localStorage.getItem(WELCOME_KEY) !== "done";
  } catch {
    return true;
  }
})();
const declinedPresets = new Set<string>();

/* The same rule as suggestion() in kvm_profiles.c: a device that names itself
   over CEC, no profile that fits it, a preset that does. */
function demoSuggest(): string | undefined {
  const name = cecBox.name.toLowerCase();
  const fits = (m: { cecName: string; cecVendor: string }) =>
    (m.cecName !== "" && name.startsWith(m.cecName.toLowerCase())) || (m.cecVendor !== "" && m.cecVendor === cecBox.vendor);
  if (profileManual && profileActive !== 0) return undefined;
  if (profileList.some((p) => p.match && fits(p.match))) return undefined;
  return PRESETS.find((p) => !declinedPresets.has(p.id) && fits(p.match))?.id;
}

function profilesJson(): Json {
  return {
    welcome: profileWelcome,
    suggest: demoSuggest(),
    active: profileActive,
    manual: profileManual,
    max: 8,
    profiles: profileList,
    presets: PRESETS,
    seen: { cecName: cecBox.name, cecVendor: cecBox.vendor, usbOs: "linux" },
    reboot: false,
  };
}

/* Screen areas, as kvm_regions keeps them; what each "sees" is made up. */
let demoRegions: Json[] = [];
function regionsJson(): Json {
  const t = performance.now() / 1000;
  return {
    max: 8,
    regions: demoRegions.map((r, i) => {
      const diff = Math.max(0, Math.round(4 + 4 * Math.sin(t / 3 + i)));
      const active = r.mode === "still" ? Math.sin(t / 7 + i) > 0.3 : diff >= Number(r.threshold ?? 5);
      return {
        ...r,
        live: {
          seen: true,
          active,
          diff,
          events: Math.floor(t / 9 + i),
          colour: "grey",
          colourPct: 70,
          rgb: "#5a6270",
          ...(r.mode === "still" ? { stillMs: Math.round(((t + i * 5) % 40) * 1000) } : {}),
        },
      };
    }),
  };
}
async function demoRegionsPost(path: string, body: Json): Promise<Response> {
  if (path === "/api/v1/regions/remember") {
    const r = demoRegions.find((x) => x.id === body.id);
    if (!r) return json({ error: "no such area" }, 404);
    r.hasRef = true;
    return json(regionsJson());
  }
  const list = (body.regions as Json[] | undefined) ?? [];
  if (list.length > 8) return json({ error: "eight areas at most" }, 400);
  const used = new Set(list.map((r) => Number(r.id)).filter((n) => n >= 1 && n <= 8));
  let next = 1;
  demoRegions = list.map((r) => {
    let id = Number(r.id);
    if (!(id >= 1 && id <= 8)) {
      while (used.has(next)) next++;
      id = next;
      used.add(id);
    }
    return { ...r, id, hasRef: Boolean(r.hasRef) };
  });
  return json(regionsJson());
}

async function demoProfiles(path: string, body: Json): Promise<Response> {
  const id = Number(body.id ?? -1);
  const found = profileList.find((p) => p.id === id);
  switch (path) {
    case "/api/v1/profiles": {
      if (profileList.length > 8) return json({ error: "there are already 8 profiles" }, 409);
      const from = String(body.from ?? "current");
      const preset = PRESETS.find((p) => p.id === from);
      if (!preset && from !== "current" && from !== "empty") return json({ error: `no preset '${from}'` }, 404);
      let next = 1;
      while (profileList.some((p) => p.id === next)) next++;
      const copy = from === "current" ? { ...(activeDemoProfile()?.set ?? {}) } : {};
      profileList = [
        ...profileList,
        {
          id: next,
          name: String(body.name || preset?.name || "New profile"),
          match: (body.match as DemoProfile["match"]) ??
            (preset ? { ...preset.match } : { cecName: "", cecVendor: "", usbOs: "" }),
          set: preset ? { ...preset.set } : copy,
        },
      ].sort((a, b) => a.id - b.id);
      if (body.select !== false) {
        profileActive = next;
        profileManual = true;
      }
      return json(profilesJson());
    }
    case "/api/v1/profiles/update": {
      if (id === 0) return json({ error: "Default is changed through /api/v1/settings" }, 409);
      if (!found) return json({ error: `no profile ${id}` }, 404);
      if (typeof body.name === "string" && body.name) found.name = body.name;
      if (body.match) found.match = body.match as DemoProfile["match"];
      const set: Json = { ...(found.set ?? {}), ...((body.set as Json) ?? {}) };
      for (const k of (body.unset as string[]) ?? []) delete set[k];
      found.set = set;
      return json(profilesJson());
    }
    case "/api/v1/profiles/delete":
      if (id === 0) return json({ error: "Default cannot be deleted" }, 409);
      if (!found) return json({ error: "no such profile" }, 404);
      profileList = profileList.filter((p) => p !== found);
      if (profileActive === id) {
        profileActive = 0;
        profileManual = false;
      }
      return json(profilesJson());
    case "/api/v1/profiles/dismiss":
      if (body.welcome === true) {
        profileWelcome = false;
        try {
          localStorage.setItem(WELCOME_KEY, "done");
        } catch {
          /* asked again next time */
        }
      }
      if (typeof body.preset === "string") {
        if (!PRESETS.some((p) => p.id === body.preset)) return json({ error: "no such preset" }, 400);
        declinedPresets.add(body.preset);
      }
      return json(profilesJson());
    case "/api/v1/profiles/select":
      if (!found) return json({ error: "no such profile" }, 404);
      profileActive = id;
      profileManual = true;
      return json(profilesJson());
  }
  return json({ error: "not found" }, 404);
}

/* The card's contents, so an uploaded image joins the list. */
let images: Json = { ...(storageImages as Json) };

/* A visitor who does nothing gets an image loaded for them, and that happens
   inside the machine. Bring the console's own idea of the drive back in step, or
   Media would show "ejected" while the screen is plainly booting something. */
function syncMedia() {
  const m = demoMedia();
  if (settings.msc_image === m.image && Boolean(settings.msc_enable) === m.exposed) return;
  settings = { ...settings, msc_image: m.image, msc_enable: m.exposed };
  images = { ...images, active: m.image };
}

/* Whether the demo is serving an "operator" certificate, so the TLS panel can be
   tried out (install flips it on, revert flips it off). No real restart happens. */
let tlsCustom = false;
/* A Let's Encrypt certificate for the made-up tailnet name, got 20 days ago. */
let acmeIssued = Math.floor(Date.now() / 1000) - 20 * 86400;
function demoAcme() {
  const name = "espkvm.tail1a2b3c.ts.net";
  return {
    enabled: settings.ts_cert === true,
    tailscale: true,
    domain: name,
    name,
    busy: false,
    step: "Done",
    error: "",
    cert: name,
    expires: acmeIssued + 90 * 86400,
    staging: false,
    lastTry: acmeIssued,
    nextTry: 0,
  };
}
/* The demo's answer to "find chats" - nothing until the button is pressed. */
let tgFind: Json = { state: "idle", error: "", bot: "", chats: [] };

/* The captured status has no HDMI source (signal:false). Present a live picture
   instead, so the demo shows the interface working rather than "No signal". */
const DEMO_STATUS = {
  ...(videoStatus as Json),
  signal: true,
  width: 1280,
  height: 720,
  fps: 24,
  kbps: 8500,
  viewers: 1,
  wsClients: 1,
  imgClients: 0,
  codec: "mjpeg",
};

/* What the fake machine is doing right now, in the shape the two endpoints that
   describe a screen expect. */
function liveStatus(): Json {
  const m = demoMachine();
  return {
    ...DEMO_STATUS,
    signal: m.signal,
    textMode: m.textMode,
    /* 60 frames a second since the page opened, the last one just now. */
    frames: Math.floor(performance.now() * 0.06),
    frameAgeMs: m.signal ? Math.floor(performance.now() % 17) : 4200,
    fps: Math.round(drift(24, 1.6, 11) * 10) / 10,
    kbps: Math.round(drift(8500, 900, 9)),
    record: { ...((videoStatus as Json).record as Json), ...demoRecordStatus() },
  };
}

/* An update in the demo really does install: the version it reports afterwards
   is kept here, so the console's verdict after its reload is the true one. */
const VERSION_KEY = "espkvm-demo-version";
const OTHER_KEY = "espkvm-demo-other";
const NEXT_VERSION = "v.0.60.1";
const fixtureOta = (systemInfo as { ota: { version: string }[] }).ota;
function stored(key: string, fallback: string): string {
  try {
    return sessionStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
const installedVersion = () => stored(VERSION_KEY, fixtureOta[0].version);
const otherVersion = () => stored(OTHER_KEY, fixtureOta[1].version);
/* A new image goes to the spare slot, and the running one becomes the spare. */
/* When an update on trial goes back on its own (Date.now() ms), 0 for none. */
const TRIAL_KEY = "espkvm-demo-trial";
function trialLeft(): number {
  const until = Number(stored(TRIAL_KEY, "0"));
  if (!until) return 0;
  const left = Math.ceil((until - Date.now()) / 1000);
  if (left > 0) return left;
  /* Nobody kept it: back to the old one, as the device would. */
  bootInto(otherVersion(), installedVersion());
  return 0;
}

function bootInto(version: string, other: string, trial = 0) {
  try {
    sessionStorage.setItem(VERSION_KEY, version);
    sessionStorage.setItem(OTHER_KEY, other);
    sessionStorage.setItem(TRIAL_KEY, trial ? String(Date.now() + 7000 + trial * 1000) : "0");
  } catch {
    /* a private window: the verdict will simply say the old version */
  }
  awayUntil = performance.now() + 7000;
}
/* Set while the device is "away" after an update: reads fail, exactly as they
   would against a device that is restarting. */
let awayUntil = 0;

/* Numbers a device would never hold still: a slow thermal drift and the memory
   moving under it, so the diagnostics panel looks alive rather than painted. */
function drift(base: number, swing: number, seconds: number): number {
  const t = performance.now() / 1000;
  return base + Math.sin(t / seconds) * swing + Math.sin(t / (seconds * 0.37)) * swing * 0.3;
}

function liveInfo(): Json {
  const m = demoMachine();
  const base = systemInfo as Json;
  const version = installedVersion();
  return {
    ...base,
    version,
    trialSeconds: trialLeft(),
    ota: [
      { label: "ota_0", version, state: trialLeft() ? "pending" : "valid", running: true, boot: true },
      { label: "ota_1", version: otherVersion(), state: "valid", running: false, boot: false },
    ],
    atx: { enabled: true, known: true, on: m.powerOn },
    agent: { port: true, connected: true },
    uptimeSeconds: Math.round(performance.now() / 1000) + 3600,
    tempC: Math.round(drift(41, 2.5, 26) * 10) / 10,
    heapFree: Math.round(drift(268000, 9000, 17)),
    psramFree: Math.round(drift(24_900_000, 320_000, 31)),
  };
}

/* Installing a published release: the device downloads it itself. Here the
   progress climbs over a few seconds and then the device goes away. */
const install = { state: "idle", percent: 0, version: "", message: "" };
function installStart(version: string, trial = 0): string | null {
  if (install.state === "running") return "an install is already running";
  if (trialLeft()) return "the last update is still on trial: keep it or roll it back first";
  if (!/^v\.\d/.test(version)) return "not a release tag";
  Object.assign(install, { state: "running", percent: -1, version, message: "connecting" });
  let pct = 0;
  const step = () => {
    pct += 9;
    if (pct < 100) {
      Object.assign(install, { percent: pct, message: `downloading ${pct}%` });
      setTimeout(step, 350);
      return;
    }
    Object.assign(install, { state: "done", percent: 100, message: "installed; restarting" });
    setTimeout(() => {
      bootInto(version, installedVersion(), trial);
      Object.assign(install, { state: "idle", percent: 0, version: "", message: "" });
    }, 800);
  };
  setTimeout(step, 600);
  return null;
}

let demoLogNext = 0;
let demoNetNext = 0;
const DEMO_NETLOG = [
  "[    3.412870] netconsole: network logging started",
  "[    3.520114] systemd[1]: Started Journal Service.",
  "[    4.101772] EXT4-fs (mmcblk0p2): re-mounted. Quota mode: none.",
  "[    5.002219] brcmfmac: brcmf_fw_alloc_request: using brcm/brcmfmac43455-sdio for chip BCM4345/6",
  "[    6.880341] IPv6: ADDRCONF(NETDEV_CHANGE): eth0: link becomes ready",
  "[    7.113540] bcmgenet fd580000.ethernet eth0: Link is Up - 1Gbps/Full - flow control rx/tx",
  "",
].join("\n");

/* A download from a URL, played out over a few seconds: nothing is fetched,
   but the file shows up on the card (or the rescue slot fills) at the end. */
type DemoFetch = {
  state: string;
  dest: string;
  url: string;
  name: string;
  total: number;
  startedAt: number;
  message: string;
};
let demoFetch: DemoFetch | null = null;
const DEMO_FETCH_MS = 6000;

function fetchStatus(): Json {
  const f = demoFetch;
  if (!f) return { state: "idle", bytes: 0, total: -1, rateBps: 0, message: "" };
  if (f.state === "running") {
    const t = (Date.now() - f.startedAt) / DEMO_FETCH_MS;
    if (t >= 1) {
      f.state = "done";
      f.message = "done";
      if (f.dest === "rescue") {
        images = { ...images, rescue: { ...(images.rescue as Json), hasImage: true } };
      } else {
        const list = (images.images as Json[]).filter((i) => i.name !== f.name);
        images = { ...images, images: [...list, { name: f.name, size: f.total }] };
      }
    } else {
      return {
        ...f,
        bytes: Math.round(f.total * t),
        rateBps: f.total / (DEMO_FETCH_MS / 1000),
      };
    }
  }
  return { ...f, bytes: f.state === "done" ? f.total : 0, rateBps: 0 };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}


/*
 * A pretend runbook engine. It walks the script's lines on a timer and a wait
 * "matches" after two seconds, so the Automation panel shows a run the way the
 * device would report one. The demo machine's screen is not consulted.
 */
const runbook = {
  state: "idle",
  name: "",
  step: 0,
  steps: 0,
  line: "",
  message: "nothing has run",
  elapsedMs: 0,
};
let runbookTimer: ReturnType<typeof setTimeout> | null = null;
let runbookStarted = 0;

function runbookStatus() {
  return {
    ...runbook,
    elapsedMs: runbook.state === "running" ? Date.now() - runbookStarted : runbook.elapsedMs,
  };
}

function runbookStart(name: string): 202 | 404 | 409 {
  let list: { name: string; script: string }[] = [];
  try {
    list = JSON.parse(String(settings.runbooks_json ?? "[]"));
  } catch {
    list = [];
  }
  const rb = list.find((r) => r.name === name);
  if (!rb) return 404;
  if (runbook.state === "running") return 409;
  const lines = rb.script
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  Object.assign(runbook, { state: "running", name, step: 0, steps: lines.length, line: "", message: "running" });
  runbookStarted = Date.now();
  const advance = () => {
    if (runbook.step >= lines.length) {
      Object.assign(runbook, { state: "done", message: "done", elapsedMs: Date.now() - runbookStarted });
      runbookTimer = null;
      return;
    }
    runbook.step += 1;
    runbook.line = lines[runbook.step - 1];
    runbookTimer = setTimeout(advance, /^(wait|gone)\b/i.test(runbook.line) ? 2000 : 600);
  };
  advance();
  return 202;
}

function runbookStop(): boolean {
  if (runbook.state !== "running") return false;
  if (runbookTimer) clearTimeout(runbookTimer);
  runbookTimer = null;
  Object.assign(runbook, {
    state: "stopped",
    message: `stopped at step ${runbook.step}`,
    elapsedMs: Date.now() - runbookStarted,
  });
  return true;
}

async function bodyJson(init?: RequestInit, req?: Request): Promise<Json> {
  try {
    if (init?.body) return JSON.parse(String(init.body));
    if (req) return (await req.clone().json()) as Json;
  } catch {
    /* fall through */
  }
  return {};
}

/* Returns a Response for a known route, or null to let the real fetch run
   (static assets, anything not part of the device API). */
/* The release the demo offers, and an image of the right size to "download".
   Fetching the real one would push megabytes at a visitor for nothing. */
const IMAGE_BYTES = 1_612_800;

function fakeManifest(): Json {
  return {
    version: NEXT_VERSION,
    file: `espkvm-${NEXT_VERSION}-p4-eth.bin`,
    size: IMAGE_BYTES,
    released: new Date().toISOString().slice(0, 10),
    notes: "https://github.com/espkvm/espkvm/releases",
  };
}

/* Delivered in pieces over a couple of seconds, because a progress bar that
   jumps from nothing to everything shows nothing. */
function fakeImage(): Response {
  const chunk = new Uint8Array(64 * 1024);
  /* The console checks the first byte before sending: an ESP image starts 0xE9,
     and it is right to refuse anything else. */
  const first = new Uint8Array(chunk.length);
  first[0] = 0xe9;
  let sent = 0;
  const body = new ReadableStream({
    async pull(c) {
      if (sent >= IMAGE_BYTES) {
        c.close();
        return;
      }
      await new Promise((r) => setTimeout(r, 60));
      const n = Math.min(chunk.length, IMAGE_BYTES - sent);
      const from = sent === 0 ? first : chunk;
      sent += n;
      c.enqueue(from.slice(0, n));
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(IMAGE_BYTES) },
  });
}

let demoClipboard = "ssh anna@build-box";

async function route(
  path: string,
  method: string,
  init?: RequestInit,
  req?: Request,
  search = "",
): Promise<Response | null> {
  /* While the demo device is "restarting", reads fail the way they would
     against one that is: the console then shows its waiting screen for real. */
  if (performance.now() < awayUntil && path.startsWith("/api/")) {
    throw new TypeError("Failed to fetch");
  }
  if (method === "GET") {
    if (path.endsWith("/manifest.json")) return json(fakeManifest());
    if (path.endsWith(".bin")) return fakeImage();
    switch (path) {
      case "/api/capabilities":
        return json(capabilities);
      case "/api/v1/pins":
        return json(pins);
      case "/api/v1/settings":
        syncMedia();
        return json(search.includes("profile=default") ? settings : effectiveSettings());
      case "/api/v1/regions":
        return json(regionsJson());
      case "/api/v1/profiles":
        return json(profilesJson());
      case "/api/v1/settings/schema":
        return json(schema);
      case "/api/v1/system/info":
        return json(liveInfo());
      case "/api/v1/video/status":
        return json({ ...liveStatus(), profile: profileActive });
      case "/api/v1/storage/images":
        syncMedia();
        return json(images);
      case "/api/v1/storage/fetch":
        return json(fetchStatus());
      case "/api/v1/system/usbprobe":
        return json(usbprobe);
      case "/api/v1/auth/session":
        return json(authSession);
      case "/api/v1/captures":
        return json(demoCaptures());
      case "/api/v1/captures/search":
        return json(demoCaptureSearch(new URLSearchParams(search).get("q") ?? ""));
      case "/api/v1/record/status":
        return json(demoRecordStatus());
      case "/api/v1/system/install":
        return json(install);
      /* No crash has been kept - crashDumpBytes is 0 - so there is none to give. */
      case "/api/v1/system/coredump":
        return json({ error: "no crash dump" }, 404);
      case "/api/v1/tls":
        return json({ https: true, custom: tlsCustom, acme: demoAcme() });
      case "/api/v1/runbooks/status":
        return json(runbookStatus());
      case "/api/v1/cec":
        return json(cecStatus());
      /* espkvm-agent on the made-up machine: a desktop agent, clipboard read
         allowed, power not. */
      case "/api/v1/agent":
        return json({ mode: "agent", port: true, connected: true, version: "0.1.0", os: "linux",
          ops: ["ping", "info", "clipboard.get", "clipboard.set", "power"] });
      case "/api/v1/agent/info":
        return json({
          hostname: "build-box", os: "linux", osName: "Ubuntu 24.04.4 LTS", arch: "amd64",
          uptimeS: Math.round(performance.now() / 1000) + 266420, user: "anna",
          ifaces: [{ name: "eth0", mac: "f8:fe:5e:c3:71:ca", ips: ["192.168.1.20", "fd00::20"] }],
        });
      case "/api/v1/agent/clipboard":
        return json({ text: demoClipboard });
      /* netconsole from the made-up Raspberry Pi: its boot, then a line now and
         again, one of them a kernel warning. */
      case "/api/v1/netlog/log": {
        const since = Number(new URLSearchParams(search).get("since") ?? "0");
        const now = Date.now();
        let body = "";
        if (since === 0) {
          body = DEMO_NETLOG;
          demoNetNext = now + 5000;
        } else if (now >= demoNetNext) {
          demoNetNext = now + 6000 + Math.random() * 6000;
          const t = (performance.now() / 1000 + 60).toFixed(6).padStart(12, " ");
          body = Math.random() < 0.3
            ? `[${t}] WARNING: CPU: 2 PID: 731 at drivers/usb/core/hub.c:5466 hub_event+0x1f4/0x1a10\n`
            : `[${t}] usb 1-1.3: new high-speed USB device number ${3 + Math.floor(Math.random() * 9)} using xhci_hcd\n`;
        }
        return new Response(body, {
          headers: { "Content-Type": "text/plain", "X-Log-Pos": String(since + body.length) },
        });
      }
      case "/api/v1/netlog":
        return json({ enabled: true, running: true, port: 6666, rxBytes: 2048, packets: 31, refused: 0, lastFrom: "192.168.1.57" });
      case "/api/v1/serial":
        return json({ enabled: true, running: true, tx: 5, rx: 4, baud: 115200, rxBytes: 4096, txBytes: 64 });
      case "/api/v1/serial/log":
        return new Response("Debian GNU/Linux 12 raspberrypi ttyS0\n\nraspberrypi login: \n", {
          headers: { "Content-Type": "text/plain" },
        });
      /* The live log: the fixture once, then a line now and again, as a
         running device would. */
      case "/api/v1/system/log": {
        const since = Number(new URLSearchParams(search).get("since") ?? "0");
        const now = Date.now();
        let body = "";
        if (since === 0) {
          body = systemLogText;
          demoLogNext = now + 3000;
        } else if (now >= demoLogNext) {
          demoLogNext = now + 4000 + Math.random() * 4000;
          /* After the fixture's last line, which is a minute in. */
          const ms = 60000 + Math.floor(performance.now());
          body = Math.random() < 0.25
            ? `W (${ms}) web: websocket refused: no session\n`
            : `I (${ms}) video: published 25.0 fps, 9.4 Mbit/s, 1 viewer\n`;
        }
        return new Response(body, {
          headers: { "Content-Type": "text/plain", "X-Log-Pos": String(since + body.length) },
        });
      }
      case "/api/v1/notify/status":
        return json({
          enabled: settings.notify_enable === true || settings.notify_enable === 1,
          lastResult: "ok",
          lastAt: "2026-09-13 10:00:00",
          telegram: tgFind,
        });
      case "/api/v1/schedules/status": {
        const on = settings.sched_enable === true || settings.sched_enable === 1;
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        return json({
          enabled: on,
          clockValid: on,
          now: on
            ? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
            : "",
          tz: String(settings.sched_tz ?? "UTC0"),
          count: (() => { try { return JSON.parse(String(settings.schedules_json ?? "[]")).length; } catch { return 0; } })(),
          lastName: "",
          lastAction: "",
          lastAt: "",
        });
      }
      case "/api/v1/screen/text": {
        /* A booting machine is text, and text is what Select and Copy need. Once
           it reaches the pointer demo it is a picture, and 204 is the honest
           answer - the same one the device gives. */
        const grid = demoScreenText();
        return grid ? json(grid) : new Response(null, { status: 204 });
      }
    }
    return null;
  }

  if (method === "POST" && path.startsWith("/api/v1/regions")) {
    return demoRegionsPost(path, (await bodyJson(init, req)) as Json);
  }
  if (method === "POST" && path.startsWith("/api/v1/profiles")) {
    return demoProfiles(path, (await bodyJson(init, req)) as Json);
  }
  if (method === "PUT" && path === "/api/v1/settings") {
    const patch = { ...((await bodyJson(init, req)) as Json) };
    /* Under a profile of one's own its keys go to it, as on the device. */
    const own = activeDemoProfile();
    if (own && own.id !== 0) {
      const now = effectiveSettings();
      for (const k of Object.keys(patch)) {
        if (!PROFILE_KEYS.has(k)) continue;
        if (patch[k] !== now[k]) own.set = { ...(own.set ?? {}), [k]: patch[k] };
        delete patch[k];
      }
    }
    settings = { ...settings, ...patch };
    /* Mirror the device: the two VPN backends are mutually exclusive, so enabling
       one turns the other off (the VPN selector relies on this). */
    const p = patch as Json;
    if (p.wg_enable === true) settings = { ...settings, ts_enable: false };
    else if (p.ts_enable === true) settings = { ...settings, wg_enable: false };
    /* Picking an image in Media is what mounts it - the same setting the device
       uses - and that decides whether the next boot finds anything. */
    /* The target only sees a drive when virtual media is switched on - the same
       gate the firmware applies. */
    demoMountMedia(String(settings.msc_image ?? ""), Boolean(settings.msc_enable));
    /* The media panel reads the active medium from the card listing, not from
       the setting, so the two have to stay in step - otherwise the choice looks
       like it fell back to "ejected" the next time the list is fetched. */
    images = { ...images, active: String(settings.msc_image ?? "") };
    return json(effectiveSettings());
  }
  if (method === "POST" && path === "/api/v1/storage/fetch") {
    const body = (await bodyJson(init, req)) as { url?: string; dest?: string; name?: string };
    const url = body.url ?? "";
    if (!/^https?:\/\//.test(url)) return json({ error: "the URL must start with http:// or https://" }, 409);
    if (demoFetch?.state === "running") return json({ error: "a download is already running" }, 409);
    const rescue = body.dest === "rescue";
    demoFetch = {
      state: "running",
      dest: rescue ? "rescue" : "card",
      url,
      name: rescue ? "rescue" : body.name || "image.iso",
      total: rescue ? 2430976 : 64 * 1024 * 1024,
      startedAt: Date.now(),
      message: "",
    };
    return json(fetchStatus());
  }
  if (method === "POST" && path === "/api/v1/storage/fetch/cancel") {
    if (demoFetch?.state === "running") demoFetch = { ...demoFetch, state: "cancelled", message: "cancelled" };
    return json(fetchStatus());
  }
  if (method === "POST" && path === "/api/v1/storage/delete") {
    const name = new URLSearchParams(search).get("name") ?? "";
    images = {
      ...images,
      images: (images.images as Array<{ name: string }>).filter((i) => i.name !== name),
      active: images.active === name ? "" : images.active,
    };
    if (settings.msc_image === name) {
      settings = { ...settings, msc_image: "" };
      demoMountMedia("", Boolean(settings.msc_enable));
    }
    return json(images);
  }
  if (method === "PUT" && path === "/api/v1/tls/cert") {
    tlsCustom = true;
    return json({ status: "stored", restarting: true });
  }
  if (method === "DELETE" && (path === "/api/v1/auth/token" || path === "/api/v1/system/coredump")) {
    return json({ status: "ok" });
  }
  if (method === "DELETE" && path === "/api/v1/tls/cert") {
    tlsCustom = false;
    return json({ status: "cleared", restarting: true });
  }
  if (method === "POST") {
    switch (path) {
      case "/api/v1/tls/acme":
        acmeIssued = Math.floor(Date.now() / 1000);
        return json({ status: "started" });
      case "/api/v1/settings/reset":
        settings = { ...(settingsFixture as Json) };
        return json(settings);
      case "/api/v1/runbooks/run": {
        const { name } = (await bodyJson(init, req)) as { name?: string };
        const code = runbookStart(String(name ?? ""));
        if (code === 404) return json({ error: "no runbook of that name" }, 404);
        if (code === 409) return json({ error: "a runbook is already running" }, 409);
        return json({ status: "started" }, 202);
      }
      case "/api/v1/runbooks/stop":
        if (!runbookStop()) return json({ error: "no runbook is running" }, 409);
        return json({ ok: true });
      case "/api/v1/notify/test":
        return json({ status: "queued" }, 202);
      case "/api/v1/notify/chats":
        tgFind = { state: "ok", error: "", bot: "espkvm_demo_bot", chats: [
          { id: "184467305", type: "private", name: "Alex" },
          { id: "-1001987654321", type: "supergroup", name: "Homelab alerts" },
        ] };
        return json({ status: "queued" }, 202);
      case "/api/v1/schedules/run": {
        const { name } = (await bodyJson(init, req)) as { name?: string };
        let found = false;
        try { found = JSON.parse(String(settings.schedules_json ?? "[]")).some((s: { name: string }) => s.name === name); } catch { found = false; }
        if (!found) return json({ error: "no schedule of that name" }, 404);
        return json({ status: "fired" }, 202);
      }
      case "/api/v1/auth/login":
        return json({ mustChange: false });
      case "/api/v1/auth/logout":
        return json({ status: "logged out" });
      case "/api/v1/auth/password":
        return json({ status: "changed" });
      /* Two-factor in the demo: no real secret and no QR, just the steps. */
      case "/api/v1/auth/2fa/begin":
        return json({ secret: "DEMODEMODEMODEMODEMODEMODEMODEMO", uri: "", qrSize: 0, qr: "" });
      case "/api/v1/auth/2fa/enable":
      case "/api/v1/auth/2fa/recovery":
        return json({
          status: "on",
          recovery: ["DEMO-AAAA", "DEMO-BBBB", "DEMO-CCCC", "DEMO-DDDD",
            "DEMO-EEEE", "DEMO-FFFF", "DEMO-GGGG", "DEMO-HHHH"],
        });
      case "/api/v1/auth/2fa/disable":
        return json({ status: "off" });
      case "/api/v1/system/restart":
        return json({ status: "restarting" });
      case "/api/v1/system/install": {
        const { version, trial } = (await bodyJson(init, req)) as { version?: string; trial?: number };
        const err = installStart(String(version ?? ""), Number(trial ?? 0));
        return err ? json({ error: err }, 409) : json({ status: "started" }, 202);
      }
      case "/api/v1/system/update/keep":
        if (!trialLeft()) return json({ error: "no update is on trial" }, 409);
        sessionStorage.setItem(TRIAL_KEY, "0");
        return json({ status: "kept" });
      case "/api/v1/system/update/rollback":
        if (!trialLeft()) return json({ error: "no update is on trial" }, 409);
        bootInto(otherVersion(), installedVersion());
        return json({ status: "restarting" });
      case "/api/v1/system/boot-slot": {
        const { label } = (await bodyJson(init, req)) as { label?: string };
        if (label !== "ota_1") return json({ error: "already running from that slot" }, 409);
        bootInto(otherVersion(), installedVersion());
        return json({ status: "restarting" });
      }
      case "/api/v1/record/start": {
        const every = Number(new URLSearchParams(search).get("every") ?? 0);
        const r = demoRecordStart(every);
        return typeof r === "string" ? json({ error: r }, 409) : json(r);
      }
      case "/api/v1/record/stop":
        return json(demoRecordStop());
      case "/api/v1/record/event": {
        const r = demoRecordEvent();
        return typeof r === "string" ? json({ error: r }, 409) : json(r);
      }
      case "/api/v1/screenshot": {
        const r = await demoScreenshot();
        return typeof r === "string" ? json({ error: r }, 409) : json(r);
      }
      case "/api/v1/captures/delete":
        return json(demoCaptureDelete(new URLSearchParams(search).get("path") ?? ""));
      /* A viewing token: shown once, as on the device. */
      case "/api/v1/auth/token":
        return json({
          token: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join(""),
        });
      case "/api/v1/cec/key": {
        if (!demoCecBox().present) {
          return json({ error: "no CEC device on the line to send to" }, 404);
        }
        const { key } = (await bodyJson(init, req)) as { key?: string };
        cecLog("tx", `04 44 ${cecCode(String(key ?? ""))}`);
        cecLog("tx", "04 45");
        demoCecKey(String(key ?? ""));
        return json({ ok: true });
      }
      case "/api/v1/cec/power": {
        if (!demoCecBox().present) {
          return json({ error: "no CEC device on the line to send to" }, 404);
        }
        const { action } = (await bodyJson(init, req)) as { action?: string };
        if (action === "standby") {
          cecLog("tx", "04 36");
          cecLog("rx", "40 9d 10 00");
          demoCecPower("standby");
        } else {
          cecLog("tx", "0f 86 10 00");
          cecLog("tx", "04 44 6d");
          cecLog("rx", "4f 82 10 00");
          demoCecPower("wake");
        }
        return json({ ok: true });
      }
      case "/api/v1/cec/scan":
        return json({ ok: true });
      case "/api/v1/agent/clipboard": {
        const { text } = (await bodyJson(init, req)) as { text?: string };
        demoClipboard = String(text ?? "");
        return json({});
      }
      case "/api/v1/agent/power":
        return json({ error: "switched off on this machine", code: "not_allowed" }, 403);
      case "/api/v1/cec/send":
        return json({ tx: "ok" });
      case "/api/v1/power/wake":
        demoPower("wake");
        return json({ status: "sent" });
      case "/api/v1/power/click":
        demoPower("click");
        return json({ status: "ok" });
      case "/api/v1/power/hold":
        demoPower("hold");
        return json({ status: "ok" });
      case "/api/v1/power/reset":
        demoPower("reset");
        return json({ status: "ok" });
      /* Nothing to show: the demo target is always attached, so a re-plug is a
         no-op here. It answers so the button behaves like the real one. */
      case "/api/v1/hid/reattach":
        return json({ status: "ok" });
      /* Writing the rescue partition is the one action still worth refusing:
         nothing about it can be shown, and it takes a minute on a real device. */
      case "/api/v1/storage/rescue":
        return json({ error: "not available in the demo" }, 501);
    }
  }
  return null;
}

/*
 * The console sends an image with XMLHttpRequest, not fetch, because only XHR
 * reports upload progress - so a demo that patches only fetch would send a
 * firmware image at a static web host. This takes the two uploads it makes.
 */
type XhrHandler = ((e: ProgressEvent) => void) | null;

class DemoXhr {
  status = 0;
  responseText = "";
  readyState = 0;
  onload: XhrHandler = null;
  onerror: XhrHandler = null;
  upload: { onprogress: XhrHandler; onload: XhrHandler } = { onprogress: null, onload: null };
  private path = "";

  open(_method: string, url: string): void {
    this.path = new URL(url, location.origin).pathname + new URL(url, location.origin).search;
  }
  setRequestHeader(): void {}
  getResponseHeader(): string | null {
    return null;
  }
  abort(): void {}
  addEventListener(): void {}

  async send(body: Blob | ArrayBuffer | string | null): Promise<void> {
    const total = body instanceof Blob ? body.size : 1_000_000;
    /* Twenty steps over a couple of seconds: enough for the ring to fill and the
       percentage to read like bytes moving. */
    for (let i = 1; i <= 20; i++) {
      await new Promise((r) => setTimeout(r, 110));
      this.upload.onprogress?.(
        new ProgressEvent("progress", { lengthComputable: true, loaded: (total / 20) * i, total }),
      );
    }
    this.upload.onload?.(new ProgressEvent("load"));
    await new Promise((r) => setTimeout(r, 700));

    if (this.path.startsWith("/api/v1/system/update")) {
      /* Written, restarting - and the device really does go away, so the
         console's waiting screen and its verdict afterwards are the real ones. */
      const trial = Number(new URLSearchParams(this.path.split("?")[1] ?? "").get("trial") ?? 0);
      bootInto(NEXT_VERSION, installedVersion(), trial);
      this.status = 200;
      this.responseText = JSON.stringify({ status: "written", restarting: true });
    } else if (this.path.startsWith("/api/v1/storage/upload")) {
      const q = new URLSearchParams(this.path.split("?")[1] ?? "");
      const name = q.get("name") ?? "image.iso";
      const size = Number(q.get("offset") ?? 0) + total;
      images = {
        ...images,
        images: [...(images.images as Json[]).filter((i) => i.name !== name), { name, size }],
      };
      this.status = 200;
      this.responseText = JSON.stringify(images);
    } else {
      this.status = 501;
      this.responseText = JSON.stringify({ error: "not available in the demo" });
    }
    this.readyState = 4;
    this.onload?.(new ProgressEvent("load"));
  }
}

/** A WebSocket that never connects: input is accepted and dropped. */
class DemoSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onclose: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  /* On /serial: the made-up Raspberry Pi at the other end of the wire. */
  #serial: DemoSerial | null = null;

  constructor(readonly url: string) {
    super();
    if (url.includes("/serial")) {
      this.#serial = new DemoSerial((text) => {
        if (this.readyState !== 1) return;
        const m = new MessageEvent("message", { data: new TextEncoder().encode(text).buffer });
        this.onmessage?.(m);
        this.dispatchEvent(m);
      });
    }
    setTimeout(() => {
      this.readyState = 1;
      const e = new Event("open");
      this.onopen?.(e);
      this.dispatchEvent(e);
      /* On the control channel, report a target attached (status frame 0x81,
         flags bit0 = attached, bit1 = the bus is alive) so the demo shows a
         live USB connection. */
      if (this.url.includes("/ws")) {
        const status = new Uint8Array([0x81, 0x03, 0x00]);
        const m = new MessageEvent("message", { data: status.buffer });
        this.onmessage?.(m);
        this.dispatchEvent(m);
      }
    }, 0);
  }
  send(data: unknown): void {
    /* A keyboard report is typed at the fake machine, so the demo's shell
       answers the visitor; a relative mouse report moves its pointer. Frame 0x03 is a
       modifier byte and six usage codes - see input/control.ts. */
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return;
    const b = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(
      (data as ArrayBufferView).buffer,
      (data as ArrayBufferView).byteOffset,
      (data as ArrayBufferView).byteLength,
    );
    if (this.#serial) {
      /* 0x01 subscribe, 0x02 + bytes typed - see components/SerialPanel.vue. */
      if (b[0] === 0x01) this.#serial.start();
      else if (b[0] === 0x02) this.#serial.input(new TextDecoder().decode(b.slice(1)));
      return;
    }
    if (b.length >= 6 && b[0] === 0x02) {
      /* A relative mouse report (the phone's touchpad, pointer lock): the demo
         machine's pointer moves by it - see onHid in ScreenView. */
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      (window as unknown as { __espkvmDemoHid?: (dx: number, dy: number, buttons: number) => void })
        .__espkvmDemoHid?.(dv.getInt16(2, true), dv.getInt16(4, true), b[1]);
    } else if (b.length >= 8 && b[0] === 0x03) {
      demoKeys(b[1], Array.from(b.subarray(2, 8)));
    } else if (b.length >= 1 && b[0] === 0x05) {
      /* Release all - sent when control is handed back. The machine tracks what
         is held to tell a press from a key that simply has not been let go, so
         it has to hear about this too. */
      demoKeys(0, []);
    }
  }
  close(): void {
    this.readyState = 3;
    const e = new CloseEvent("close");
    this.onclose?.(e);
    this.dispatchEvent(e);
  }
}

let installed = false;

export function installDemoBackend(): void {
  if (installed) return;
  installed = true;

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : undefined;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const u = new URL(url, location.origin);
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const res = await route(u.pathname, method, init, req, u.search);
    return res ?? realFetch(input as RequestInfo, init);
  };

  /* The screen goes on the window: ScreenView reads it from there, so no part of
     the real console imports this module. */
  const w = window as unknown as {
    __espkvmDemoScreen?: unknown;
    __espkvmDemoScene?: unknown;
    __espkvmDemoBox?: unknown;
    __espkvmDemoSceneMs?: unknown;
    __espkvmDemoCrash?: unknown;
    __espkvmDemoPower?: unknown;
    __espkvmDemoLauncher?: unknown;
    __espkvmDemoAsk?: unknown;
  };
  w.__espkvmDemoScreen = demoScreenText;
  w.__espkvmDemoScene = demoScene;
  w.__espkvmDemoBox = demoBox;
  w.__espkvmDemoSceneMs = demoSceneMs;
  /* The drawing knows where the sheep and the dock are, so it is the drawing that
     decides a click landed on one - it only has to say so. */
  w.__espkvmDemoCrash = demoCrash;
  w.__espkvmDemoPower = demoPower;
  w.__espkvmDemoLauncher = demoLauncher;
  /* Which control the visitor is being asked for. The console points at it - a
     newcomer cannot find "Media" or "Select" from a sentence alone. */
  w.__espkvmDemoAsk = demoAsk;
  /* Recordings, screenshots and the log live in the browser: captureUrl() and
     logUrl() ask here for a blob: URL before they build a device one. */
  (window as unknown as { __espkvmDemoFile?: unknown }).__espkvmDemoFile = demoFile;

  window.XMLHttpRequest = DemoXhr as unknown as typeof XMLHttpRequest;

  const RealWS = window.WebSocket;
  const patched = new Proxy(RealWS, {
    construct(target, args: [string | URL, (string | string[])?]) {
      const url = String(args[0]);
      if (url.includes("/ws") || url.includes("/video") || url.includes("/serial")) {
        return new DemoSocket(url) as unknown as WebSocket;
      }
      return new target(...args);
    },
  });
  window.WebSocket = patched as unknown as typeof WebSocket;
}

/* HDMI-CEC: the made-up TV box (vapor-box-os.iso) answers on the line while it
   runs, so the remote has something to drive. */
const cecBox = { la: 4, name: "Vapor Box", type: "playback", physAddr: "1.0.0.0", vendor: "000000", power: "on", version: "2.0", seenMs: 0 };
const cecFrames: { ms: number; dir: "tx" | "rx"; hex: string; result?: string }[] = [];
const CEC_CODES: Record<string, number> = {
  select: 0x00, up: 0x01, down: 0x02, left: 0x03, right: 0x04, home: 0x09, menu: 0x0a, back: 0x0d,
  info: 0x35, volume_up: 0x41, volume_down: 0x42, mute: 0x43, play: 0x44, stop: 0x45, pause: 0x46,
  rewind: 0x48, fast_forward: 0x49, blue: 0x71, red: 0x72, green: 0x73, yellow: 0x74,
};

function cecCode(key: string): string {
  const code = /^[0-9]$/.test(key) ? 0x20 + Number(key) : (CEC_CODES[key] ?? 0);
  return code.toString(16).padStart(2, "0");
}

function cecLog(dir: "tx" | "rx", hex: string) {
  cecFrames.push({ ms: Math.round(performance.now()), dir, hex, ...(dir === "tx" ? { result: "ok" } : {}) });
  if (cecFrames.length > 24) cecFrames.shift();
}

function cecStatus() {
  cecBox.seenMs = Math.round(performance.now());
  const box = demoCecBox();
  cecBox.power = box.power;
  return {
    available: true,
    running: true,
    ownAddr: 0,
    active: box.present ? 4 : -1,
    target: box.present ? 4 : -1,
    devices: box.present ? [cecBox] : [],
    log: cecFrames,
  };
}
