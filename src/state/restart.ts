/*
 * Restarts, and telling the operator how they went.
 *
 * Every restart takes the session with it, so the console reloads onto the
 * sign-in page and whatever it knew is gone. That is exactly where the answer
 * matters: an update that rolled back looks identical to one that worked, and
 * the only way to tell is the version that came back. So what we were doing is
 * written down before the reload and read back after it.
 */

import { reactive } from "vue";

import { waitForDevice } from "./device";

const NOTE_KEY = "espkvm.restart";

export type RestartKind = "update" | "slot" | "manual" | "network" | "coproc";

export interface RestartNote {
  kind: RestartKind;
  /** Version that was running before it went down. */
  from?: string;
  /** Version we handed it, when we know which one to expect back. */
  to?: string;
  /**
   * The update went on trial. "auto": this console keeps it once it is back,
   * which is the proof. "ask": the operator checks it first.
   */
  trial?: "auto" | "ask";
}

/*
 * How long the waits normally take, measured on real devices: the firmware
 * reaches "ready" about 14 seconds after a restart and has its address a few
 * seconds after that. These are expectations, not promises - the console still
 * believes the device over the clock, and only uses these to say whether what
 * is happening is what usually happens.
 *
 * Both were too short and cried "longer than usual" on ordinary updates (#22):
 * writing and verifying an image takes past forty seconds on a real board, not
 * twelve, and coming back takes a few seconds more than twenty. An expectation
 * that is beaten every time teaches people to ignore the one warning that
 * matters, so these are set past what a healthy device takes.
 */
export const EXPECTED_RESTART_MS = 28_000;
export const EXPECTED_WRITE_MS = 55_000;

export function rememberRestart(note: RestartNote) {
  try {
    sessionStorage.setItem(NOTE_KEY, JSON.stringify(note));
  } catch {
    /* Private windows and blocked site data: the restart still works, it just
       cannot be reported afterwards. */
  }
}

function readNote(): RestartNote | null {
  try {
    const raw = sessionStorage.getItem(NOTE_KEY);
    return raw ? (JSON.parse(raw) as RestartNote) : null;
  } catch {
    return null;
  }
}

export function forgetRestart() {
  try {
    sessionStorage.removeItem(NOTE_KEY);
  } catch {
    /* nothing to clean up */
  }
}

/** The pending note, left in place - the sign-in page reads it before anyone
    has signed in, and the verdict needs it again afterwards. */
export const peekRestart = readNote;

/** The note, cleared: called once the outcome has been reported. */
export function takeRestart(): RestartNote | null {
  const note = readNote();
  forgetRestart();
  return note;
}

/**
 * The device going away, as the whole console sees it.
 *
 * One shared object rather than a prop threaded through three panels. An
 * install or a restart is not something happening in a corner of the screen:
 * nothing else can be done until it ends, the console takes it over, and it is
 * started from the settings, from the network switch and from the firmware
 * widget alike.
 */
/** One line of the checklist under the animation. */
export interface WatchStep {
  key: string;
  label: string;
}

export const restartWatch = reactive({
  active: false,
  /** Headline - what is being done. */
  label: "",
  /** The step it is on, in one sentence. */
  detail: "",
  /** The whole run, so an operator can see what is left rather than only what
      is happening. Empty for a one-step job, where a list of one says nothing. */
  steps: [] as WatchStep[],
  /** Index into `steps`, -1 before the first. */
  stepIndex: -1,
  /** 0..100 while real bytes move; null when only the clock is known. */
  pct: null as number | null,
  elapsedMs: 0,
  expectedMs: EXPECTED_RESTART_MS,
  /** Past the expected time and still not answering. */
  slow: false,
  /** Given up on. */
  lost: false,
  /** A network switch: the device may come back on another address, which
      this page cannot follow. Shown with a way to get there. */
  moving: false,
  /** Where the device can be found by name, when this page is on an address. */
  byName: "",
});

/* The clock every step runs on. The step with no percentage - the device writing
   the image on its own - has only this, and nothing was ticking it (#23). */
let clock: ReturnType<typeof setInterval> | undefined;
let stepStarted = 0;

