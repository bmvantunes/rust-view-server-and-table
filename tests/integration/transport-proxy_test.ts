import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import test from "node:test";
import { createTransportProxy } from "../../scripts/transport-proxy.ts";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
}
async function connect(port: number): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  await once(socket, "connect");
  return socket;
}
async function exchange(socket: Socket, bytes: Buffer) {
  const received = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(chunk); size += chunk.length;
      if (size >= bytes.length) { socket.off("data", onData); resolve(Buffer.concat(chunks)); }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
  socket.write(bytes);
  assert.deepEqual(await received, bytes);
}

test("transport interruption preserves bytes, assets and reconnect listener", { timeout: 10000 }, async () => {
  const backend = createServer(socket => socket.pipe(socket));
  const backendPort = await listen(backend);
  const assets = createHttpServer((_request, response) => response.end("worker asset"));
  const assetPort = await listen(assets);
  const proxy = await createTransportProxy(backendPort);
  const clients: Socket[] = [];
  try {
    const first = await connect(proxy.port); clients.push(first);
    await exchange(first, Buffer.from([0, 255, 128, 13, 10, 1]));
    const closed = once(first, "close");
    assert.equal(proxy.interrupt(), 1);
    await closed;
    assert.equal(proxy.interrupt(), 0);
    assert.equal(await (await fetch(`http://127.0.0.1:${assetPort}/worker.mjs`)).text(), "worker asset");
    const second = await connect(proxy.port); clients.push(second);
    await exchange(second, Buffer.alloc(256 * 1024, 173));
    const secondClosed = once(second, "close");
    await proxy.close();
    await secondClosed;
    await proxy.close();
  } finally {
    for (const socket of clients) socket.destroy();
    await proxy.close();
    await Promise.all([new Promise<void>(resolve => backend.close(() => resolve())), new Promise<void>(resolve => assets.close(() => resolve()))]);
  }
});

test("unavailable backend closes client and leaves no owned sockets", { timeout: 10000 }, async () => {
  const backend = createServer();
  const port = await listen(backend);
  await new Promise<void>(resolve => backend.close(() => resolve()));
  const proxy = await createTransportProxy(port);
  try {
    const client = createConnection({ host: "127.0.0.1", port: proxy.port });
    await once(client, "close");
    assert.equal(proxy.interrupt(), 0);
  } finally { await proxy.close(); }
});
