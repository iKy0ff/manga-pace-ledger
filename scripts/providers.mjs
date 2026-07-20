// Chapter-count providers.
//
// Each provider exposes the same shape so sync.mjs doesn't care where the
// number came from:
//
//   { name, describe(), fetchChapters() -> { chapters, note } }
//
// ---------------------------------------------------------------------------
// A WARNING ABOUT THE MANGABAKA PROVIDER
// ---------------------------------------------------------------------------
// Kitsu's endpoint is a documented, versioned public API. MangaBaka's is NOT.
// There is no documented endpoint for a user's aggregate stats, so this
// provider calls the same internal endpoint MangaBaka's own profile page uses:
//
//   GET https://mangabaka.org/_app/remote/<HASH>/getStatsOverview?payload=<b64>
//
// <HASH> is SvelteKit's per-build content hash for that server module. It is an
// internal framework detail, not a stable contract — it is expected to change
// whenever MangaBaka ships a new deploy, at which point the URL 404s with no
// warning and no changelog. This module tries to re-discover the hash
// automatically when that happens (see discoverRemoteHash), but auto-discovery
// is itself best-effort and can break too.
//
// This is why sync.mjs writes sync_status.json on every run: so a silent
// breakage shows up on the dashboard instead of just quietly freezing your
// chapter count.
// ---------------------------------------------------------------------------

const USER_AGENT =
  'manga-pace-ledger/1.2 (+https://github.com/iKy0ff/manga-pace-ledger)';

/* ===========================================================================
   devalue decoding
   ===========================================================================
   SvelteKit remote functions return { type: "result", data: "<json string>" }
   where the inner string is a devalue-flattened array: index 0 is the root,
   and any non-negative number is a back-reference to another index (this is
   how devalue dedupes repeated values). Negative numbers are reserved
   sentinels. We only ever expect plain objects/numbers/null here, but the
   resolver handles the general shape so an additive schema change doesn't
   crash the sync.
=========================================================================== */

const DEVALUE_SENTINELS = {
  '-1': undefined,
  '-2': undefined, // array hole
  '-3': NaN,
  '-4': Infinity,
  '-5': -Infinity,
  '-6': -0,
};

export function decodeDevalue(flat) {
  if (!Array.isArray(flat) || flat.length === 0) {
    throw new Error('devalue payload was not a non-empty array');
  }

  const seen = new Map();

  function resolve(encoded) {
    if (typeof encoded === 'number') {
      if (encoded < 0) {
        if (String(encoded) in DEVALUE_SENTINELS) return DEVALUE_SENTINELS[String(encoded)];
        throw new Error(`unknown devalue sentinel ${encoded}`);
      }
      if (encoded >= flat.length) {
        throw new Error(`devalue index ${encoded} out of range (len ${flat.length})`);
      }
      if (seen.has(encoded)) return seen.get(encoded);
      const value = hydrate(flat[encoded], encoded);
      return value;
    }
    // Literals embedded directly (devalue does this for nothing we expect,
    // but being permissive here costs nothing).
    return encoded;
  }

  function hydrate(raw, index) {
    if (raw === null || typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      seen.set(index, raw);
      return raw;
    }

    if (Array.isArray(raw)) {
      // devalue tags special types as ["Date", ...], ["Set", ...] etc.
      if (typeof raw[0] === 'string') {
        switch (raw[0]) {
          case 'Date': {
            const d = new Date(raw[1]);
            seen.set(index, d);
            return d;
          }
          case 'Set': {
            const s = new Set();
            seen.set(index, s);
            for (let i = 1; i < raw.length; i++) s.add(resolve(raw[i]));
            return s;
          }
          case 'Map': {
            const m = new Map();
            seen.set(index, m);
            for (let i = 1; i < raw.length; i += 2) m.set(resolve(raw[i]), resolve(raw[i + 1]));
            return m;
          }
          case 'BigInt': {
            const b = BigInt(raw[1]);
            seen.set(index, b);
            return b;
          }
          default:
            // Unknown tag — fall through and treat as a plain array so we
            // don't hard-fail on a schema addition.
            break;
        }
      }
      const arr = [];
      seen.set(index, arr);
      for (const item of raw) arr.push(resolve(item));
      return arr;
    }

    if (typeof raw === 'object') {
      const obj = {};
      seen.set(index, obj);
      for (const [k, v] of Object.entries(raw)) obj[k] = resolve(v);
      return obj;
    }

    seen.set(index, raw);
    return raw;
  }

  return resolve(0);
}

