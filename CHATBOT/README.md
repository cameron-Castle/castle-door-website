# Chatbot Groundwork

This folder contains the foundation for a locked-down quote assistant using OpenAI `gpt-4.1-nano`.

## Purpose

- Collect required quote details in a controlled flow
- Prevent customer prompt injection from changing bot behavior
- Keep token usage low and predictable
- Hand off validated quote data to existing quote intake

## Files

- `chatbot-groundwork.md` — architecture, guardrails, schema, and rollout checklist
- `prompt.md` — base system prompt template for the quote assistant
- `../functions/api/chatbot-quote-preview.js` — preview-only backend endpoint
- `../chatbot-preview.html` — duplicate non-production UI for chatbot testing

## Notes

- Guardrails are enforced server-side first; prompt alone is not a security boundary
- The assistant should only gather quote data and route to submission
- If limits are hit, degrade to a deterministic non-LLM flow

## Preview Runbook (Non-Production)

This preview build does **not** modify the production quote page in `index.html`.

1. Open `chatbot-preview.html`
2. Use endpoint `POST /api/chatbot-quote-preview`
3. Enable preview by setting env var:
   - `CHATBOT_PREVIEW_ENABLED=true`
4. Optional OpenAI preview mode:
   - `CHATBOT_PREVIEW_USE_OPENAI=true`
   - `OPENAI_API_KEY=<key>`
   - `OPENAI_CHATBOT_MODEL=gpt-4.1-nano` (optional override)

If OpenAI preview mode is off or unavailable, endpoint falls back to deterministic extraction/questions.

## Production Runbook

Production chatbot route:

- `POST /api/chatbot-quote` in [`functions/api/chatbot-quote.js`](../functions/api/chatbot-quote.js)

Env vars:

- `CHATBOT_ENABLED=true` (set false to disable)
- `CHATBOT_USE_OPENAI=true` (set false for deterministic-only mode)
- `OPENAI_API_KEY=<key>`
- `OPENAI_CHATBOT_MODEL=gpt-4.1-nano` (optional override)

UI wiring:

- Chat assistant UI is now embedded in [`quote.html`](../quote.html)
- Final submission still posts to existing quote route: `POST /api/quote-request`
- Preview files remain available as backup: [`chatbot-preview.html`](../chatbot-preview.html), [`functions/api/chatbot-quote-preview.js`](../functions/api/chatbot-quote-preview.js)
