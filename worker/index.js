// Cloudflare Worker powering move.pi.co.nz.
//
// Static pages (index.html, admin.html) are served automatically by the
// Workers static-assets binding — this script only runs for requests that
// don't match a static file:
//   GET  /images/:file        - serves an optimized photo from R2
//   POST /api/submit-offer    - public "make an offer" form: stores the
//                                offer in KV and emails Akki via Resend
//   GET  /api/offers          - password-gated: returns every stored offer
//                                (public submissions + manually-added ones)
//                                for the private admin.html page
//   GET  /api/visits          - password-gated: returns recent visit logs
//                                (IP, country, referrer, user-agent) for the
//                                private admin.html page
//   POST /api/set-offer-flag  - password-gated: flips one boolean flag
//                                (paid or pickedUp) on one stored offer
//                                record (admin.html's Mark as paid/picked up
//                                buttons)
//   GET  /api/item-status     - public: returns live status overrides set
//                                via admin.html, as { itemName: status }.
//                                Only items changed since their hardcoded
//                                ITEM_STATUS value are included — the public
//                                page fetches this on load and patches its
//                                already-rendered cards, so a status change
//                                in admin shows up on the live site with no
//                                code edit or redeploy needed.
//   POST /api/set-item-status - password-gated: sets an item's live status
//                                (Available / Pending Sale / Sold) in KV.
//                                This is what admin.html's per-item status
//                                dropdown calls.
//   POST /api/set-offer-amount - password-gated: overwrites the offerAmount
//                                on one stored offer record — for correcting
//                                a typo'd/negotiated amount after the fact.
//                                This is what admin.html's per-offer amount
//                                field calls.
//   POST /api/set-winner      - password-gated: marks one specific offer as
//                                the winning offer for its item (and clears
//                                the winner flag off every other offer on
//                                that same item, since only one can win).
//
// Every request for the public listing page ("/") is also logged into
// VISITS_KV, fire-and-forget via ctx.waitUntil so it never slows down the
// visitor's page load. Captures everything Cloudflare exposes for free on
// the request: IP, country/region/city/postal code/timezone/lat-long, ISP
// (ASN + org), which Cloudflare datacenter served them, HTTP/TLS protocol
// version, round-trip latency, Accept-Language, referrer, and user-agent.
//
// Required bindings/secrets (see wrangler.toml / `wrangler secret put`):
//   OFFERS_KV       - KV namespace storing all offers
//   VISITS_KV       - KV namespace storing page-visit logs
//   IMAGES          - R2 bucket with the resized WebP photos
//   ADMIN_PASSWORD  - shared secret admin.html must send to read /api/offers
//                     and /api/visits
//   RESEND_API_KEY  - Resend API key used to email new-offer notifications
//   NOTIFY_EMAIL    - where offer notification emails get sent (Akki's inbox)

const SENDER_EMAIL = 'offers@move.pi.co.nz';

