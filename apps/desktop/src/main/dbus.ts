/**
 * A small D-Bus client with no native module and no dependency: enough to call a few methods and
 * listen to signals on the session and system buses (Linux, see computer-lock.ts). It writes
 * little-endian messages and reads both byte orders; it never passes file descriptors.
 */
import net from "node:net";

export const MESSAGE = { call: 1, reply: 2, error: 3, signal: 4 } as const;

/** A variant's value with its type. */
export interface Variant {
  signature: string;
  value: unknown;
}

export interface DBusMessage {
  type: number;
  flags: number;
  serial: number;
  path?: string;
  interface?: string;
  member?: string;
  errorName?: string;
  replySerial?: number;
  destination?: string;
  sender?: string;
  signature?: string;
  /** Values in the order of the signature: arrays as arrays, structs and dict entries as arrays of their fields. */
  body: unknown[];
}

export type OutgoingMessage = Omit<DBusMessage, "serial" | "flags" | "body"> & { flags?: number; body?: unknown[] };

const ALIGN: Record<string, number> = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, s: 4, o: 4, g: 1, a: 4, "(": 8, "{": 8, v: 1, h: 4 };
/** Larger than anything Corvus listens to; a bigger message ends the connection. */
const MAX_MESSAGE = 8 * 1024 * 1024;
/** Variants and containers nested deeper than this are refused (the spec allows 64). */
const MAX_DEPTH = 64;

/** Where the single complete type starting at `i` in `sig` ends. */
function typeEnd(sig: string, i: number): number {
  const c = sig[i];
  if (c === "a") return typeEnd(sig, i + 1);
  if (c === "(" || c === "{") {
    const close = c === "(" ? ")" : "}";
    let j = i + 1;
    while (sig[j] !== close) {
      if (j >= sig.length) throw new Error("D-Bus: unbalanced signature");
      j = typeEnd(sig, j);
    }
    return j + 1;
  }
  if (c === undefined || !(c in ALIGN)) throw new Error(`D-Bus: unknown type ${c ?? "(end)"}`);
  return i + 1;
}

/** "sa{sv}as" -> ["s", "a{sv}", "as"]. */
export function splitSignature(sig: string): string[] {
  const types: string[] = [];
  for (let i = 0; i < sig.length; ) {
    const end = typeEnd(sig, i);
    types.push(sig.slice(i, end));
    i = end;
  }
  return types;
}

const alignment = (type: string): number => ALIGN[type[0] ?? ""] ?? 1;

class Writer {
  buf = Buffer.alloc(256);
  len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n));
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }

  align(n: number): void {
    const pad = (n - (this.len % n)) % n;
    this.ensure(pad);
    this.buf.fill(0, this.len, this.len + pad);
    this.len += pad;
  }

  private fixed(size: number, write: (at: number) => void): void {
    this.align(size);
    this.ensure(size);
    write(this.len);
    this.len += size;
  }

  private text(bytes: Buffer, lengthSize: 1 | 4): void {
    if (lengthSize === 1) this.fixed(1, (at) => this.buf.writeUInt8(bytes.length, at));
    else this.fixed(4, (at) => this.buf.writeUInt32LE(bytes.length, at));
    this.ensure(bytes.length + 1);
    bytes.copy(this.buf, this.len);
    this.buf[this.len + bytes.length] = 0;
    this.len += bytes.length + 1;
  }

  value(type: string, v: unknown): void {
    switch (type[0]) {
      case "y":
        return this.fixed(1, (at) => this.buf.writeUInt8(Number(v), at));
      case "b":
        return this.fixed(4, (at) => this.buf.writeUInt32LE(v ? 1 : 0, at));
      case "n":
        return this.fixed(2, (at) => this.buf.writeInt16LE(Number(v), at));
      case "q":
        return this.fixed(2, (at) => this.buf.writeUInt16LE(Number(v), at));
      case "i":
        return this.fixed(4, (at) => this.buf.writeInt32LE(Number(v), at));
      case "u":
      case "h":
        return this.fixed(4, (at) => this.buf.writeUInt32LE(Number(v), at));
      case "x":
        return this.fixed(8, (at) => this.buf.writeBigInt64LE(BigInt(v as number), at));
      case "t":
        return this.fixed(8, (at) => this.buf.writeBigUInt64LE(BigInt(v as number), at));
      case "d":
        return this.fixed(8, (at) => this.buf.writeDoubleLE(Number(v), at));
      case "s":
      case "o":
        return this.text(Buffer.from(String(v), "utf8"), 4);
      case "g":
        return this.text(Buffer.from(String(v), "ascii"), 1);
      case "v": {
        const { signature, value } = v as Variant;
        this.value("g", signature);
        return this.value(signature, value);
      }
      case "a": {
        const element = type.slice(1);
        this.fixed(4, () => undefined);
        const lengthAt = this.len - 4;
        this.align(alignment(element));
        const start = this.len;
        for (const item of v as unknown[]) this.value(element, item);
        this.buf.writeUInt32LE(this.len - start, lengthAt);
        return;
      }
      case "(":
      case "{": {
        this.align(8);
        const items = v as unknown[];
        splitSignature(type.slice(1, -1)).forEach((field, k) => this.value(field, items[k]));
        return;
      }
      default:
        throw new Error(`D-Bus: cannot write type ${type}`);
    }
  }

  bytes(): Buffer {
    return this.buf.subarray(0, this.len);
  }
}

