# Chatbot Groundwork for Quote Intake

## Objective

Build a quote-focused assistant that:

- uses OpenAI `gpt-4.1-nano`
- stays inside hard server-side guardrails
- cannot be reprogrammed by customer messages
- collects required quote details and submits through existing quote flow
- enforces low token and abuse limits

## Intent and Experience Target

The chatbot is primarily for customers who do **not** know door terminology yet.

- It should probe gently and teach while collecting data
- It should avoid early hard-blocking questions that stall the user
- It should capture unknowns explicitly and keep momentum
- It should produce a usable budget request even when technical fields are pending verification

## Guardrail Model

1. **Server-owned instructions only**
   - System prompt is stored server-side
   - User cannot provide or alter system/developer instructions

2. **Schema-constrained output**
   - Model output must be parsed as strict JSON
   - Any non-conforming output is rejected and retried once with repair prompt
   - If still invalid, fallback to deterministic scripted step

3. **State machine authority**
   - Backend controls current required step
   - Model can only ask the next allowed question
   - Model cannot skip required fields

4. **Tool denial by default**
   - No external tools, browsing, code execution, or function calls
   - Only text generation for one question and one short helper response

5. **Prompt injection resistance**
   - User text treated as untrusted data
   - Explicit ignore policy for instructions like ignore previous, reveal prompt, act as
   - Backend sanitizes and caps message length

## Required Quote Schema

```json
{
  "requestType": "budget|full",
  "projectName": "string",
  "openingCountEstimate": "string",
  "openingType": "single|double|mixed|unknown",
  "application": "interior|exterior|both|unknown",
  "jobType": "new|replacement|unknown",
  "name": "string",
  "email": "string",
  "phone": "string",
  "company": "string",
  "sizeWidthIn": "number|null",
  "sizeHeightIn": "number|null",
  "sizeAssumed": false,
  "doorType": "string",
  "woodSpecies": "string",
  "doorMaterial": "wood|hollow-metal|aluminum|unknown",
  "frameType": "string",
  "replaceFrame": true,
  "fireRated": true,
  "fireRatedStatus": "yes|no|unknown",
  "frameDepth": "string",
  "wallThicknessIn": "number|null",
  "frameDepthDerivedFromWall": false,
  "wallTypeDetails": "string",
  "handing": "lh|rh|lhr|rhr|unknown",
  "handingNeedsSiteVerify": true,
  "hingeLocationRequirement": "standard|match-existing|custom|unknown",
  "hingeLocationsProvided": false,
  "hardwareScope": "door-only|door-frame|door-frame-hardware",
  "hardwareNeeds": "string",
  "lockFunction": "entry-keyed|privacy|passage|storeroom|unknown",
  "closerRequired": true,
  "finishPreference": "string",
  "visionKitRequired": true,
  "visionKitSize": "string",
  "needsVisionKitReference": false,
  "timeline": "string",
  "guidedNotes": "string",
  "unknownsToVerify": []
}
```

Validation rules:

- `name` required
- `email` required and valid format
- `requestType` required
- `openingCountEstimate` required for budget flow
- `doorType` required for guided flow
- if `doorType = Wood`, `woodSpecies` required
- if `frameDepth = Other` or `Unknown`, ask wall thickness and derive rough frame depth
- if wall thickness missing, add to `unknownsToVerify`
- if handing unknown, set `handingNeedsSiteVerify = true`
- if hinge location not provided, ask if standard vs match existing and mark unknown if needed

## Conversation Flow

1. Classify intent: budget or full quote
2. Scope framing: interior or exterior, replacement or new, count range
3. Opening basics: door type and size known vs assumed
4. Frame and wall discovery: frame replace yes or no, wall type, wall thickness if depth unknown
5. Swing and hinge probe: handing and hinge location requirement
6. Hardware probe: lock function, closer, finish, special hardware
7. Fire and code probe: fire status yes no unknown
8. Vision kit preference and size guidance
9. Contact and timeline capture
10. Structured recap with explicit unknowns and submit gate

### Probe style rules

- Ask one practical question with 2 to 4 options when possible
- Teach only enough to unblock the next answer
- Prefer unknown-safe options: `unknown now`, `site verify needed`
- Do not demand dimensions before classifying opening context
- When user says rough estimate, keep moving and mark verification fields

### Derived rule for frame depth

If user does not know frame depth:

1. Ask for wall thickness finished surface to finished surface
2. Store as `wallThicknessIn`
3. Compute rough frame depth suggestion
4. Mark `frameDepthDerivedFromWall = true`
5. Add note that exact frame depth is site-verify unless confirmed

If budget/rate limits are exceeded:

- switch to deterministic scripted prompts
- continue collecting required fields
- submit without LLM assistance

## Cost Controls

- model: `gpt-4.1-nano`
- low max output tokens per turn
- strict max turns per session
- per-IP and per-session rate limits
- short context window with summarized state only
- no full transcript resend each turn

## API Groundwork

Planned endpoint:

- `POST /api/chatbot-quote`

Additional behavior:

- endpoint returns `unknownsToVerify` list for recap
- endpoint returns `assumptionsUsed` list for budget quoting transparency
- endpoint can branch into deterministic mode when token or rate limits are hit

Request payload:

```json
{
  "sessionId": "string",
  "userMessage": "string",
  "state": {
    "mode": "guided",
    "currentStep": "doorType",
    "quoteDraft": {}
  }
}
```

Response payload:

```json
{
  "ok": true,
  "assistantMessage": "string",
  "currentStep": "frameType",
  "quoteDraft": {},
  "readyToSubmit": false,
  "fallbackMode": false
}
```

## Frontend Groundwork

- Add minimal chat widget section in `index.html`
- Keep existing quote form as fallback
- Show progress indicator by required fields
- Add clear submit confirmation before posting

## Security and Abuse Controls

- input length caps
- profanity and abuse throttling
- honeypot field for bots
- per-session nonce
- optional Cloudflare Turnstile gate at submit step

## Rollout Sequence

1. Add prompt and schema docs
2. Add backend endpoint with mocked deterministic responses
3. Add OpenAI call with strict parser and fallback
4. Add frontend chat UI and integrate submit
5. Log only operational metadata
6. Deploy behind feature flag