// The original asking price for each listing, as shown on the public page.
// Kept here (rather than re-parsing index.html at request time) so offer
// emails and the admin view can show "asking $X" next to whatever the buyer
// actually offered. Update this if a listed price on the site changes.
const ITEM_LISTED_PRICES = {
  'Grandstream HT802 — 2-Port VoIP ATA': '$20 NZD',
  'MikroTik RouterBOARD RBM33G': '$50 NZD',
  'TP-Link Powerline Adapter Pair — AV1300 (Pass-Through)': '$100 NZD',
  'TP-Link Powerline Adapter Pair — AV2000 (Pass-Through)': '$130 NZD',
  'TP-Link Archer AX72 — AX5400 WiFi 6 Router': '$150 NZD',
  'Huawei B818-263 — 4G LTE WiFi Router': '$25 NZD',
  'Cisco SPA112 — 2-Port VoIP Phone Adapter': '$20 NZD',
  'Edimax EN-9320SFP+ — Dual-Port 10G SFP+ NIC': '$50 NZD',
  'QNAP QXG-10G2T — Dual-Port 10GbE (RJ45) Expansion Card': '$100 NZD',
  'HPE Ethernet 10Gb 2-Port 562SFP+ Adapter': '$100 NZD',
  'Dell 10Gb SFP+ Dual-Port Adapter (P/N H44490-020)': '$50 NZD',
  'HP FlexFabric 10Gb 2-Port 526FLR-SFP+ Adapter': '$40 NZD',
  'HPE Ethernet 10Gb 2-Port 560FLR-SFP+ Adapter': '$50 NZD',
  'FS.com 10G SFP+ DAC Cables (Twinax) — Set of 5': '$100 NZD',
  'Ubiquiti UF-RJ45-10G Transceivers (×3)': '$70 NZD',
  'Pioneer DDJ-SR — Serato DJ Controller': '$300 NZD',
  'RAVPower Dual Charger + 2× Sony NP-FW50 Batteries': '$80 NZD',
  'Kenwood Full HD Dash Cam': '$20 NZD',
  'SmartVU+ A7070 — Satellite/Freeview Receiver': '$50 NZD',
  'Xiaomi Mi Box — Android TV Streaming Box': '$25 NZD',
  'HDMI Extender Kit — Sender + Receiver (LKV372A)': '$20 NZD',
  'Logitech MX Master 3 Wireless Mouse': '$50 NZD',
  'Wacom Intuos (Bluetooth) — CTL-4100WL Drawing Tablet': '$30 NZD',
  'PS4 DualShock 4 Controllers + Charging Dock': '$40 NZD',
  'PlayStation 3 (Slim)': '$50 NZD',
  'TCL 55C635 4K QLED Google TV': '$450 NZD',
  'Instant Pot Duo 80 (8-Quart) 7-in-1 Multi-Cooker': '$100 NZD',
  'Assorted Harry Potter Wands + Owl Holder': '$20 NZD',
  'Netgear Orbi RBR750 Router + 2× RBS750 Satellites': '$350 NZD',
  'Sony HT-RT40 5.1ch Soundbar System': '$100 NZD',
  'Nvidia Shield TV + Remote': '$150 NZD',
  'Black & Decker Dustbuster 4.8V': '$20 NZD',
  '2-Tier Side Table': '$25 NZD',
  'Morris 1.8m Entertainment Unit — Oak': '$100 NZD',
  'Feeltek Portable 9-in-2 USB-C Hub': '$20 NZD',
  'Free Dongle Bundle': 'Free',
  'Kogan SmarterHome™ LS16 Robot Vacuum + Auto-Empty Dock': '$150 NZD',
  'Sony Bravia KDL-32EX400 32" LCD TV': 'Free',
  'SingStar Wireless Microphones + Dongle': '$60 NZD',
  '2× Guitar Hero Guitars + Wireless Dongles': '$100 NZD',
  'Nikko Open-Face Helmet': '$40 NZD',
  'Squier by Fender Bullet Strat': '$150 NZD ($200 w/ cable)',
  'Logitech Harmony Elite (Hub + Premium Touch Remote) + 2× IR Blasters': '$100 NZD',
  'Karcher SE 3-18 Ultra Clean Battery Carpet Cleaner': '$150 NZD',
  'Texas Hold\'em Poker Set + Card Shuffler': '$10 NZD',
  'Ooni Karu 16 Multi-Fuel Pizza Oven': '$350 NZD',
  'Weber Family Q 3200 Gas BBQ': '$300 NZD',
  'Pit Boss Vertical Pellet Smoker': '$400 NZD',
  'Sistema Nest It Meal Prep Containers (5-Pack)': '$10 NZD',
  'Kogan Stick Blender + Attachments': '$20 NZD',
  'iGulu S1 Combo — Automatic Home Brewing Machine': '$280 NZD',
  'Lenovo ThinkPad X390': '$300 NZD',
  'Magic Bullet Blender + Food Processor': '$25 NZD',
  'AllDock Bamboo Charging Station': '$40 NZD',
  'Clifford Wooden Bedside Table': '$20 NZD',
  'Flynn 170cm Computer Desk - Oak': '$80 NZD',
  'Xoan Wooden Tallboy 4 Drawers - Oak': '$50 NZD',
  'Rudolf 5 Tier Bookshelf - Oak': '$80 NZD',
  'Desta Dining Table Rectangle 160x90cm - White + 4 Chairs': '$100 NZD',
  'ThunderX3 YAMA1 Gaming Ergonomic Chair': '$90 NZD',
  'Kogan SmarterHome Bladeless Purifier Tower Fan': '$50 NZD',
  'Kogan SmarterHome 2400W Smart Glass Panel Heater (Black)': '$60 NZD',
  'Brother HL-L2400DW Mono Laser Printer': '$100 NZD',
  'Breville Hand Mixer + 2 Sets of Beaters': '$15 NZD',
  'Goldair Weighted Heated Blanket 4.5kg': '$50 NZD',
  'Ecosa Weighted Blanket 9kg': '$50 NZD',
  'Microsoft Surface Laptop (1st Gen) + Dock + USB-C Adapter': '$150 NZD',
  '6-Drawer Wide Lowboy - Oak': '$80 NZD',
  '5-Drawer Tallboy - White': '$50 NZD',
  'Large Leather Corner Sofa': '$200 NZD',
  'Harris Bedside Table - Oak': '$35 NZD',
  'Trade Depot Bladeless Fan with Heater and Air Purifier - 2000W': '$120 NZD',
  'Double Bed': 'Free',
  'Double Bed + Mattress': 'Free',
  'Harris Double Wooden Bed Frame with Storage - Oak': '$120 NZD',
  'BetaLife Luxury Plus Mattress': '$150 NZD',
  'Wicker Outdoor Chairs + Ottoman': '$20 NZD',
  'Glass-Top Outdoor Dining Table + 6 Chairs': '$50 NZD',
  'LG NeoChef 42L Smart Inverter Microwave (MS4296OBS)': '$100 NZD',
  'Mongoose DX 3.1 Mountain Bike': '$70 NZD',
  'TP-Link Omada ER707-M2 — Multi-Gigabit VPN Gateway': '$250 NZD',
};