class Reader {
  constructor(
    private readonly buf: Buffer,
    private readonly le: boolean,
    /** Alignment counts from here (the message's start, also for its body: that starts 8-aligned). */
    public pos: number,
  ) {}

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error("D-Bus: message ends early");
  }

  private align(n: number): void {
    this.pos += (n - (this.pos % n)) % n;
  }

  private fixed<T>(size: number, read: (at: number) => T): T {
    this.align(size);
    this.need(size);
    const v = read(this.pos);
    this.pos += size;
    return v;
  }

  private u32(): number {
    return this.fixed(4, (at) => (this.le ? this.buf.readUInt32LE(at) : this.buf.readUInt32BE(at)));
  }

  private text(length: number, encoding: "utf8" | "ascii"): string {
    this.need(length + 1);
    const s = this.buf.toString(encoding, this.pos, this.pos + length);
    this.pos += length + 1;
    return s;
  }

  value(type: string, depth = 0): unknown {
    if (depth > MAX_DEPTH) throw new Error("D-Bus: nested too deep");
    const { buf, le } = this;
    switch (type[0]) {
      case "y":
        return this.fixed(1, (at) => buf.readUInt8(at));
      case "b":
        return this.u32() !== 0;
      case "n":
        return this.fixed(2, (at) => (le ? buf.readInt16LE(at) : buf.readInt16BE(at)));
      case "q":
        return this.fixed(2, (at) => (le ? buf.readUInt16LE(at) : buf.readUInt16BE(at)));
      case "i":
        return this.fixed(4, (at) => (le ? buf.readInt32LE(at) : buf.readInt32BE(at)));
      case "u":
      case "h":
        return this.u32();
      case "x":
        return this.fixed(8, (at) => Number(le ? buf.readBigInt64LE(at) : buf.readBigInt64BE(at)));
      case "t":
        return this.fixed(8, (at) => Number(le ? buf.readBigUInt64LE(at) : buf.readBigUInt64BE(at)));
      case "d":
        return this.fixed(8, (at) => (le ? buf.readDoubleLE(at) : buf.readDoubleBE(at)));
      case "s":
      case "o":
        return this.text(this.u32(), "utf8");
      case "g":
        return this.text(this.fixed(1, (at) => buf.readUInt8(at)), "ascii");
      case "v": {
        const signature = this.value("g") as string;
        if (splitSignature(signature).length !== 1) throw new Error("D-Bus: a variant holds one type");
        return { signature, value: this.value(signature, depth + 1) } satisfies Variant;
      }
      case "a": {
        const length = this.u32();
        const element = type.slice(1);
        this.align(alignment(element));
        this.need(length);
        const end = this.pos + length;
        const items: unknown[] = [];
        while (this.pos < end) items.push(this.value(element, depth + 1));
        if (this.pos !== end) throw new Error("D-Bus: array length does not match");
        return items;
      }
      case "(":
      case "{":
        this.align(8);
        return splitSignature(type.slice(1, -1)).map((field) => this.value(field, depth + 1));
      default:
        throw new Error(`D-Bus: cannot read type ${type}`);
    }
  }
}

