import { createServer, createConnection, type Socket } from "node:net";

/** Owned loopback pass-through; faults affect real transport bytes, never asset HTTP. */
export async function createTransportProxy(targetPort: number): Promise<{
  port: number;
  interrupt(): number;
  close(): Promise<void>;
}> {
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new Error("Invalid transport target port");
  }
  const pairs = new Map<Socket, Socket>();
  const server = createServer((incoming) => {
    const outgoing = createConnection({ host: "127.0.0.1", port: targetPort });
    pairs.set(incoming, outgoing);
    const dispose = () => {
      pairs.delete(incoming);
      incoming.destroy();
      outgoing.destroy();
    };
    incoming.on("error", dispose).on("close", dispose);
    outgoing.on("error", dispose).on("close", dispose);
    incoming.pipe(outgoing).pipe(incoming);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No transport proxy port");
  let closing: Promise<void> | undefined;
  const interrupt = () => {
    const count = pairs.size;
    for (const [incoming, outgoing] of pairs) {
      incoming.destroy();
      outgoing.destroy();
    }
    pairs.clear();
    return count;
  };
  return {
    port: address.port,
    interrupt,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        interrupt();
      });
      return closing;
    },
  };
}
