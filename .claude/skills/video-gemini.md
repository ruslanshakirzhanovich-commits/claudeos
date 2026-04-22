---
name: video-gemini
description: Analyze, summarize, or answer questions about a video file using Google's Gemini 2.0 Flash (which has native video understanding). Use when the user sends a video (via Telegram/WhatsApp the bot downloads it to a local path) or asks to analyze a video at a given path.
---

When the user asks to analyze, describe, summarize, or answer a question about a video:

## Prerequisites

- The env var `GEMINI_API_KEY` must be set. Get a free key at https://aistudio.google.com/apikey. If it's missing, tell the user to add `GEMINI_API_KEY=...` to `.env` and restart the bot.
- The video must be a local file path. Telegram/WhatsApp downloads land in `workspace/uploads/` — the bot's message already tells you the path.

## Flow

Use the Bash tool to run a one-off Node script per request. Keep it minimal — no new files. Paste the script into a single `node --input-type=module -e '...'` call.

The script does three steps:

1. **Upload** the file to the Gemini Files API:
   `POST https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}` with `X-Goog-Upload-Command: start, upload, finalize` and the file as body. Response includes `file.uri`.
2. **Poll** `GET https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${GEMINI_API_KEY}` every 2 s until `state == "ACTIVE"` (video processing takes a few seconds).
3. **Generate** with the file reference:
   `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}` with body
   ```json
   {
     "contents": [{
       "parts": [
         {"file_data": {"mime_type": "<video mime>", "file_uri": "<file.uri>"}},
         {"text": "<user's question, or 'describe this video in detail'>"}
       ]
     }]
   }
   ```
   Return `candidates[0].content.parts[0].text`.

Then **delete** the uploaded file via `DELETE https://generativelanguage.googleapis.com/v1beta/${file.name}?key=...` to clean up (Gemini keeps files 48h by default but we don't need them).

## Output

- Start with a 1-2 sentence summary of the video.
- If the user asked a specific question, answer it explicitly.
- Don't wrap the answer in code blocks unless quoting something literal.
- Match the language the user wrote in.

## Errors

- `403 / 400` during upload → likely bad API key or quota. Report it plainly.
- Poll timeout (>60 s) → video too long / processing stuck. Tell user and cancel.
- `generateContent` returns `finishReason: "SAFETY"` → content blocked by Gemini's safety filter. Tell the user that's what happened.

## Limits

- Free tier: 15 requests/min, 1M tokens/min, 1500 requests/day. More than enough for a personal bot.
- Gemini 2.0 Flash max video length: ~1 hour (token budget).
