// © Infinitum Corporation®. All rights reserved.
// Minimal protobuf wire reader and writer for v2ray GeoIPList and GeoSiteList.
// Those messages are length-delimited fields and varints. No protobuf runtime.

export interface ProtoField {
  field: number;
  wire: number;
  value: number | Uint8Array;
}

export function readVarint(buf: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  while (offset < buf.length) {
    const byte = buf[offset];
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
    if (shift > 35) throw new Error("protobuf varint is too long");
  }
  throw new Error("protobuf varint is truncated");
}

export function readFields(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const key = readVarint(buf, offset);
    offset = key.offset;
    const field = key.value >>> 3;
    const wire = key.value & 7;
    if (field === 0) throw new Error("protobuf field number is missing");
    if (wire === 0) {
      const parsed = readVarint(buf, offset);
      offset = parsed.offset;
      fields.push({ field, wire, value: parsed.value });
      continue;
    }
    if (wire === 2) {
      const length = readVarint(buf, offset);
      offset = length.offset;
      const end = offset + length.value;
      if (length.value < 0 || end > buf.length) throw new Error("protobuf length-delimited field is truncated");
      fields.push({ field, wire, value: buf.subarray(offset, end) });
      offset = end;
      continue;
    }
    if (wire === 5) {
      if (offset + 4 > buf.length) throw new Error("protobuf fixed32 field is truncated");
      offset += 4;
      continue;
    }
    if (wire === 1) {
      if (offset + 8 > buf.length) throw new Error("protobuf fixed64 field is truncated");
      offset += 8;
      continue;
    }
    throw new Error(`protobuf wire type ${wire} is not used by v2ray geo lists`);
  }
  return fields;
}

export function bytesField(fields: ProtoField[], number: number): Uint8Array[] {
  return fields
    .filter((field) => field.field === number && field.wire === 2 && field.value instanceof Uint8Array)
    .map((field) => field.value as Uint8Array);
}

export function varintField(fields: ProtoField[], number: number): number | undefined {
  const found = fields.find((field) => field.field === number && field.wire === 0);
  return typeof found?.value === "number" ? found.value : undefined;
}

export function textField(fields: ProtoField[], number: number): string {
  const bytes = bytesField(fields, number)[0];
  if (!bytes) return "";
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function encodeVarint(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error("protobuf varint is out of range");
  const out: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  out.push(rest);
  return out;
}

export function encodeKey(field: number, wire: number): number[] {
  return encodeVarint((field << 3) | wire);
}

export function encodeBytesField(field: number, bytes: Uint8Array): number[] {
  return [...encodeKey(field, 2), ...encodeVarint(bytes.length), ...bytes];
}

export function encodeStringField(field: number, value: string): number[] {
  return encodeBytesField(field, new TextEncoder().encode(value));
}

export function encodeVarintField(field: number, value: number): number[] {
  return [...encodeKey(field, 0), ...encodeVarint(value)];
}

export function encodeMessageField(field: number, inner: number[]): number[] {
  return [...encodeKey(field, 2), ...encodeVarint(inner.length), ...inner];
}

export function packBytes(parts: number[][]): Uint8Array {
  return Uint8Array.from(parts.flat());
}