const FIELDS = { path: 1, interface: 2, member: 3, errorName: 4, replySerial: 5, destination: 6, sender: 7, signature: 8 } as const;
const FIELD_TYPES: Record<keyof typeof FIELDS, string> = { path: "o", interface: "s", member: "s", errorName: "s", replySerial: "u", destination: "s", sender: "s", signature: "g" };

const align8 = (n: number): number => (n + 7) & ~7;

export function encodeMessage(m: OutgoingMessage, serial: number): Buffer {
  const body = new Writer();
  const types = m.signature ? splitSignature(m.signature) : [];
  types.forEach((type, k) => body.value(type, m.body?.[k]));
  const fields: Array<[number, Variant]> = [];
  for (const [name, code] of Object.entries(FIELDS) as Array<[keyof typeof FIELDS, number]>) {
    const value = m[name];
    if (value !== undefined && value !== "") fields.push([code, { signature: FIELD_TYPES[name], value }]);
  }
  const head = new Writer();
  head.value("y", 0x6c);
  head.value("y", m.type);
  head.value("y", m.flags ?? 0);
  head.value("y", 1);
  head.value("u", body.len);
  head.value("u", serial);
  head.value("a(yv)", fields);
  head.align(8);
  return Buffer.concat([head.bytes(), body.bytes()]);
}

/** The first whole message in `buf` and its size; null while more bytes are needed. Throws on a malformed one. */
export function decodeMessage(buf: Buffer): { message: DBusMessage; size: number } | null {
  if (buf.length < 16) return null;
  const le = buf[0] === 0x6c;
  if (!le && buf[0] !== 0x42) throw new Error("D-Bus: unknown byte order");
  if (buf[3] !== 1) throw new Error("D-Bus: unknown protocol version");
  const u32 = (at: number): number => (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
  const bodyLength = u32(4);
  const fieldsLength = u32(12);
  if (bodyLength > MAX_MESSAGE || fieldsLength > MAX_MESSAGE) throw new Error("D-Bus: message too large");
  const bodyStart = align8(16 + fieldsLength);
  const size = bodyStart + bodyLength;
  if (size > MAX_MESSAGE) throw new Error("D-Bus: message too large");
  if (buf.length < size) return null;
  const whole = buf.subarray(0, size);
  const message: DBusMessage = { type: buf[1] ?? 0, flags: buf[2] ?? 0, serial: u32(8), body: [] };
  const fields = new Reader(whole.subarray(0, 16 + fieldsLength), le, 12).value("a(yv)") as Array<[number, Variant]>;
  for (const [code, { value }] of fields) {
    const name = (Object.keys(FIELDS) as Array<keyof typeof FIELDS>).find((k) => FIELDS[k] === code);
    if (name === "replySerial") message.replySerial = value as number;
    else if (name) message[name] = value as string;
  }
  if (message.signature) {
    const reader = new Reader(whole, le, bodyStart);
    message.body = splitSignature(message.signature).map((type) => reader.value(type));
    if (reader.pos !== size) throw new Error("D-Bus: body length does not match");
  }
  return { message, size };
}

/** The socket of a D-Bus address (its first unix: entry): a path, or an abstract name (leading NUL). */
export function socketPathOf(address: string): string | null {
  for (const entry of address.split(";")) {
    const colon = entry.indexOf(":");
    if (entry.slice(0, colon) !== "unix") continue;
    const params = new Map<string, string>();
    for (const pair of entry.slice(colon + 1).split(",")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      try {
        params.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
      } catch {
        return null;
      }
    }
    const socketPath = params.get("path");
    if (socketPath) return socketPath;
    const abstract = params.get("abstract");
    if (abstract) return `\0${abstract}`;
  }
  return null;
}

export function sessionBusAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.DBUS_SESSION_BUS_ADDRESS) return env.DBUS_SESSION_BUS_ADDRESS;
  return env.XDG_RUNTIME_DIR ? `unix:path=${env.XDG_RUNTIME_DIR}/bus` : null;
}

export function systemBusAddress(env: NodeJS.ProcessEnv = process.env): string {
  return env.DBUS_SYSTEM_BUS_ADDRESS || "unix:path=/var/run/dbus/system_bus_socket";
}