/* Depth-first search for a key anywhere in the decoded tree. Used instead of
   hardcoding root._.overview.total_chapters_read so that a reshuffle of
   MangaBaka's response nesting doesn't break the sync — only an actual rename
   of the field would. */
export function findKeyDeep(value, key, maxDepth = 8) {
  const queue = [[value, 0]];
  const visited = new Set();
  while (queue.length) {
    const [node, depth] = queue.shift();
    if (!node || typeof node !== 'object' || depth > maxDepth) continue;
    if (visited.has(node)) continue;
    visited.add(node);
    if (!Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, key)) {
      return node[key];
    }
    for (const child of Object.values(node)) queue.push([child, depth + 1]);
  }
  return undefined;
}

/* ===========================================================================
   MangaBaka
=========================================================================== */

// The ?payload= argument is just base64'd JSON in SvelteKit's remote-function
// argument format. For getStatsOverview({ username }) it decodes to:
//   [["__skrao",1],{"username":2},"<username>"]
export function buildMangaBakaPayload(username) {
  const json = JSON.stringify([['__skrao', 1], { username: 2 }, username]);
  return Buffer.from(json, 'utf8').toString('base64');
}

export function mangaBakaStatsUrl(username, hash) {
  const payload = encodeURIComponent(buildMangaBakaPayload(username));
  return `https://mangabaka.org/_app/remote/${hash}/getStatsOverview?payload=${payload}`;
}

// Best-effort recovery when the build hash changes. Loads the public profile
// page, then the JS bundles it references, looking for the remote-function
// hash. Returns null rather than throwing so the caller can report a clean
// "endpoint moved, here's how to fix it" message.
export async function discoverRemoteHash(username, { fetchImpl = fetch, maxChunks = 25 } = {}) {
  const pageUrl = `https://mangabaka.org/u/${encodeURIComponent(username)}`;
  const directRe = /_app\/remote\/([A-Za-z0-9_-]+)\/getStatsOverview/;

  let html;
  try {
    const res = await fetchImpl(pageUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  const direct = html.match(directRe);
  if (direct) return direct[1];

  // Not inlined — scan the page's own JS chunks.
  const chunkRe = /["'(]([^"'()]*\/_app\/immutable\/[^"'()]+\.js)["')]/g;
  const chunks = new Set();
  let m;
  while ((m = chunkRe.exec(html)) !== null) {
    let href = m[1];
    if (href.startsWith('//')) href = 'https:' + href;
    else if (href.startsWith('/')) href = 'https://mangabaka.org' + href;
    else if (!/^https?:/.test(href)) continue;
    chunks.add(href);
    if (chunks.size >= maxChunks) break;
  }

  for (const url of chunks) {
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) continue;
      const js = await res.text();
      const hit = js.match(directRe);
      if (hit) return hit[1];
    } catch {
      /* keep trying the remaining chunks */
    }
  }

  return null;
}

export function extractChaptersMangaBaka(bodyText) {
  let outer;
  try {
    outer = JSON.parse(bodyText);
  } catch {
    throw new Error('response was not JSON (endpoint may have moved or returned an HTML error page)');
  }

  if (outer && outer.type === 'error') {
    throw new Error(`endpoint returned an error result: ${JSON.stringify(outer).slice(0, 200)}`);
  }
  if (!outer || typeof outer.data !== 'string') {
    throw new Error('response JSON had no "data" string (unexpected shape)');
  }

  let flat;
  try {
    flat = JSON.parse(outer.data);
  } catch {
    throw new Error('inner "data" field was not valid JSON');
  }

  const decoded = decodeDevalue(flat);
  const raw = findKeyDeep(decoded, 'total_chapters_read');

  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error('could not find a numeric total_chapters_read in the response');
  }

  // MangaBaka reports a fractional total (partial chapter progress counts).
  // The ledger schema is integer chapters, so take completed chapters only.
  return Math.floor(raw);
}

