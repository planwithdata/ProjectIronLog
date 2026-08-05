/**
 * settings-service.js — User preferences and profile.
 *
 * Theme is applied by writing `data-theme` on <html>; tokens.css does the
 * rest, so no component needs to know a theme exists.
 */

import * as db from './db.js';
import { COLLECTIONS } from './db.js';
import { EVENTS, emit } from '../core/events.js';

export const THEMES = ['dark', 'light', 'system'];
export const UNITS = ['kg', 'lb'];

export function getSettings() {
  return db.read(COLLECTIONS.SETTINGS);
}

export function get(key) {
  return getSettings()[key];
}

/** Update one setting, persist it, and notify listeners. */
export async function set(key, value) {
  await db.update(COLLECTIONS.SETTINGS, (settings) => ({ ...settings, [key]: value }));
  if (key === 'theme') applyTheme(value);
  emit(EVENTS.SETTINGS_CHANGED, { key, value });
}

export function getUnits() {
  return get('units') ?? 'kg';
}

export function getProfile() {
  return db.read(COLLECTIONS.PROFILE);
}

export async function updateProfile(patch) {
  return db.update(COLLECTIONS.PROFILE, (profile) => ({ ...profile, ...patch }));
}

/**
 * Record the first day of training, if it isn't already set. Called when a
 * workout is completed — see program-service.getTrainingWeek for why.
 */
export async function ensureProgramStart(dayKey) {
  const profile = getProfile();
  if (profile.programStartDate) return profile.programStartDate;
  await updateProfile({ programStartDate: dayKey });
  return dayKey;
}

/* --- Theme -------------------------------------------------------------- */

/**
 * Write the theme onto <html>. `system` is passed through as-is so the
 * `prefers-color-scheme` block in tokens.css can take over.
 */
export function applyTheme(theme = getSettings().theme) {
  const value = THEMES.includes(theme) ? theme : 'dark';
  document.documentElement.setAttribute('data-theme', value);
  updateThemeColorMeta();
}

/**
 * Keep <meta name="theme-color"> in step with the resolved theme, so the
 * iOS status bar and the Android chrome match the app surface.
 */
function updateThemeColorMeta() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const bg = getComputedStyle(document.documentElement)
    .getPropertyValue('--c-bg')
    .trim();
  if (bg) meta.setAttribute('content', bg);
}

/**
 * Re-apply on OS theme change so the `system` setting is genuinely live
 * rather than only correct at launch.
 */
export function watchSystemTheme() {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (getSettings().theme === 'system') applyTheme('system');
  };
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}
