/**
 * config.js — Build-wide constants.
 *
 * APP_VERSION is the single place the version is written. The service worker
 * keeps its own copy of the cache name because it runs outside the module
 * graph and cannot import this file — bump both together when releasing.
 */

export const APP_NAME = 'Project IronLog';
export const APP_VERSION = '1.6.0';

/** Session of the staged build plan that this code delivers. */
export const BUILD_SESSION = 5;
