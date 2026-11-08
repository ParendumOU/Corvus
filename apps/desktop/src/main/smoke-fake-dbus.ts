/**
 * A D-Bus bus of its own on a Unix socket, for tests and smokes on a computer without one (Docker):
 * it signs the client in, answers its calls and sends it signals, so the real client code is used.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MESSAGE, decodeMessage, encodeMessage, type DBusMessage, type OutgoingMessage } from "./dbus";

export interface FakeBus {
  /** The bus address to hand the client (`unix:path=...`). */
  address: string;
  received: DBusMessage[];
  emit(m: Omit<OutgoingMessage, "type">): void;
  connected(): boolean;
  close(): void;
}

/** Answers the client's calls with `answer` (Hello is answered already). */
export async function fakeBus(answer: (m: DBusMessage) => Pick<OutgoingMessage, "signature" | "body"> | undefined = () => undefined): Promise<FakeBus> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-dbus-"));
  const socketPath = path.join(dir, "bus");
  const received: DBusMessage[] = [];
  let client: net.Socket | null = null;
  let serial = 100;
  const server = net.createServer((socket) => {
    client = socket;
    let buf = Buffer.alloc(0);
    let binary = false;
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (!binary) {
        if (buf[0] === 0) buf = buf.subarray(1);
        const end = buf.indexOf("\r\n");
        if (end < 0) return;
        const line = buf.subarray(0, end).toString("latin1");
        buf = buf.subarray(end + 2);
        if (line.startsWith("AUTH EXTERNAL ")) socket.write("OK 0123456789abcdef0123456789abcdef\r\n");
        else if (line === "BEGIN") binary = true;
      }
      for (let d = decodeMessage(buf); d; d = decodeMessage(buf)) {
        buf = buf.subarray(d.size);
        received.push(d.message);
        const reply = d.message.member === "Hello" ? { signature: "s", body: [":1.42"] } : answer(d.message);
        socket.write(encodeMessage({ type: MESSAGE.reply, replySerial: d.message.serial, destination: ":1.42", ...reply }, ++serial));
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    address: `unix:path=${socketPath}`,
    received,
    emit: (m) => client?.write(encodeMessage({ ...m, type: MESSAGE.signal, sender: ":1.5" }, ++serial)),
    connected: () => client !== null && !client.destroyed && !client.readableEnded,
    close: () => {
      client?.destroy();
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The signal rules the client asked the bus for (AddMatch). */
export const matchRules = (bus: FakeBus): string[] => bus.received.filter((m) => m.member === "AddMatch").map((m) => String(m.body[0]));
