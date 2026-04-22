---
name: frontend-preview
description: Build a frontend page/component and save it as a live preview the user can open in their browser. Use when the user asks for HTML/CSS/JS, a landing page, a UI mock, a component — anything they might want to SEE rendered rather than just read as code.
---

When the user asks to build something visual (landing, card, dashboard mock, component, etc.):

## Prerequisites

- `PREVIEW_ENABLED=1` and `PREVIEW_HOST=<ip-or-domain>` should be set in `.env`. `PREVIEW_PORT` defaults to 8080.
- If `PREVIEW_HOST` is not set, fall back to just reporting the local path — tell the user their `PREVIEW_HOST` is missing.
- If the `frontend-design` plugin/skill is available, use it for design thinking (pick a bold aesthetic, execute with intentionality). If not, still produce polished, opinionated design — avoid generic "AI slop".

## Flow

1. **Design decision.** Pick a clear aesthetic direction (brutalist, editorial, refined minimal, playful, etc.) — match it to the user's domain/intent.
2. **Build.** Produce a **single self-contained `index.html`** with inline CSS/JS. No external asset dependencies unless using CDN fonts/libs — keep everything working from a static file.
3. **Slug.** Generate a short kebab-case slug from the user's request, e.g. `landing-ai-bot`. Prefix with a yyyymmdd-hhmm timestamp: `20260422-1745-landing-ai-bot`.
4. **Write** to `workspace/previews/<slug>/index.html` using the Write tool. Create nested asset files (`styles.css`, `script.js`, images) in the same folder if genuinely needed — but prefer inline.
5. **Reply** with:
   - 1-2 sentences explaining the design choices you made
   - The preview URL: `http://<PREVIEW_HOST>:<PREVIEW_PORT>/<slug>/`
   - A local path line: `Local: workspace/previews/<slug>/`
   - An optional short list of "next iterations" (e.g. "swap the hero headline", "add dark mode") so the user can respond with a tweak

## Tweaks / re-runs

If the user says "change X" in the same conversation, EDIT the existing file in the slug folder rather than creating a new one. Keep the same URL stable. Only create a new slug for a clearly different request.

## Example reply

> Went brutalist — heavy black borders, monospace type, no images. Hero is a big claim with a single CTA.
>
> Preview: http://192.0.2.1:8080/20260422-1745-landing-ai-bot/
> Local: workspace/previews/20260422-1745-landing-ai-bot/
>
> Want me to tone down the black? Add a second section? Swap to serif?

Match the user's language.
