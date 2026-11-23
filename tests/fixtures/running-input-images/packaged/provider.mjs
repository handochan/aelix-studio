import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

export const model = 'gpt-6-luna';
export const providerId = 'openai-codex';
export const holdMessage = 'Hold the acceptance turn.';
export const caption = 'The user attached one or more images.';

export function digest(bytes) {
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Serve the minimal Responses SSE used by ACP's MockTransport fixture. */
export async function startProvider() {
  const requests = [];
  let release;
  let expectedPaths;
  let failed = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/responses') throw new Error('method');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      if (body.model !== model) throw new Error('model');
      const user = body.input.filter((message) => message.role === 'user');
      const latest = user.at(-1)?.content ?? [];
      const images = user
        .flatMap(({ content }) => content)
        .filter((part) => part.type === 'input_image')
        .map((part) => {
          const data = /^data:image\/(?:png|jpeg);base64,(.+)$/.exec(part.image_url);
          if (!data) throw new Error('image');
          return digest(Buffer.from(data[1], 'base64'));
        });
      const text = latest
        .filter((part) => part.type === 'input_text')
        .map((part) => part.text)
        .join('');
      const pathMarker = '\n[[AION_FILES]]\n';
      const references = text.includes(pathMarker) ? text.split(pathMarker)[1].trimEnd().split(/\r?\n/) : [];
      const pathCount = references.length;
      const pathRefsMatch =
        expectedPaths !== undefined &&
        expectedPaths.length === pathCount &&
        references.sort().every((reference, index) => reference === expectedPaths[index]);
      const held =
        text.includes(holdMessage) &&
        images.length === 0 &&
        !user
          .slice(0, -1)
          .some(({ content }) => content.some((part) => part.type === 'input_text' && part.text.includes(holdMessage)));
      requests.push({ held, images, captionAdded: text === caption, pathCount, pathRefsMatch });
      if (held)
        await new Promise((resolve) => {
          release = resolve;
        });

      const reply = { type: 'output_text', text: 'Acceptance reply.', annotations: [] };
      const item = { id: 'fixture-message', type: 'message', role: 'assistant', content: [reply], status: 'completed' };
      const events = [
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { ...reply, text: '' } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: reply.text },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: { status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1 } },
        },
      ];
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
    } catch {
      failed = true;
      response.writeHead(400);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + server.address().port + '/responses',
    requests,
    get holding() {
      return release !== undefined;
    },
    expectPaths(references) {
      expectedPaths = references?.slice().sort();
    },
    get failed() {
      return failed;
    },
    release: () => {
      release?.();
      release = undefined;
    },
    close: () => {
      release?.();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
