# NZ Moving Sale

Static listing site for Akki's moving sale, served from **Cloudflare Workers**
at [move.pi.co.nz](https://move.pi.co.nz).

## Why Cloudflare Workers (not Netlify)

This started on Netlify (drag-and-drop deploy → later linked to
[github.com/akkibhat/moving](https://github.com/akkibhat/moving) for
auto-deploy on push). Netlify's free-tier credit allowance got used up
during initial setup, blocking new production deploys until the monthly
reset — not viable for a site that needs daily updates (marking items
sold/pending, logging new offers). Migrated to Cloudflare Workers, which has
no such deploy-credit cap on its free tier.

## Architecture

- **`public/`** — static site: `index.html` (the listing) and `admin.html`
  (private offers log). Served directly by the Workers static-assets binding.
- **`worker/index.js`** — handles everything that isn't a static file:
  - `GET /images/*` — serves optimized photos from the R2 bucket
    `nzmovingsale-images`
  - `POST /api/submit-offer` — the public "Make an offer" form: stores the
    offer in the `OFFERS_KV` KV namespace and emails a notification via
    Resend
  - `GET /api/offers` — password-gated; returns every offer (public
    submissions + manually-added ones) for `admin.html`
- **`images/`** — original full-size JPEGs (source of truth, ~12MB).
- **`images-optimized/`** — resized (700px wide) WebP versions, uploaded to
  the R2 bucket. Regenerate with ImageMagick if new photos are added:
  ```
  magick original.jpg -resize 700x -quality 75 images-optimized/original.webp
  ```
  then `wrangler r2 object put nzmovingsale-images/original.webp --file=images-optimized/original.webp --content-type=image/webp --remote`.

## Secrets (set via `wrangler secret put`, never in the repo)

- `ADMIN_PASSWORD` — required to read `/api/offers` (the private admin page
  prompts for this and sends it as an `X-Admin-Password` header)
- `RESEND_API_KEY` — Resend API key for sending offer-notification emails
- `NOTIFY_EMAIL` — where those notification emails go (akki@pi.co.nz)

## Adding a manually-heard-about offer (Geekzone PM, private message, etc.)

There's no self-service UI for this by design (keeps `/api/offers` the only
read path and avoids a second, unauthenticated write path). Instead, write
directly into KV:

```
wrangler kv key put "offer:<ISO-8601 date>:<random suffix>" \
  '{"item":"...","name":"...","email":"","offerAmount":"","message":"...","date":"...","source":"Geekzone PM"}' \
  --namespace-id 759478d5f609460f8e75759c17c57954 --remote
```

## Legacy Netlify site

The original Netlify site ([nzmovingsale.netlify.app](https://nzmovingsale.netlify.app))
is still linked to this same repo and *could* resume auto-deploying once its
credit allowance resets, since `netlify.toml` now points its publish
directory at `public/` too. If that happens: the public offer form will
gracefully fall back to a `mailto:` link (since `/api/submit-offer` doesn't
exist on Netlify), and `admin.html` will just fail to load data (its
`/api/offers` call 404s there) rather than break outright. It is not being
actively maintained as a second host — `move.pi.co.nz` is canonical.
