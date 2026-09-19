// A stand-in for api.deepgram.com used by tests. It records every request (including the body
// length) and answers with a configurable reply, typically one of the REAL captured responses in
// tests/fixtures/deepgram/. Tests using it verify OUR handling, not the live service.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "deepgram");
export const fixtureResponse = (name) => JSON.parse(readFileSync(path.join(fixtureDir, `${name}.json`), "utf8"));

export const json = (status, body) => (_req, res) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
export const delayed = (ms, reply) => (req, res) => setTimeout(() => reply(req, res), ms);
/** Replies from a list, one per request (the last repeats). */
export const sequence = (...replies) => {
  let i = 0;
  return (req, res) => replies[Math.min(i++, replies.length - 1)](req, res);
};

export async function startDeepgramStub(reply = json(200, fixtureResponse("aba"))) {
  const requests = [];
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    let bytes = 0;
    const head = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (head.length < 1) head.push(chunk.subarray(0, 8));
    }
    const record = { method: req.method, url: new URL(req.url, "http://stub"), headers: req.headers, bytes, head: head[0] ?? Buffer.alloc(0) };
    requests.push(record);
    await reply(record, res);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    setReply: (next) => { reply = next; },
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(resolve); }),
  };
}