function startClock() {
  stepStarted = Date.now();
  restartWatch.elapsedMs = 0;
  restartWatch.slow = false;
  if (clock) return;
  clock = setInterval(() => {
    const ms = Date.now() - stepStarted;
    restartWatch.elapsedMs = ms;
    restartWatch.slow = ms > restartWatch.expectedMs;
  }, 200);
}

function stopClock() {
  if (clock) clearInterval(clock);
  clock = undefined;
}

/**
 * How far along the current step is, 0..1.
 *
 * A real percentage where there is one, and the clock against what the step
 * normally takes where there is not. Past that, it stops meaning anything and
 * the animation says so in its own way rather than sitting at full.
 */
export function watchFraction(): number {
  if (restartWatch.pct !== null) return Math.min(1, Math.max(0, restartWatch.pct / 100));
  if (restartWatch.slow) return 1;
  return Math.min(1, restartWatch.elapsedMs / Math.max(1, restartWatch.expectedMs));
}

/** Take over the console for something that ends with the device restarting. */
export function beginWatch(label: string, steps: WatchStep[] = []) {
  restartWatch.label = label;
  restartWatch.detail = "";
  restartWatch.steps = steps;
  restartWatch.stepIndex = -1;
  restartWatch.pct = null;
  restartWatch.expectedMs = EXPECTED_RESTART_MS;
  restartWatch.lost = false;
  restartWatch.moving = false;
  restartWatch.byName = "";
  restartWatch.active = true;
  startClock();
}

/** Move to a step. Pass a percentage where there is one, an expected duration
    where there is not. */
export function watchStep(
  key: string,
  detail: string,
  opts: { pct?: number | null; expectedMs?: number } = {},
) {
  const i = restartWatch.steps.findIndex((s) => s.key === key);
  if (i >= 0) restartWatch.stepIndex = i;
  restartWatch.detail = detail;
  restartWatch.pct = opts.pct ?? null;
  if (opts.expectedMs !== undefined) {
    restartWatch.expectedMs = opts.expectedMs;
    startClock(); /* a new step, so the clock starts again */
  }
}

export function watchPct(pct: number) {
  restartWatch.pct = pct;
}

export function endWatch() {
  stopClock();
  restartWatch.active = false;
  restartWatch.lost = false;
}

export function watchLost() {
  stopClock(); /* leave the clock where it gave up */
  restartWatch.lost = true;
}

export function dismissRestart() {
  endWatch();
}

/**
 * Wait for the device, feeding the shared watch as it goes.
 *
 * @returns true if it came back.
 */
export async function watchBack(): Promise<boolean> {
  watchStep("restart", "Waiting for the device to come back...", {
    expectedMs: EXPECTED_RESTART_MS,
  });
  const back = await waitForDevice(90_000, 4000);
  if (!back) watchLost();
  return back;
}

/**
 * Ask the device to restart, then watch it back.
 *
 * @param label what to call it while it happens ("Restarting", "Switching to Wi-Fi")
 * @param kick  the call that sends the device away
 * @param note  what to tell the operator once the console is back
 */
export async function runRestart(
  label: string,
  kick: () => Promise<void>,
  note: RestartNote,
  opts: { byName?: string } = {},
): Promise<boolean> {
  /* No checklist: a list of one step says nothing the headline has not. */
  beginWatch(label);
  if (note.kind === "network") {
    restartWatch.moving = true;
    restartWatch.byName = opts.byName ?? "";
  }
  try {
    await kick();
  } catch (err) {
    endWatch();
    throw err;
  }

  rememberRestart(note);
  if (!(await watchBack())) {
    /* Nothing came back, so there is no verdict to report on the other side of
       a reload that is not going to happen. */
    forgetRestart();
    return false;
  }
  /* A beat on "it is back" before the reload. Without it the panel vanishes and
     the sign-in page appears out of nowhere, which reads as something going
     wrong rather than as the thing having worked. */
  watchStep("restart", "The device is back. Reloading the console...");
  await new Promise((r) => setTimeout(r, 1200));
  return true;
}
