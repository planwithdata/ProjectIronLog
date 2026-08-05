/**
 * events.js — Tiny synchronous publish/subscribe bus.
 *
 * Services emit; pages listen. This is what lets the Home page update its
 * body-weight tile when Settings restores a backup, without Home and Settings
 * importing each other. Keeps the dependency graph a tree, not a web.
 */

/** Canonical event names. Referencing this object beats typing raw strings. */
export const EVENTS = {
  DATA_CHANGED:      'data:changed',       // any persisted write ({ collection })
  DATA_RESTORED:     'data:restored',      // a backup was imported
  DATA_RESET:        'data:reset',         // app data wiped
  SETTINGS_CHANGED:  'settings:changed',   // ({ key, value })
  ROUTE_CHANGED:     'route:changed',      // ({ name, params })
  WORKOUT_STARTED:   'workout:started',
  WORKOUT_COMPLETED: 'workout:completed',
  TOAST:             'ui:toast',           // ({ message, tone })
};

const listeners = new Map();

/**
 * Subscribe to an event.
 * @returns {() => void} unsubscribe function
 */
export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => off(event, handler);
}

/** Subscribe for a single delivery. */
export function once(event, handler) {
  const unsubscribe = on(event, (payload) => {
    unsubscribe();
    handler(payload);
  });
  return unsubscribe;
}

export function off(event, handler) {
  listeners.get(event)?.delete(handler);
}

/**
 * Publish an event. A throwing listener is logged and skipped so that one
 * broken subscriber can never stop the others from running.
 */
export function emit(event, payload) {
  const handlers = listeners.get(event);
  if (!handlers) return;
  for (const handler of [...handlers]) {
    try {
      handler(payload);
    } catch (error) {
      console.error(`[events] listener for "${event}" threw:`, error);
    }
  }
}

/** Remove every listener. Used by tests and by the reset flow. */
export function clearAll() {
  listeners.clear();
}

/** Convenience wrapper so any module can raise a toast without importing UI. */
export function toast(message, tone = 'default') {
  emit(EVENTS.TOAST, { message, tone });
}
