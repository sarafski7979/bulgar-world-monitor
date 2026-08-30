/**
 * Bulgar deployment branding.
 *
 * This fork is Bulgar's deployment of the upstream open-source World Monitor
 * project (https://github.com/koala73/worldmonitor). These constants are the
 * single source of truth for the Bulgar lockup so the header, the document
 * title, and the boot skeleton cannot drift apart.
 *
 * Upstream product naming, the author credit, and the upstream repository link
 * are deliberately kept in the header alongside these — Bulgar did not create
 * World Monitor, and AGPL-3.0 attribution stays intact.
 *
 * Strings are authored in mixed case; every surface that renders them applies
 * `text-transform: uppercase` in CSS rather than shouting in the DOM, so screen
 * readers pronounce "Bulgar" as a word instead of spelling it out.
 */

/** Primary mark. Rendered as "BULGAR — WORLD MONITOR". */
export const BULGAR_BRAND_PRIMARY = 'Bulgar — World Monitor';

/** Secondary label. Rendered as "FREE WORLD MAP MONITORING". */
export const BULGAR_BRAND_SECONDARY = 'Free world map monitoring';

/** Short prefix used where the full lockup would duplicate the product name. */
export const BULGAR_BRAND_SHORT = 'BULGAR';

/**
 * Prefixes a localized document title with the Bulgar mark.
 *
 * The localized titles in `src/locales/*.json` already name the upstream
 * product — in several locales it is transliterated ("ワールドモニター",
 * "Világfigyelő") or trails the description rather than leading it. Prefixing
 * is therefore the only transformation that brands every locale without
 * mangling a translation, so this deliberately does not try to substitute the
 * product name out of the localized string.
 */
export function withBulgarBrand(localizedTitle: string): string {
  const title = localizedTitle.trim();
  if (!title) return BULGAR_BRAND_PRIMARY;
  if (title.startsWith(BULGAR_BRAND_SHORT)) return title;
  return `${BULGAR_BRAND_SHORT} · ${title}`;
}
