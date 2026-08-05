/**
 * rest-timer.js — The between-sets rest timer.
 *
 * Why this is timestamp-based, not tick-based
 * ------------------------------------------
 * The obvious implementation counts down a variable in `setInterval`. It is
 * also wrong on a phone: iOS throttles timers in a backgrounded tab and
 * suspends them entirely when the screen locks. A lifter who pockets their
 * phone for 90 seconds would come back to a timer that had barely moved.
 *
 * So the only state that matters is `endsAt`, an absolute epoch time. The
 * interval exists purely to repaint; remaining time is always recomputed from
 * the clock. Lock the screen for two minutes and the timer is correct the
 * instant you look at it.
 *
 * The running timer is intentionally not persisted. If Safari discards the
 * tab the logged sets survive (they are in storage) but the countdown does
 * not — and a stale timer restored from ten minutes ago would be worse than
 * no timer at all.
 */

import { EVENTS, emit, on } from '../core/events.js';
import * as settingsService from './settings-service.js';

/** Emitted every repaint tick while running, and once on stop. */
export const REST_TICK = 'rest:tick';
export const REST_DONE = 'rest:done';

const REPAINT_MS = 200;

let endsAt = null;         // epoch ms
let totalSeconds = 0;      // the interval originally asked for
let label = '';            // which exercise this rest belongs to
let intervalId = null;
let audioContext = null;

/* --- Control ------------------------------------------------------------ */

/**
 * Start (or restart) the timer.
 * @param {number} seconds
 * @param {string} [forLabel]  exercise name, shown in the timer bar
 */
export function start(seconds, forLabel = '') {
  const duration = Math.max(1, Math.round(Number(seconds) || 0));
  totalSeconds = duration;
  label = forLabel;
  endsAt = Date.now() + duration * 1000;

  if (intervalId === null) {
    intervalId = setInterval(tick, REPAINT_MS);
  }
  tick();
}

export function stop() {
  endsAt = null;
  totalSeconds = 0;
  label = '';
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  emit(REST_TICK, snapshot());
}

/** Add time without restarting — the "+30s" button. */
export function extend(seconds = 30) {
  if (endsAt === null) return;
  endsAt += Math.round(seconds) * 1000;
  totalSeconds += Math.round(seconds);
  tick();
}

export function isRunning() {
  return endsAt !== null;
}

/** Current state, for a component rendering itself for the first time. */
export function snapshot() {
  if (endsAt === null) {
    return { running: false, remaining: 0, total: 0, percent: 0, label: '' };
  }
  const remaining = Math.max(0, (endsAt - Date.now()) / 1000);
  const elapsed = totalSeconds - remaining;
  return {
    running: true,
    remaining,
    total: totalSeconds,
    percent: totalSeconds ? Math.min(100, Math.round((elapsed / totalSeconds) * 100)) : 0,
    label,
  };
}

function tick() {
  const state = snapshot();
  emit(REST_TICK, state);

  if (state.running && state.remaining <= 0) {
    // Capture the label before stop() clears it.
    const finishedFor = label;
    stop();
    alertDone();
    emit(REST_DONE, { label: finishedFor });
  }
}

/* --- Alert -------------------------------------------------------------- */

/**
 * Sound and haptic when rest is up.
 *
 * The beep is synthesised with WebAudio rather than loaded from a file: no
 * asset to cache, nothing to 404 offline, and no download on first launch.
 */
function alertDone() {
  const settings = settingsService.getSettings();
  if (settings.restTimerSound) beep();
  if (settings.haptics) vibrate();
}

function beep() {
  try {
    // Created lazily and reused. iOS will not allow an AudioContext to start
    // without a prior user gesture — by the time a rest timer has finished,
    // the user has tapped a checkmark, so the gesture requirement is met.
    if (!audioContext) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      audioContext = new Ctor();
    }
    if (audioContext.state === 'suspended') audioContext.resume();

    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, now);
    oscillator.frequency.setValueAtTime(1180, now + 0.14);

    // A short ramp instead of a hard stop; an abrupt cut clicks audibly.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);

    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.34);
  } catch (error) {
    console.warn('[rest-timer] could not play the alert:', error);
  }
}

function vibrate() {
  // Not supported by Safari on iOS. Harmless there, useful on Android.
  try {
    navigator.vibrate?.([90, 60, 90]);
  } catch { /* ignore */ }
}

/**
 * Repaint immediately when the tab comes back to the foreground, rather than
 * waiting up to one interval for the next tick.
 */
export function watchVisibility() {
  const handler = () => { if (!document.hidden && isRunning()) tick(); };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}

/** Stop the timer when a workout ends, so it cannot outlive its session. */
on(EVENTS.WORKOUT_COMPLETED, () => stop());