/** Connects and signs in as this process's user (SASL EXTERNAL). */
function authenticate(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let reply = "";
    const onData = (chunk: Buffer): void => {
      reply += chunk.toString("latin1");
      if (!reply.includes("\r\n")) return;
      if (!reply.startsWith("OK ")) return done(new Error(`D-Bus: sign-in refused (${reply.trim().slice(0, 80)})`));
      socket.write("BEGIN\r\n");
      done(null);
    };
    const onError = (err: Error): void => done(err);
    const onClose = (): void => done(new Error("D-Bus: the bus closed the connection"));
    const timer = setTimeout(() => done(new Error("D-Bus: no answer from the bus")), timeoutMs);
    const done = (err: Error | null): void => {
      clearTimeout(timer);
      socket.off("data", onData).off("error", onError).off("close", onClose);
      if (err) {
        socket.destroy();
        reject(err);
      } else resolve(socket);
    };
    socket.once("connect", () => {
      const uid = Buffer.from(String(process.getuid?.() ?? 0)).toString("hex");
      socket.write(Buffer.concat([Buffer.from([0]), Buffer.from(`AUTH EXTERNAL ${uid}\r\n`)]));
    });
    socket.on("data", onData).on("error", onError).on("close", onClose);
  });
}

const BUS = { destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus" };

export class DBusConnection {
  private serial = 0;
  private buffered: Buffer = Buffer.alloc(0);
  private closed = false;
  private readonly calls = new Map<number, { resolve: (body: unknown[]) => void; reject: (err: Error) => void }>();
  private readonly listeners = new Set<(m: DBusMessage) => void>();
  /** The unique name the bus gave this connection. */
  name = "";

  private constructor(private readonly socket: net.Socket) {
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("error", (err) => this.end(err));
    socket.on("close", () => this.end(new Error("D-Bus: connection closed")));
  }

  static async connect(address: string, timeoutMs = 5000): Promise<DBusConnection> {
    const socketPath = socketPathOf(address);
    if (!socketPath) throw new Error(`D-Bus: unsupported address ${address}`);
    const bus = new DBusConnection(await authenticate(socketPath, timeoutMs));
    try {
      bus.name = String((await bus.call({ ...BUS, member: "Hello" }, timeoutMs))[0]);
    } catch (err) {
      bus.close();
      throw err;
    }
    return bus;
  }

  call(m: Omit<OutgoingMessage, "type">, timeoutMs = 10_000): Promise<unknown[]> {
    if (this.closed) return Promise.reject(new Error("D-Bus: connection closed"));
    const serial = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(serial);
        reject(new Error(`D-Bus: ${m.member ?? "call"} got no answer`));
      }, timeoutMs);
      this.calls.set(serial, {
        resolve: (body) => {
          clearTimeout(timer);
          resolve(body);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.socket.write(encodeMessage({ ...m, type: MESSAGE.call }, serial));
    });
  }

  /** Signals matching `rule` (D-Bus match rule syntax) reach the onSignal listeners from now on. */
  async addMatch(rule: string): Promise<void> {
    await this.call({ ...BUS, member: "AddMatch", signature: "s", body: [rule] });
  }

  onSignal(listener: (m: DBusMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.end(new Error("D-Bus: connection closed"));
    this.socket.destroy();
  }

  private receive(chunk: Buffer): void {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    try {
      for (let decoded = decodeMessage(this.buffered); decoded; decoded = decodeMessage(this.buffered)) {
        this.buffered = this.buffered.subarray(decoded.size);
        this.dispatch(decoded.message);
      }
    } catch (err) {
      this.end(err as Error);
      this.socket.destroy();
    }
  }

  private dispatch(m: DBusMessage): void {
    if ((m.type === MESSAGE.reply || m.type === MESSAGE.error) && m.replySerial !== undefined) {
      const call = this.calls.get(m.replySerial);
      this.calls.delete(m.replySerial);
      if (m.type === MESSAGE.reply) call?.resolve(m.body);
      else call?.reject(new Error(`${m.errorName ?? "D-Bus error"}${typeof m.body[0] === "string" ? `: ${m.body[0]}` : ""}`));
      return;
    }
    // Method calls to this connection get no answer: it serves nothing.
    if (m.type !== MESSAGE.signal) return;
    for (const listener of this.listeners) {
      try {
        listener(m);
      } catch (err) {
        console.warn("[corvus] D-Bus signal listener failed:", (err as Error).message);
      }
    }
  }

  private end(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const call of this.calls.values()) call.reject(err);
    this.calls.clear();
    this.listeners.clear();
  }
}
