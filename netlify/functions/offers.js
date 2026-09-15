// Password-gated endpoint for the private /admin.html page. Merges two
// sources of "who's offered on what":
//   1. Real submissions to the public "offer" form (Netlify Forms), fetched
//      live via the Netlify API using a token stored as an env var.
//   2. Manually-recorded offers from people who messaged Akki privately or
//      on Geekzone — kept in manual-offers.json, which Akki has Claude edit
//      and commit via git whenever a new one comes in (no self-service UI
//      by design, so there's no second write path to secure).
//
// Required Netlify environment variables (set on the site, never in the repo):
//   ADMIN_PASSWORD    - shared secret the admin page must send to read this
//   NETLIFY_API_TOKEN - a Netlify personal access token, used only server-side
//                       here to read form submissions
const manualOffers = require('./manual-offers.json');

const SITE_ID = '6787f046-e65b-4312-a55f-e48bc540f4cc';

exports.handler = async (event) => {
  const suppliedPassword =
    event.headers['x-admin-password'] ||
    (event.queryStringParameters && event.queryStringParameters.password);

  if (!process.env.ADMIN_PASSWORD || suppliedPassword !== process.env.ADMIN_PASSWORD) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  let publicOffers = [];
  try {
    const token = process.env.NETLIFY_API_TOKEN;
    const formsRes = await fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}/forms`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const forms = await formsRes.json();
    const offerForm = Array.isArray(forms) ? forms.find((f) => f.name === 'offer') : null;

    if (offerForm) {
      const subsRes = await fetch(`https://api.netlify.com/api/v1/forms/${offerForm.id}/submissions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const submissions = await subsRes.json();
      publicOffers = (Array.isArray(submissions) ? submissions : []).map((s) => ({
        item: s.data.item || '(unknown item)',
        name: s.data.name || '',
        email: s.data.email || '',
        offerAmount: s.data.offer || '',
        message: s.data.message || '',
        date: s.created_at,
        source: 'Website form',
      }));
    }
  } catch (e) {
    // If the Netlify API call fails for any reason, still return manual
    // offers below rather than a hard error.
  }

  const normalizedManual = manualOffers.map((m) => ({
    item: m.item || '(unknown item)',
    name: m.name || '',
    email: m.email || '',
    offerAmount: m.offerAmount || '',
    message: m.note || '',
    date: m.date || null,
    source: m.source || 'Manually added',
  }));

  const all = [...publicOffers, ...normalizedManual].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(all),
  };
};
