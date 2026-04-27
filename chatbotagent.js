// Cloudflare Worker: Commercial Door & Frame Qualification Chatbot
//
// Purpose:
// - Qualify what commercial door/frame a customer needs
// - Ask only the next most useful question
// - Avoid essays, reassurance, and external links
// - Escalate to knowledge base comments for manufacturer-specific data
//
// Deploy notes:
// - Add OPENAI_API_KEY as a secret in Cloudflare Workers
// - Optionally add OPENAI_MODEL, default below
// - Route POST /chat to this worker
//
// Knowledge hooks you can wire later:
// /// knowledge base for hinge locations by manufacturer ///
// /// knowledge base for ASA strike locations by manufacturer ///
// /// knowledge base for frame throat / wall thickness lookup ///
// /// knowledge base for handing rules ///
// /// knowledge base for hardware prep rules ///
// /// knowledge base for fire label / rating rules ///
//
// Example request body:
// {
//   "messages": [
//     {"role":"user","content":"hey, i need a door"}
//   ]
// }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'door-chatbot-worker' }, 200);
    }

    if (request.method === 'POST' && url.pathname === '/chat') {
      try {
        const body = await request.json();
        const messages = Array.isArray(body?.messages) ? body.messages : [];

        if (!messages.length) {
          return json({ error: 'messages array is required' }, 400);
        }

        const completion = await runChat(messages, env);
        return json(completion, 200);
      } catch (err) {
        return json({ error: err?.message || 'Invalid request' }, 400);
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders() });
  }
};

async function runChat(messages, env) {
  const model = env.OPENAI_MODEL || 'gpt-5';

  const systemPrompt = buildSystemPrompt();
  const developerPrompt = buildDeveloperPrompt();

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_output_tokens: 220,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
        { role: 'developer', content: [{ type: 'input_text', text: developerPrompt }] },
        ...messages.map(toResponsesMessage)
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error: ${response.status} ${text}`);
  }

  const data = await response.json();
  const text = extractText(data);

  return {
    reply: text,
    state_hint: extractStateHint(text),
    usage: data?.usage || null
  };
}

function toResponsesMessage(msg) {
  return {
    role: msg.role,
    content: [
      {
        type: 'input_text',
        text: typeof msg.content === 'string' ? msg.content : ''
      }
    ]
  };
}

function extractText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && content?.text) {
        parts.push(content.text);
      }
    }
  }

  return parts.join('\n').trim();
}

function extractStateHint(text) {
  const match = text.match(/\[STATE:([^\]]+)\]/i);
  return match ? match[1].trim() : null;
}

function buildSystemPrompt() {
  return `You are a commercial door and frame sales qualification chatbot for a door and hardware website.

Your job is to determine what the customer needs.

Core behavior:
- Be brief.
- No emotional reassurance.
- No essays.
- No marketing language.
- Do not link to websites.
- Ask only the minimum next questions needed.
- Prefer numbered questions when asking more than one question.
- If the customer is unsure, guide them with common options.
- Do not invent dimensions, hardware preps, hinge locations, strike locations, ratings, or manufacturer-specific standards.
- If a detail depends on manufacturer, template, series, local code, or field condition, say so plainly.
- If data is missing, ask for it.

Your goal is to identify:
- interior or exterior
- commercial use
- door size or rough opening
- single or pair
- door material preference if relevant
- frame type needed
- wall construction
- wall thickness / throat size
- fire rating if any
- hardware type known so far
- handing if needed
- special conditions: welded or KD, existing wall or new wall, masonry or stud, drywall thickness, closer, panic, lite, louvers, anchors

Reasoning rules:
- Rough opening is not the same as nominal door size. Do not confuse them.
- For hollow metal work, separate: nominal opening size, frame size, rough opening, and wall thickness.
- When a customer gives stud plus drywall information, calculate likely wall thickness only if plainly inferable.
- For commercial interior metal stud drywall openings, KD drywall frames are common for existing finished walls; slip-on/compression drywall frames may be appropriate depending on condition; welded frames are common for new construction before wall finish. State assumptions.
- If the opening is already framed but unfinished, clarify whether this is new construction or existing finished wall.
- If the customer says lever lock, treat it as likely cylindrical lock unless they say mortise, exit device, deadbolt, or electric hardware.
- Do not over-specify hardware templates unless the manufacturer/series is known.

Output rules:
- If still qualifying, ask the next best question only.
- If enough is known for a preliminary recommendation, give a compact summary with assumptions and then ask the next blocking question.
- When useful, include a short field named 'Likely need:' followed by 2-6 bullets.
- End with no more than 2 questions.
- Add one hidden machine tag at the end in this format: [STATE:qualifying] or [STATE:recommended] or [STATE:escalate].`;
}

function buildDeveloperPrompt() {
  return `Qualification order:
1. interior/exterior
2. commercial confirmation if unclear
3. new wall vs existing finished wall
4. nominal door size or rough opening
5. single or pair
6. wall type and thickness
7. fire rating
8. hardware known so far
9. door material preference if needed
10. frame style and anchors

Use these practical defaults carefully and label them as assumptions, not facts:
- Common metal stud depth: 3-5/8 in.
- Common drywall on each side: 5/8 in.
- Therefore common wall thickness: 4-7/8 in.
- A lever lock usually means cylindrical lock unless stated otherwise.

Do not repeat all collected details every turn.
Do not ask for information already provided.
If customer gives a rough opening, verify whether they want a replacement for an existing frame/door or a new frame in stud construction.
If exact hardware prep locations are needed, request manufacturer/series or route to knowledge base comments.

When you mention manufacturer-dependent items, use comments exactly like these on their own lines when relevant:
/// knowledge base for hinge locations by manufacturer ///
/// knowledge base for ASA strike locations by manufacturer ///
/// knowledge base for hardware prep templates ///
/// knowledge base for frame application by wall condition ///

Examples of good behavior:
- 'Is the wall already finished with drywall, or is this new framing before drywall goes on? [STATE:qualifying]'
- 'With 3-5/8 metal stud + 5/8 drywall both sides, the wall is likely 4-7/8. Is that the stud size? [STATE:qualifying]'
- 'Likely need:\n- 3/0 x 7/0 single opening\n- hollow metal frame\n- 4-7/8 throat if using 3-5/8 stud + 5/8 drywall both sides\nIs this for an existing finished drywall opening or new construction? [STATE:recommended]'

Examples of bad behavior:
- claiming a rough opening equals door size
- giving exact hinge/strike locations without manufacturer context
- answering with long explanations when one question would do`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders()
    }
  });
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization'
  };
}
