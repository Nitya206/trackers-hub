/**
 * sync-config.js · TRACKERS HUB — Sync configuration
 * ---------------------------------------------------------------------------
 * Fill in the two values below once. See SYNC-SETUP.md for where to find them.
 *
 * Both values are safe to publish. The `anon` key is designed to be public —
 * it grants no access on its own. Your data is protected by Row Level
 * Security plus your pairing code, which is NOT stored in this file.
 */
window.TRACKERS_SYNC_CONFIG = {

  /* ── 1. From Supabase → Project Settings → Data API ────────────────── */
  supabaseUrl:     'https://srxipxwhctlvorbpyhlt.supabase.co',   // e.g. 'https://abcdefghijklm.supabase.co'
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNyeGlweHdoY3Rsdm9yYnB5aGx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4MjE4MDYsImV4cCI6MjEwNDM5NzgwNn0.kUJbglFCyDLk69rRaWJRXanOrkH52zBmB6BW6CAwXsQ',   // the long "anon / public" key

  /* ── 2. Optional ───────────────────────────────────────────────────── */

  // Leave empty. Each device is paired by pasting its code into the prompt,
  // which stores it in that device's browser only.
  //
  // Only set this if you want a site where ANY visitor is instantly signed in
  // to your data with no prompt — convenient, but it puts your password in a
  // public file, so use it only for a private/unlisted deployment.
  pairingCode: '',

  /* ── Push notifications ────────────────────────────────────────────── */
  // Safe to publish — this is the PUBLIC half of the VAPID pair. It only lets
  // your devices subscribe; sending requires the private key, which lives in
  // Supabase as a secret and is never in this file.
  vapidPublicKey: 'BKn63XVAOzT1E6PNdOFw1KLD_mGMxBKwEd_OqHCDacNFA6BaQVaeow3fyEI8KEajasTAKQS-eDdNB7SJpDQHivk',

  // Show the little sync status chip in the corner.
  hideIndicator: false,

  // Log sync activity to the browser console. Useful while setting up.
  debug: false,

  // How long to wait after a change before uploading (ms). Batches rapid
  // edits into one request.
  debounceMs: 600,

  // Extra keys to keep on this device only, on top of the built-in list in
  // sync-engine.js (theme, font size, panel layout, etc.).
  localOnlyKeys: [],
  localOnlyPrefixes: []
};
