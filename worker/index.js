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
  'Huawei B818-263 — 4G LTE WiFi Router': '$50 NZD',
  'Cisco SPA112 — 2-Port VoIP Phone Adapter': '$30 NZD',
  'Edimax EN-9320SFP+ — Dual-Port 10G SFP+ NIC': '$50 NZD',
  'QNAP QXG-10G2T — Dual-Port 10GbE (RJ45) Expansion Card': '$100 NZD',
  'HPE Ethernet 10Gb 2-Port 562SFP+ Adapter': '$100 NZD',
  'Dell 10Gb SFP+ Dual-Port Adapter (P/N H44490-020)': '$50 NZD',
  'HP FlexFabric 10Gb 2-Port 526FLR-SFP+ Adapter': '$40 NZD',
  'HPE Ethernet 10Gb 2-Port 560FLR-SFP+ Adapter': '$50 NZD',
  'FS.com 10G SFP+ DAC Cables (Twinax) — Set of 5': '$100 NZD',
  'Ubiquiti UF-RJ45-10G Transceivers (×3)': '$70 NZD',
  'Pioneer DDJ-SR — Serato DJ Controller': '$350 NZD',
  'RAVPower Dual Charger + 2× Sony NP-FW50 Batteries': '$120 NZD',
  'Kenwood Full HD Dash Cam': '$50 NZD',
  'SmartVU+ A7070 — Satellite/Freeview Receiver': '$50 NZD',
  'Xiaomi Mi Box — Android TV Streaming Box': '$25 NZD',
  'HDMI Extender Kit — Sender + Receiver (LKV372A)': '$40 NZD',
  'Microsoft Surface Dock (1st gen, 1661) + Power Supply': '$60 NZD',
  'Logitech MX Master 3 Wireless Mouse': '$50 NZD',
  'Wacom Intuos (Bluetooth) — CTL-4100WL Drawing Tablet': '$30 NZD',
  'Ozito PXC 18V Drill + LED Worklight + Battery + Charger': '$60 NZD',
  'PS4 DualShock 4 Controllers + Charging Dock': '$40 NZD',
  'PlayStation 3 (Slim)': '$100 NZD',
  'TCL 55C635 4K QLED Google TV': '$450 NZD',
  'Instant Pot Duo 80 (8-Quart) 7-in-1 Multi-Cooker': '$100 NZD',
  'Assorted Harry Potter Wands + Owl Holder': '$20 NZD',
  'Netgear Orbi RBR750 Router + 2× RBS750 Satellites': '$350 NZD',
  'Sony HT-RT40 5.1ch Soundbar System': '$180 NZD',
  'Nvidia Shield TV + Remote': '$150 NZD',
  'Black & Decker Dustbuster 4.8V': '$20 NZD',
  '2-Tier Side Table': '$25 NZD',
  'Morris 1.8m Entertainment Unit — Oak': '$100 NZD',
  'Feeltek Portable 9-in-2 USB-C Hub': '$35 NZD',
  'Free Dongle Bundle': 'Free',
  'Kogan SmarterHome™ LS16 Robot Vacuum + Auto-Empty Dock': '$150 NZD',
  'Sony Bravia KDL-32EX400 32" LCD TV': 'Free',
  'SingStar Wireless Microphones + Dongle': '$60 NZD',
  '2× Guitar Hero Guitars + Wireless Dongles': '$100 NZD',
  'Nikko Open-Face Helmet': '$40 NZD',
  'Squier by Fender Bullet Strat': '$150 NZD ($200 w/ cable)',
  'Logitech Harmony Elite (Hub + Premium Touch Remote) + 2× IR Blasters': '$100 NZD',
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
  'Ozito PXC 18V Drill + LED Worklight + Battery + Charger': 'Pending Sale',
  'PS4 DualShock 4 Controllers + Charging Dock': 'Sold',
  'Free Dongle Bundle': 'Sold',
  'Kogan SmarterHome™ LS16 Robot Vacuum + Auto-Empty Dock': 'Pending Sale',
  'Squier by Fender Bullet Strat': 'Pending Sale',
  'Logitech Harmony Elite (Hub + Premium Touch Remote) + 2× IR Blasters': 'Pending Sale',
  'Nvidia Shield TV + Remote': 'Sold',
};

function statusFor(item) {
  return ITEM_STATUS[item] || 'Available';
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

async function handleGetOffers(request, env) {
  const suppliedPassword =
    request.headers.get('x-admin-password') || new URL(request.url).searchParams.get('password');

  if (!env.ADMIN_PASSWORD || suppliedPassword !== env.ADMIN_PASSWORD) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

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
  const offers = allKeys
    .map((key, i) => (values[i] ? { key: key.name, ...JSON.parse(values[i]) } : null))
    .filter(Boolean);

  offers.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  // Attach the current listed price/status at read time so every offer (old
  // and new) shows them, without needing to backfill stored records.
  const withPrices = offers.map((o) => ({
    ...o,
    listedPrice: listedPriceFor(o.item),
    itemStatus: statusFor(o.item),
  }));

  return jsonResponse(withPrices);
}

async function handleGetVisits(request, env) {
  const suppliedPassword =
    request.headers.get('x-admin-password') || new URL(request.url).searchParams.get('password');

  if (!env.ADMIN_PASSWORD || suppliedPassword !== env.ADMIN_PASSWORD) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // Most recent 500 visits — this list can grow fast, so cap it rather than
  // pulling every visit in the 90-day retention window on every request.
  const allKeys = [];
  let cursor;
  do {
    const list = await env.VISITS_KV.list({ prefix: 'visit:', cursor, limit: 1000 });
    allKeys.push(...list.keys);
    cursor = list.cursor;
    if (allKeys.length >= 500) break;
  } while (cursor);

  // Keys are ISO-timestamp-prefixed, so sorting the keys themselves (newest
  // first) avoids fetching every value just to sort — then only fetch the
  // most recent 500.
  allKeys.sort((a, b) => (a.name < b.name ? 1 : -1));
  const recentKeys = allKeys.slice(0, 500);

  const values = await Promise.all(recentKeys.map((key) => env.VISITS_KV.get(key.name)));
  const visits = values.filter(Boolean).map((v) => JSON.parse(v));

  return jsonResponse(visits);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