/* ===========================================================================
   Kitsu
=========================================================================== */

export function kitsuStatsUrl(userId) {
  return `https://kitsu.io/api/edge/users/${userId}/stats`;
}

// Kitsu doesn't expose the value at a plain data[].attributes.units path,
// which is why the original VBS sync did a raw substring search. Kept
// byte-identical in behaviour so switching between the VBS/Node/browser paths
// can never produce a different number.
export function extractChaptersKitsu(bodyText) {
  let pos = bodyText.indexOf('"kind":"manga-amount-consumed"');
  if (pos === -1) pos = bodyText.indexOf('"kind": "manga-amount-consumed"');
  if (pos === -1) {
    throw new Error("'manga-amount-consumed' kind not found in API response (unexpected payload)");
  }
  const chunk = bodyText.slice(pos, pos + 300);
  const match = chunk.match(/"units"\s*:\s*(\d+)/);
  if (!match) {
    throw new Error("could not parse 'units' value from response chunk near manga-amount-consumed");
  }
  return parseInt(match[1], 10);
}

/* ===========================================================================
   Provider factory
=========================================================================== */

export function createProvider(config) {
  const { provider, kitsuUserId, mangabakaUsername, mangabakaHash, onHashRediscovered } = config;

  if (provider === 'kitsu') {
    return {
      name: 'kitsu',
      describe: () => `Kitsu user ${kitsuUserId}`,
      async fetchChapters({ fetchImpl = fetch } = {}) {
        const res = await fetchImpl(`${kitsuStatsUrl(kitsuUserId)}?cachebuster=${Date.now()}`, {
          headers: {
            Accept: 'application/vnd.api+json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
            'User-Agent': USER_AGENT,
          },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { chapters: extractChaptersKitsu(await res.text()) };
      },
    };
  }

  if (provider === 'mangabaka') {
    return {
      name: 'mangabaka',
      describe: () => `MangaBaka user ${mangabakaUsername} (hash ${mangabakaHash})`,
      async fetchChapters({ fetchImpl = fetch } = {}) {
        const attempt = async (hash) => {
          const res = await fetchImpl(mangaBakaStatsUrl(mangabakaUsername, hash), {
            headers: {
              Accept: 'application/json',
              'Cache-Control': 'no-cache',
              'User-Agent': USER_AGENT,
            },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return extractChaptersMangaBaka(await res.text());
        };

        try {
          return { chapters: await attempt(mangabakaHash) };
        } catch (firstErr) {
          // Most likely cause: MangaBaka redeployed and the build hash moved.
          const found = await discoverRemoteHash(mangabakaUsername, { fetchImpl });
          if (!found) {
            throw new Error(
              `${firstErr.message}; and auto-rediscovery of the endpoint hash failed. ` +
                `MangaBaka has probably changed its internal API. Re-capture the URL from ` +
                `DevTools (Network tab, filter Fetch/XHR, reload your profile page, look for ` +
                `getStatsOverview) and update MANGABAKA_REMOTE_HASH in scripts/sync.mjs.`
            );
          }
          if (found === mangabakaHash) throw firstErr; // hash was fine; something else broke
          const chapters = await attempt(found);
          if (typeof onHashRediscovered === 'function') onHashRediscovered(found);
          return {
            chapters,
            note:
              `endpoint hash changed from "${mangabakaHash}" to "${found}" and was ` +
              `auto-recovered for this run — update MANGABAKA_REMOTE_HASH in ` +
              `scripts/sync.mjs to make it stick`,
          };
        }
      },
    };
  }

  throw new Error(`unknown provider "${provider}" (expected "kitsu" or "mangabaka")`);
}
