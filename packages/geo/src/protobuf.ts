// © Infinitum Corporation®. All rights reserved.
// Minimal protobuf codec for the v2ray GeoIPList and GeoSiteList messages.
// It reads the wire types those files use and skips fields this loader does not need.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error("varint out of range");
  }
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Uint8Array.from(bytes);
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function tag(field: number, wire: number): Uint8Array {
  return encodeVarint((field << 3) | wire);
}

export function fieldVarint(field: number, value: number): Uint8Array {
  return concatBytes([tag(field, 0), encodeVarint(value)]);
}

export function fieldBytes(field: number, data: Uint8Array): Uint8Array {
  return concatBytes([tag(field, 2), encodeVarint(data.length), data]);
}

export function fieldString(field: number, value: string): Uint8Array {
  return fieldBytes(field, textEncoder.encode(value));
}

export function decodeUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

interface Varint {
  value: bigint;
  next: number;
}

function readVarint(buf: Uint8Array, offset: number): Varint {
  let result = 0n;
  let shift = 0n;
  let index = offset;
  for (let count = 0; count < 10; count += 1) {
    if (index >= buf.length) throw new Error("truncated varint in geo dat");
    const byte = buf[index];
    index += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, next: index };
    shift += 7n;
  }
  throw new Error("oversized varint in geo dat");
}

function asNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is too large`);
  }
  return Number(value);
}

export type ProtoValue = Uint8Array | bigint;

export function forEachField(buf: Uint8Array, visit: (field: number, wire: number, value: ProtoValue) => void): void {
  let offset = 0;
  while (offset < buf.length) {
    const header = readVarint(buf, offset);
    offset = header.next;
    const tagNumber = asNumber(header.value, "field tag");
    const field = tagNumber >>> 3;
    const wire = tagNumber & 7;
    if (field === 0) throw new Error("invalid protobuf field number in geo dat");
    if (wire === 2) {
      const length = readVarint(buf, offset);
      const size = asNumber(length.value, "field length");
      const start = length.next;
      const end = start + size;
      if (end > buf.length) throw new Error("truncated length-delimited field in geo dat");
      visit(field, wire, buf.subarray(start, end));
      offset = end;
      continue;
    }
    if (wire === 0) {
      const body = readVarint(buf, offset);
      visit(field, wire, body.value);
      offset = body.next;
      continue;
    }
    if (wire === 1) {
      if (offset + 8 > buf.length) throw new Error("truncated 64-bit field in geo dat");
      offset += 8;
      continue;
    }
    if (wire === 5) {
      if (offset + 4 > buf.length) throw new Error("truncated 32-bit field in geo dat");
      offset += 4;
      continue;
    }
    throw new Error(`unsupported protobuf wire type ${wire} in geo dat`);
  }
}
