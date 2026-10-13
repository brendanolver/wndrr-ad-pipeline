# Reference Library

A shared, visual bank of creative inspiration (`reference_library`). Each reference is a URL, the team's comment on why it is worth saving, BAU/SALE, and an optional product/category. Added-by and the date are stamped from the signed-in user.

## Previews
A card's picture comes from, in order:
1. the **cover image** a person uploaded (`reference_library_images`, kind `cover`)
2. the **automatic preview** fetched from the URL (kind `auto`)
3. YouTube's own thumbnail (client side, only while no stored copy exists yet)
4. the platform placeholder

Automatic previews (`src/lib/referencePreview.js`): YouTube thumbnail, TikTok oEmbed, otherwise the page's `og:image` / `twitter:image`. Instagram and TikTok often refuse this (login walls, bot checks), so a miss is normal: it is recorded as `preview_status = 'none'` and the card keeps its placeholder; a person can upload a cover or press "Try automatic preview again" on the edit form. The image is downloaded and stored (platform CDN links expire) after checking the bytes really are an image (5 MB cap); fetching only ever goes to public addresses (every connection and redirect hop is checked), with timeouts.

Saving never waits for or depends on a preview: the reference is saved first, the fetch runs in the background (`pending` -> `ok` / `none`), and the page refreshes the card when it lands. Existing references with no preview attempt yet are tried in the background, a few at a time, when the list is loaded (only the new preview columns/table are written). Set `REFERENCE_AUTO_PREVIEW=0` to switch automatic fetching off entirely (uploads keep working).

## Data
Additive migration only: `preview_status`, `preview_source`, `preview_checked_at`, `thumb_version` on `reference_library`, and `reference_library_images (reference_id, kind, ...)`. Existing rows, ids (and so the `library_reference_id` links from concepts), comments, classifications, categories, added-by and dates are never rewritten. The list endpoint never carries image bytes; thumbnails are served from `GET /api/reference-library/:id/thumb`.