function listedPriceFor(item) {
  return ITEM_LISTED_PRICES[item] || 'unknown';
}

// Mirrors each item's data-status on the public page (Available / Pending
// Sale / Sold) — kept here for the same reason as ITEM_LISTED_PRICES above.
// Only items that currently have a non-Available status are listed; update
// this whenever an item's status changes on the site.
const ITEM_STATUS = {
  'Dell 10Gb SFP+ Dual-Port Adapter (P/N H44490-020)': 'Sold',
  'FS.com 10G SFP+ DAC Cables (Twinax) — Set of 5': 'Sold',
  'SmartVU+ A7070 — Satellite/Freeview Receiver': 'Sold',
  'Xiaomi Mi Box — Android TV Streaming Box': 'Sold',
  'Logitech MX Master 3 Wireless Mouse': 'Sold',
  'PS4 DualShock 4 Controllers + Charging Dock': 'Sold',
  'Free Dongle Bundle': 'Sold',
  'Kogan SmarterHome™ LS16 Robot Vacuum + Auto-Empty Dock': 'Pending Sale',
  'Squier by Fender Bullet Strat': 'Sold',
  'Logitech Harmony Elite (Hub + Premium Touch Remote) + 2× IR Blasters': 'Pending Sale',
  'Nvidia Shield TV + Remote': 'Sold',
  'Black & Decker Dustbuster 4.8V': 'Pending Sale',
};

// The 3 statuses an item can be in. Used to validate /api/set-item-status
// input and to know what counts as "changed from the hardcoded default"
// when deciding what /api/item-status needs to send the public page.
const VALID_ITEM_STATUSES = ['Available', 'Pending Sale', 'Sold'];

// Hardcoded fallback, unaware of any live override — only used as the
// baseline that a KV override is compared against (see handleGetItemStatus)
// and as what a fresh page load without JS would still show correctly.
function hardcodedStatusFor(item) {
  return ITEM_STATUS[item] || 'Available';
}

// The item's current status, checking the live KV override first (set via
// admin.html's status dropdown) and falling back to the hardcoded table.
// This is what actually gets shown in admin — the public page instead
// fetches /api/item-status itself and patches its static HTML client-side,
// since it's served straight from the assets binding rather than run
// through this Worker script.
async function statusFor(item, env) {
  const override = await env.OFFERS_KV.get(`status:${item}`);
  return override || hardcodedStatusFor(item);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/images/')) {
      return handleImage(request, env, url);
    }
    if (url.pathname === '/api/submit-offer' && request.method === 'POST') {
      return handleSubmitOffer(request, env);
    }
    if (url.pathname === '/api/offers' && request.method === 'GET') {
      return handleGetOffers(request, env);
    }
    if (url.pathname === '/api/visits' && request.method === 'GET') {
      return handleGetVisits(request, env);
    }
    if (url.pathname === '/api/set-offer-flag' && request.method === 'POST') {
      return handleSetOfferFlag(request, env);
    }
    if (url.pathname === '/api/item-status' && request.method === 'GET') {
      return handleGetItemStatus(request, env);
    }
    if (url.pathname === '/api/set-item-status' && request.method === 'POST') {
      return handleSetItemStatus(request, env);
    }
    if (url.pathname === '/api/set-offer-amount' && request.method === 'POST') {
      return handleSetOfferAmount(request, env);
    }
    if (url.pathname === '/api/set-winner' && request.method === 'POST') {
      return handleSetWinner(request, env);
    }

    // Log a visit to the public listing page itself — not admin.html (that's
    // just Akki checking his own site) and not asset/API requests (way too
    // noisy). Fire-and-forget via waitUntil so it never delays the response.
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      ctx.waitUntil(logVisit(request, env));
    }

    // Fallback to static assets for anything else (normally not reached,
    // since matching static files are served before the Worker runs).
    return env.ASSETS.fetch(request);
  },
};

