import { getCorsHeaders, isDisallowedOrigin, getOriginDeniedCorsHeaders } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { readJsonFromUpstash, setCachedData } from './_upstash-json.js';

export const config = { runtime: 'edge' };

/**
 * Road-traffic incidents for a map viewport, via TomTom.
 *
 * WHY THIS IS VIEWPORT-SCOPED AND NOT GLOBAL
 * TomTom's incidentDetails API refuses any bbox larger than 10,000 km²
 * ("Area of 'bbox' parameter is larger than 10,000km2"), which is roughly a
 * 100x100 km box — one metro area. A world-view request is rejected outright,
 * so there is no global road-traffic feed to be had at any price tier. Every
 * consumer map works this way: traffic appears only once you zoom in. The
 * client is therefore expected to send the CURRENT VIEWPORT and to leave the
 * layer dormant at low zoom.
 *
 * GRACEFUL DEGRADATION
 * With no TOMTOM_API_KEY this answers 200 with `{ disabled: true }` rather
 * than an error, matching how every other optional source in this app behaves:
 * a missing key disables a feature, it does not break the page.
 *
 * The key is read server-side only and never reaches the browser.
 */

const MAX_BBOX_KM2 = 10_000;
const CACHE_TTL_SECONDS = 180;

/** Rough km² for a lon/lat bbox, good enough to pre-empt TomTom's own limit. */
function bboxAreaKm2(minLon, minLat, maxLon, maxLat) {
  const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
  const kmPerDegLat = 110.574;
  const kmPerDegLon = 111.320 * Math.cos(midLat);
  return Math.abs(maxLat - minLat) * kmPerDegLat * Math.abs(maxLon - minLon) * kmPerDegLon;
}

export default async function handler(req) {
  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Forbidden' }, 403, getOriginDeniedCorsHeaders(req));
  }
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const apiKey = process.env.TOMTOM_API_KEY;
  if (!apiKey) {
    // Optional source absent: the layer stays dormant, the map is unaffected.
    return jsonResponse({ disabled: true, reason: 'TOMTOM_API_KEY not configured' }, 200, cors);
  }

  const url = new URL(req.url);
  const raw = url.searchParams.get('bbox');
  if (!raw) return jsonResponse({ error: 'bbox required: minLon,minLat,maxLon,maxLat' }, 400, cors);

  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return jsonResponse({ error: 'bbox must be four finite numbers' }, 400, cors);
  }
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLon >= maxLon || minLat >= maxLat
      || Math.abs(minLat) > 90 || Math.abs(maxLat) > 90
      || Math.abs(minLon) > 180 || Math.abs(maxLon) > 180) {
    return jsonResponse({ error: 'bbox out of range or inverted' }, 400, cors);
  }

  const areaKm2 = Math.round(bboxAreaKm2(minLon, minLat, maxLon, maxLat));
  if (areaKm2 > MAX_BBOX_KM2) {
    // Answered as a normal result, not an error: at world zoom this is the
    // expected state, and the client renders a "zoom in" hint rather than
    // an empty layer that looks like "no traffic anywhere".
    return jsonResponse({
      tooLarge: true, areaKm2, maxAreaKm2: MAX_BBOX_KM2,
      reason: 'TomTom rejects any bbox over 10,000 km2; zoom in for traffic',
    }, 200, cors);
  }

  // Round the cache key so panning a few metres reuses a neighbour's result.
  const r = (n) => n.toFixed(2);
  const cacheKey = `traffic:tomtom:${r(minLon)},${r(minLat)},${r(maxLon)},${r(maxLat)}`;

  try {
    const cached = await readJsonFromUpstash(cacheKey, 2_000);
    if (cached) return jsonResponse({ ...cached, cached: true }, 200, cors);
  } catch {
    // Cache unavailable is not fatal — fall through to a live fetch.
  }

  const fields = '{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,delay,roadNumbers}}}';
  const upstream = new URL('https://api.tomtom.com/traffic/services/5/incidentDetails');
  upstream.searchParams.set('key', apiKey);
  upstream.searchParams.set('bbox', `${minLon},${minLat},${maxLon},${maxLat}`);
  upstream.searchParams.set('fields', fields);
  upstream.searchParams.set('language', 'en-GB');

  let payload;
  try {
    const res = await fetch(upstream, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      return jsonResponse({ error: 'upstream_error', status: res.status }, 502, cors);
    }
    const body = await res.json();
    const incidents = Array.isArray(body?.incidents) ? body.incidents : [];
    payload = {
      type: 'FeatureCollection',
      features: incidents,
      count: incidents.length,
      areaKm2,
      fetchedAt: new Date().toISOString(),
      attribution: 'Traffic data © TomTom',
    };
  } catch {
    return jsonResponse({ error: 'upstream_unreachable' }, 502, cors);
  }

  try {
    await setCachedData(cacheKey, payload, CACHE_TTL_SECONDS);
  } catch {
    // A write failure must not cost the caller its result.
  }

  return jsonResponse(payload, 200, {
    ...cors,
    'Cache-Control': `public, max-age=60, s-maxage=${CACHE_TTL_SECONDS}`,
  });
}
