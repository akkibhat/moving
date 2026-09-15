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
//
// Required bindings/secrets (see wrangler.toml / `wrangler secret put`):
//   OFFERS_KV       - KV namespace storing all offers
//   IMAGES          - R2 bucket with the resized WebP photos
//   ADMIN_PASSWORD  - shared secret admin.html must send to read /api/offers
//   RESEND_API_KEY  - Resend API key used to email new-offer notifications
//   NOTIFY_EMAIL    - where offer notification emails get sent (Akki's inbox)

const SENDER_EMAIL = 'offers@move.pi.co.nz';

export default {
  async fetch(request, env) {
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

    // Fallback to static assets for anything else (normally not reached,
    // since matching static files are served before the Worker runs).
    return env.ASSETS.fetch(request);
  },
};

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
      text: `Item: ${record.item}\nName: ${record.name}\nEmail: ${record.email}\nOffer: ${record.offerAmount || 'n/a'}\n\n${record.message}`,
    }),
  });
}

async function handleGetOffers(request, env) {
  const suppliedPassword =
    request.headers.get('x-admin-password') || new URL(request.url).searchParams.get('password');

  if (!env.ADMIN_PASSWORD || suppliedPassword !== env.ADMIN_PASSWORD) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const offers = [];
  let cursor;
  do {
    const list = await env.OFFERS_KV.list({ prefix: 'offer:', cursor });
    for (const key of list.keys) {
      const value = await env.OFFERS_KV.get(key.name);
      if (value) offers.push(JSON.parse(value));
    }
    cursor = list.cursor;
  } while (cursor);

  offers.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  return jsonResponse(offers);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