async function logVisit(request, env) {
  const now = new Date();
  const id = `visit:${now.toISOString()}:${crypto.randomUUID().slice(0, 8)}`;
  const record = {
    date: now.toISOString(),
    ip: request.headers.get('cf-connecting-ip') || '',
    country: request.cf?.country || '',
    city: request.cf?.city || '',
    region: request.cf?.region || '',
    regionCode: request.cf?.regionCode || '',
    postalCode: request.cf?.postalCode || '',
    timezone: request.cf?.timezone || '',
    latitude: request.cf?.latitude || '',
    longitude: request.cf?.longitude || '',
    asn: request.cf?.asn || '',
    asOrganization: request.cf?.asOrganization || '',
    colo: request.cf?.colo || '',
    httpProtocol: request.cf?.httpProtocol || '',
    tlsVersion: request.cf?.tlsVersion || '',
    clientTcpRtt: request.cf?.clientTcpRtt ?? '',
    acceptLanguage: request.headers.get('accept-language') || '',
    referrer: request.headers.get('referer') || '',
    userAgent: request.headers.get('user-agent') || '',
  };
  // Keep visit logs for 90 days — plenty for a temporary moving-sale site,
  // and avoids the KV namespace growing unbounded forever.
  await env.VISITS_KV.put(id, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 90 });
}

