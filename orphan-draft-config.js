/* =============================================================================
 * ORPHAN DRAFT CONFIG
 * Prototype settings for the Franchise Legends orphan auction.
 * Live mode stays off until the Firebase fields below are filled in.
 * Do not put production secrets here — this file ships with the static site.
 * The admin PIN is a client-side gate, not real authentication.
 * See README → SETUP.
 * ============================================================================= */
window.ORPHAN_DRAFT_CONFIG = {
  // Prototype admin gate. Change it before sharing a live draft.
  adminPin: "draft-admin",

  // How far a server close-stamp may lead endsAt and still count (clock skew).
  closeToleranceMs: 500,

  // Realtime Database path. Must stay covered by orphan-draft.rules.json.
  draftPath: "orphanDrafts",

  // Leave databaseURL empty to use local demo mode only.
  // Firebase console → Project settings → Your apps → SDK setup.
  firebase: {
    apiKey: "",
    authDomain: "",
    databaseURL: "",
    projectId: "",
  },
};