async function handleImage(request, env, url) {
  const key = decodeURIComponent(url.pathname.replace('/images/', ''));
  // Anything under private/ (e.g. the visits cache) shares this bucket but must
  // never be downloadable through this public route.
  if (key.startsWith('private/')) {
    return new Response('Not found', { status: 404 });
  }
  const object = await env.IMAGES.get(key);
  if (!object) {
    return new Response('Not found', { status: 404 });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Content-Type', 'image/webp');
  return new Response(object.body, { headers });
}

async function handleSubmitOffer(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  // Honeypot: if this hidden field got filled in, silently pretend success.
  if (payload['bot-field']) {
    return jsonResponse({ ok: true });
  }

  const { item, name, email, offer, message } = payload;
  if (!item || !name || !email) {
    return jsonResponse({ error: 'Missing required fields' }, 400);
  }

  const now = new Date();
  const id = `offer:${now.toISOString()}:${crypto.randomUUID().slice(0, 8)}`;
  const record = {
    item,
    name,
    email,
    offerAmount: offer || '',
    message: message || '',
    date: now.toISOString(),
    source: 'Website form',
  };

  await env.OFFERS_KV.put(id, JSON.stringify(record));

  // Best-effort email notification — a failure here shouldn't fail the
  // visitor's submission, since the offer is already safely stored above.
  try {
    await sendNotificationEmail(env, record);
  } catch (e) {
    // swallow
  }

  return jsonResponse({ ok: true });
}

async function sendNotificationEmail(env, record) {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Moving Sale <${SENDER_EMAIL}>`,
      to: env.NOTIFY_EMAIL,
      reply_to: record.email,
      subject: `Offer from ${record.email}`,
      text: `Item: ${record.item}\nListed at: ${listedPriceFor(record.item)}\nName: ${record.name}\nEmail: ${record.email}\nOffer: ${record.offerAmount || 'n/a'}\n\n${record.message}`,
    }),
  });
}

// Fetches every stored offer record from KV, each tagged with its own KV
// key (so callers can write back to the exact record they read). Shared by
// handleGetOffers and handleSetWinner rather than duplicated, since both
// need "every offer, with its key" as a starting point.
async function getAllOffers(env) {
  // List all keys first (paginating if there are ever more than one page),
  // then fetch every value in parallel rather than one at a time — with a
  // few dozen offers, sequential gets were adding a noticeable delay before
  // the admin page could render.
  const allKeys = [];
  let cursor;
  do {
    const list = await env.OFFERS_KV.list({ prefix: 'offer:', cursor });
    allKeys.push(...list.keys);
    cursor = list.cursor;
  } while (cursor);

  const values = await Promise.all(allKeys.map((key) => env.OFFERS_KV.get(key.name)));
  return allKeys
    .map((key, i) => (values[i] ? { key: key.name, ...JSON.parse(values[i]) } : null))
    .filter(Boolean);
}

async function handleGetOffers(request, env) {
  const suppliedPassword =
    request.headers.get('x-admin-password') || new URL(request.url).searchParams.get('password');

  if (!env.ADMIN_PASSWORD || suppliedPassword !== env.ADMIN_PASSWORD) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const offers = await getAllOffers(env);
  offers.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  // Attach the current listed price/status at read time so every offer (old
  // and new) shows them, without needing to backfill stored records.
  const withPrices = await Promise.all(
    offers.map(async (o) => ({
      ...o,
      listedPrice: listedPriceFor(o.item),
      itemStatus: await statusFor(o.item, env),
    }))
  );

  return jsonResponse(withPrices);
}

// Fields the admin page is allowed to flip on an offer record via
// /api/set-offer-flag. Kept as an allow-list so the endpoint can't be used
// to overwrite arbitrary fields (item, offerAmount, etc).
const SETTABLE_OFFER_FLAGS = ['paid', 'pickedUp'];

// Flips one boolean flag (paid or pickedUp) on a single stored offer record
// — used by the admin page's "Mark as paid"/"Mark as picked up" buttons (and
// their "unmark" equivalents) on sold items. Takes the offer's KV key (as
// returned by /api/offers), which flag to set, and the new value.
async function handleSetOfferFlag(request, env) {
  const suppliedPassword = request.headers.get('x-admin-password');
  if (!env.ADMIN_PASSWORD || suppliedPassword !== env.ADMIN_PASSWORD) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const { key, field, value } = payload;
  if (!key || !SETTABLE_OFFER_FLAGS.includes(field)) {
    return jsonResponse({ error: 'Missing key or invalid field' }, 400);
  }

  const existing = await env.OFFERS_KV.get(key);
  if (!existing) {
    return jsonResponse({ error: 'Offer not found' }, 404);
  }

  const record = JSON.parse(existing);
  record[field] = !!value;
  await env.OFFERS_KV.put(key, JSON.stringify(record));

  return jsonResponse({ ok: true });
}

// Public (no password) — the live listing page fetches this on every load
// to patch its statically-rendered cards with anything changed via admin
// since the last deploy. Only items with a KV override are included, so a
// quiet page (nothing changed today) gets back an almost-empty object.
async function handleGetItemStatus(request, env) {
  const list = await env.OFFERS_KV.list({ prefix: 'status:' });
  const values = await Promise.all(list.keys.map((k) => env.OFFERS_KV.get(k.name)));

  const overrides = {};
  list.keys.forEach((k, i) => {
    const item = k.name.slice('status:'.length);
    if (values[i]) overrides[item] = values[i];
  });

  return jsonResponse(overrides);
}

// Sets an item's live status. This is the KV override that both statusFor()
// (used by the admin offers view) and the public page's /api/item-status
// fetch read from — so one call here updates admin and the live site alike,
// with no code change or redeploy.
async function handleSetItemStatus(request, env) {
  const suppliedPassword = request.headers.get('x-admin-password');
  if (!env.ADMIN_PASSWORD || suppliedPassword !== env.ADMIN_PASSWORD) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const { item, status } = payload;
  if (!item || !VALID_ITEM_STATUSES.includes(status)) {
    return jsonResponse({ error: 'Missing item or invalid status' }, 400);
  }

  await env.OFFERS_KV.put(`status:${item}`, status);
  return jsonResponse({ ok: true });
}

// Overwrites the offerAmount on one stored offer record — for when Akki
// negotiates a different number over text/PM after the fact, or a buyer's
// typed offer had a typo. Takes the offer's KV key (as returned by
// /api/offers), same identify-by-key pattern as handleSetOfferFlag, but
// writes a string field instead of flipping a boolean.
async function handleSetOfferAmount(request, env) {
  const suppliedPassword = request.headers.get('x-admin-password');
  if (!env.ADMIN_PASSWORD || suppliedPassword !== env.ADMIN_PASSWORD) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const { key, offerAmount } = payload;
  if (!key || offerAmount === undefined) {
    return jsonResponse({ error: 'Missing key or offerAmount' }, 400);
  }

  const existing = await env.OFFERS_KV.get(key);
  if (!existing) {
    return jsonResponse({ error: 'Offer not found' }, 404);
  }

  const record = JSON.parse(existing);
  record.offerAmount = offerAmount;
  await env.OFFERS_KV.put(key, JSON.stringify(record));

  return jsonResponse({ ok: true });
}

// Marks one offer as the winning offer for its item, and un-marks every
// other offer on that same item — only one buyer can be "selected" at a
// time. Used by admin.html's "Select as winner" button on an offer row.
async function handleSetWinner(request, env) {
  const suppliedPassword = request.headers.get('x-admin-password');
  if (!env.ADMIN_PASSWORD || suppliedPassword !== env.ADMIN_PASSWORD) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const { item, key } = payload;
  if (!item || !key) {
    return jsonResponse({ error: 'Missing item or key' }, 400);
  }

  const offers = await getAllOffers(env);
  const forThisItem = offers.filter((o) => o.item === item);

  await Promise.all(
    forThisItem.map((o) => {
      const shouldBeWinner = o.key === key;
      if (!!o.winner === shouldBeWinner) return null; // already correct, skip the write
      const { key: kvKey, ...record } = o;
      record.winner = shouldBeWinner;
      return env.OFFERS_KV.put(kvKey, JSON.stringify(record));
    })
  );

  return jsonResponse({ ok: true });
}

async function handleGetVisits(request, env) {
  const suppliedPassword =
    request.headers.get('x-admin-password') || new URL(request.url).searchParams.get('password');

  if (!env.ADMIN_PASSWORD || suppliedPassword !== env.ADMIN_PASSWORD) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // 1. Load the permanent cache of visits from R2. Each entry is
  //    { k: <the KV key name>, v: <the parsed visit record> }. VISITS_KV entries
  //    expire after 90 days, but anything already copied into this file stays
  //    forever. A missing file just means "start with an empty cache".
  const cacheObject = await env.IMAGES.get(VISITS_CACHE_KEY);
  const cached = cacheObject ? await cacheObject.json() : [];
  const cachedKeys = new Set(cached.map((entry) => entry.k));

  // 2. List every visit key still in KV. (Listing costs one subrequest per
  //    1000 keys, so this stays cheap however large the log grows.)
  const kvKeys = [];
  let cursor;
  do {
    const list = await env.VISITS_KV.list({ prefix: 'visit:', cursor, limit: 1000 });
    kvKeys.push(...list.keys);
    cursor = list.cursor;
  } while (cursor);

  // 3. Work out which keys are not in the cache yet, newest first. A Worker
  //    invocation may make at most 1000 subrequests and every KV get counts as
  //    one, so read at most MAX_NEW_PER_LOAD per request; anything left over is
  //    picked up on the next load because it is still missing from the cache.
  const MAX_NEW_PER_LOAD = 900;
  const newKeys = kvKeys
    .map((key) => key.name)
    .filter((name) => !cachedKeys.has(name))
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, MAX_NEW_PER_LOAD);

  // 4. Fetch just those new visits. A value can be null if the key expired
  //    between the list and the get, so those are skipped.
  const values = await Promise.all(newKeys.map((name) => env.VISITS_KV.get(name)));
  const fresh = [];
  newKeys.forEach((name, i) => {
    if (values[i]) fresh.push({ k: name, v: JSON.parse(values[i]) });
  });

  // 5. Merge into the cache and save it back, but only if something changed.
  //    Keys are ISO-timestamp-prefixed, so sorting on them gives newest first.
  const merged = cached.concat(fresh).sort((a, b) => (a.k < b.k ? 1 : -1));
  if (fresh.length > 0) {
    await env.IMAGES.put(VISITS_CACHE_KEY, JSON.stringify(merged), {
      httpMetadata: { contentType: 'application/json' },
    });
  }

  return jsonResponse(merged.map((entry) => entry.v));
}

// R2 object that holds every visit ever logged. It lives in the same bucket as
// the public photos, so handleImage() refuses any key starting with private/;
// the password-gated /api/visits handler above is the only thing that reads it.
const VISITS_CACHE_KEY = 'private/visits-cache.json';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
