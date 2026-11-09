// © Infinitum Corporation®. All rights reserved.
// Loader for unmodified v2fly geoip.dat (GeoIPList) and geosite.dat (GeoSiteList).

import { createHash } from "node:crypto";
import { concatBytes, decodeUtf8, fieldBytes, fieldString, fieldVarint, forEachField } from "./protobuf.js";

export interface CidrInput {
  ip: Uint8Array;
  prefix: number;
}

export interface GeoIpEntryInput {
  countryCode: string;
  cidrs: CidrInput[];
  reverseMatch?: boolean;
}

export interface GeoIpRecord {
  countryCode: string;
  cidrs: CidrInput[];
  reverseMatch: boolean;
}

export type DomainMatchType = "plain" | "regex" | "domain" | "full";

export interface DomainInput {
  type: DomainMatchType;
  value: string;
}

export interface GeoSiteEntryInput {
  category: string;
  domains: DomainInput[];
}

export interface GeoSiteRecord {
  category: string;
  domains: DomainInput[];
}

export interface IpLookup {
  country: string | null;
  codes: string[];
}

export interface GeoLists {
  lookupIp(ip: string): IpLookup;
  lookupDomain(domain: string): string[];
}

const DOMAIN_TYPES: DomainMatchType[] = ["plain", "regex", "domain", "full"];

function encodeCidr(cidr: CidrInput): Uint8Array {
  return concatBytes([fieldBytes(1, cidr.ip), fieldVarint(2, cidr.prefix)]);
}

export function encodeGeoIpList(entries: GeoIpEntryInput[]): Uint8Array {
  return concatBytes(
    entries.map((entry) => {
      const parts = [fieldString(1, entry.countryCode), ...entry.cidrs.map((cidr) => fieldBytes(2, encodeCidr(cidr)))];
      if (entry.reverseMatch) parts.push(fieldVarint(3, 1));
      return fieldBytes(1, concatBytes(parts));
    }),
  );
}

function encodeDomain(domain: DomainInput): Uint8Array {
  const type = DOMAIN_TYPES.indexOf(domain.type);
  const parts = [];
  if (type > 0) parts.push(fieldVarint(1, type));
  parts.push(fieldString(2, domain.value));
  return concatBytes(parts);
}

export function encodeGeoSiteList(entries: GeoSiteEntryInput[]): Uint8Array {
  return concatBytes(
    entries.map((entry) => {
      const parts = [fieldString(1, entry.category), ...entry.domains.map((domain) => fieldBytes(2, encodeDomain(domain)))];
      return fieldBytes(1, concatBytes(parts));
    }),
  );
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseCidr(buf: Uint8Array): CidrInput {
  let ip: Uint8Array | null = null;
  let prefix: number | null = null;
  forEachField(buf, (field, wire, value) => {
    if (field === 1 && wire === 2 && value instanceof Uint8Array) ip = new Uint8Array(value);
    else if (field === 2 && wire === 0 && typeof value === "bigint") prefix = Number(value);
  });
  if (!ip) throw new Error("CIDR is missing an address");
  if (prefix === null) throw new Error("CIDR is missing a prefix length");
  const address: Uint8Array = ip;
  if (address.length !== 4 && address.length !== 16) {
    throw new Error(`CIDR address length ${address.length} is not 4 or 16`);
  }
  const prefixLength: number = prefix;
  const max = address.length === 4 ? 32 : 128;
  if (prefixLength < 0 || prefixLength > max) throw new Error(`CIDR prefix ${prefixLength} is outside 0..${max}`);
  return { ip: address, prefix: prefixLength };
}

function parseGeoIp(buf: Uint8Array): GeoIpRecord {
  let countryCode = "";
  const cidrs: CidrInput[] = [];
  let reverseMatch = false;
  forEachField(buf, (field, wire, value) => {
    if (field === 1 && wire === 2 && value instanceof Uint8Array) countryCode = decodeUtf8(value);
    else if (field === 2 && wire === 2 && value instanceof Uint8Array) cidrs.push(parseCidr(value));
    else if (field === 3 && wire === 0 && typeof value === "bigint") reverseMatch = value !== 0n;
  });
  if (!countryCode) throw new Error("GeoIP entry is missing a country code");
  return { countryCode, cidrs, reverseMatch };
}

export function parseGeoIpList(buf: Uint8Array): GeoIpRecord[] {
  const entries: GeoIpRecord[] = [];
  forEachField(buf, (field, wire, value) => {
    if (field === 1 && wire === 2 && value instanceof Uint8Array) entries.push(parseGeoIp(value));
  });
  return entries;
}

function parseDomain(buf: Uint8Array): DomainInput {
  let type = 0;
  let value = "";
  forEachField(buf, (field, wire, data) => {
    if (field === 1 && wire === 0 && typeof data === "bigint") type = Number(data);
    else if (field === 2 && wire === 2 && data instanceof Uint8Array) value = decodeUtf8(data);
  });
  if (!value) throw new Error("domain rule is missing a value");
  if (!Number.isInteger(type) || type < 0 || type > 3) throw new Error(`domain type ${type} is not a v2ray match type`);
  return { type: DOMAIN_TYPES[type], value };
}

function parseGeoSite(buf: Uint8Array): GeoSiteRecord {
  let category = "";
  const domains: DomainInput[] = [];
  forEachField(buf, (field, wire, value) => {
    if (field === 1 && wire === 2 && value instanceof Uint8Array) category = decodeUtf8(value);
    else if (field === 2 && wire === 2 && value instanceof Uint8Array) domains.push(parseDomain(value));
  });
  if (!category) throw new Error("GeoSite entry is missing a category");
  return { category, domains };
}

export function parseGeoSiteList(buf: Uint8Array): GeoSiteRecord[] {
  const entries: GeoSiteRecord[] = [];
  forEachField(buf, (field, wire, value) => {
    if (field === 1 && wire === 2 && value instanceof Uint8Array) entries.push(parseGeoSite(value));
  });
  return entries;
}

interface V4Rule {
  network: number;
  prefix: number;
  code: string;
  ordinal: number;
}

interface V6Rule {
  network: Uint8Array;
  prefix: number;
  code: string;
  ordinal: number;
}

interface Hit {
  code: string;
  prefix: number;
  ordinal: number;
  reverse: boolean;
}

class RuleIndex<T extends { prefix: number }> {
  readonly short: T[] = [];
  readonly buckets = new Map<number, T[]>();

  add(bucket: number | null, rule: T): void {
    if (bucket === null) {
      this.short.push(rule);
      return;
    }
    const list = this.buckets.get(bucket);
    if (list) list.push(rule);
    else this.buckets.set(bucket, [rule]);
  }
}

interface ReverseIndex<T extends { prefix: number }> {
  code: string;
  ordinal: number;
  index: RuleIndex<T>;
}

function ipv4Number(bytes: Uint8Array): number {
  return bytes[0] * 16777216 + bytes[1] * 65536 + bytes[2] * 256 + bytes[3];
}

function v4Matches(ip: number, network: number, prefix: number): boolean {
  if (prefix <= 0) return true;
  if (prefix >= 32) return ip === network;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) === (network & mask);
}

function v6Matches(ip: Uint8Array, network: Uint8Array, prefix: number): boolean {
  const full = Math.floor(prefix / 8);
  for (let index = 0; index < full; index += 1) {
    if (ip[index] !== network[index]) return false;
  }
  const remainder = prefix % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (ip[full] & mask) === (network[full] & mask);
}

function v4Bucket(network: number, prefix: number): number | null {
  if (prefix < 16) return null;
  return network >>> 16;
}

function v6Bucket(network: Uint8Array, prefix: number): number | null {
  if (prefix < 16) return null;
  return (network[0] << 8) | network[1];
}

type ParsedIp = { version: 4; value: number } | { version: 6; value: Uint8Array };

function parseV4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function parseV6Words(parts: string[]): number[] | null {
  const words: number[] = [];
  for (const part of parts) {
    if (part.includes(".")) {
      const v4 = parseV4(part);
      if (v4 === null) return null;
      words.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    words.push(Number.parseInt(part, 16));
  }
  return words;
}

function wordsToBytes(words: number[]): Uint8Array {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    bytes[index * 2] = words[index] >> 8;
    bytes[index * 2 + 1] = words[index] & 0xff;
  }
  return bytes;
}

function parseV6(text: string): Uint8Array | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1) {
    const words = parseV6Words(head);
    if (!words || words.length !== 8) return null;
    return wordsToBytes(words);
  }
  const left = parseV6Words(head);
  const right = parseV6Words(tail);
  if (!left || !right || left.length + right.length > 8) return null;
  const words = [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
  return wordsToBytes(words);
}

export function parseIp(input: string): ParsedIp | null {
  const text = input.trim().toLowerCase().replace(/%.*/, "");
  if (!text) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (mapped) {
    const value = parseV4(mapped[1]);
    return value === null ? null : { version: 4, value };
  }
  if (text.includes(":")) {
    const bytes = parseV6(text);
    if (!bytes) return null;
    const v4Mapped =
      bytes[0] === 0 &&
      bytes[1] === 0 &&
      bytes[2] === 0 &&
      bytes[3] === 0 &&
      bytes[4] === 0 &&
      bytes[5] === 0 &&
      bytes[6] === 0 &&
      bytes[7] === 0 &&
      bytes[8] === 0 &&
      bytes[9] === 0 &&
      bytes[10] === 0xff &&
      bytes[11] === 0xff;
    if (v4Mapped) return { version: 4, value: ipv4Number(bytes.subarray(12, 16)) };
    return { version: 6, value: bytes };
  }
  const value = parseV4(text);
  return value === null ? null : { version: 4, value };
}

function addMap(map: Map<string, string[]>, key: string, category: string): void {
  const list = map.get(key);
  if (!list) {
    map.set(key, [category]);
    return;
  }
  if (!list.includes(category)) list.push(category);
}

function normalizeDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value || value.length > 2048) return null;
  if (value.includes("://")) {
    try {
      value = new URL(value).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  if (value.startsWith("[") && value.includes("]")) return null;
  value = value.replace(/:\d+$/, "").replace(/\.$/, "");
  if (!value || value.length > 253 || /\s/.test(value) || value.includes(":")) return null;
  return value;
}

function isIsoCountry(code: string): boolean {
  return /^[A-Z]{2}$/.test(code);
}

function finishLookup(hits: Hit[]): IpLookup {
  hits.sort((left, right) => left.ordinal - right.ordinal);
  const codes: string[] = [];
  let country: string | null = null;
  let countryPrefix = -1;
  for (const hit of hits) {
    if (!codes.includes(hit.code)) codes.push(hit.code);
    if (hit.reverse) continue;
    const betterPrefix = hit.prefix > countryPrefix;
    const samePrefixIso = hit.prefix === countryPrefix && country !== null && isIsoCountry(hit.code) && !isIsoCountry(country);
    if (country === null || betterPrefix || samePrefixIso) {
      country = hit.code;
      countryPrefix = hit.prefix;
    }
  }
  return { country, codes };
}

export function buildGeoLists(geoip: GeoIpRecord[], geosite: GeoSiteRecord[]): GeoLists {
  const v4 = new RuleIndex<V4Rule>();
  const v6 = new RuleIndex<V6Rule>();
  const reverse4: ReverseIndex<V4Rule>[] = [];
  const reverse6: ReverseIndex<V6Rule>[] = [];
  geoip.forEach((entry, ordinal) => {
    const direct4 = entry.reverseMatch ? new RuleIndex<V4Rule>() : v4;
    const direct6 = entry.reverseMatch ? new RuleIndex<V6Rule>() : v6;
    if (entry.reverseMatch) {
      reverse4.push({ code: entry.countryCode, ordinal, index: direct4 });
      reverse6.push({ code: entry.countryCode, ordinal, index: direct6 });
    }
    for (const cidr of entry.cidrs) {
      if (cidr.ip.length === 4) {
        const network = ipv4Number(cidr.ip);
        direct4.add(v4Bucket(network, cidr.prefix), { network, prefix: cidr.prefix, code: entry.countryCode, ordinal });
      } else {
        direct6.add(v6Bucket(cidr.ip, cidr.prefix), {
          network: cidr.ip,
          prefix: cidr.prefix,
          code: entry.countryCode,
          ordinal,
        });
      }
    }
  });

  const full = new Map<string, string[]>();
  const suffix = new Map<string, string[]>();
  const plain: { value: string; category: string }[] = [];
  const patterns: { source: string; category: string }[] = [];
  for (const entry of geosite) {
    for (const domain of entry.domains) {
      const value = domain.value.trim().toLowerCase();
      if (!value) continue;
      if (domain.type === "full") addMap(full, value, entry.category);
      else if (domain.type === "domain") addMap(suffix, value.replace(/^\*\./, "").replace(/\.$/, ""), entry.category);
      else if (domain.type === "plain") plain.push({ value, category: entry.category });
      else if (value.length <= 256) patterns.push({ source: domain.value, category: entry.category });
    }
  }
  const compiled = patterns.flatMap((pattern) => {
    try {
      return [{ expression: new RegExp(pattern.source, "i"), category: pattern.category }];
    } catch {
      return [];
    }
  });

  const scan4 = (index: RuleIndex<V4Rule>, ip: number, hits: Hit[], reverse: boolean) => {
    const rules = [...index.short, ...(index.buckets.get(ip >>> 16) ?? [])];
    for (const rule of rules) {
      if (v4Matches(ip, rule.network, rule.prefix)) {
        hits.push({ code: rule.code, prefix: rule.prefix, ordinal: rule.ordinal, reverse });
      }
    }
  };
  const scan6 = (index: RuleIndex<V6Rule>, ip: Uint8Array, hits: Hit[], reverse: boolean) => {
    const bucket = (ip[0] << 8) | ip[1];
    const rules = [...index.short, ...(index.buckets.get(bucket) ?? [])];
    for (const rule of rules) {
      if (v6Matches(ip, rule.network, rule.prefix)) {
        hits.push({ code: rule.code, prefix: rule.prefix, ordinal: rule.ordinal, reverse });
      }
    }
  };

  return {
    lookupIp(ip: string): IpLookup {
      const parsed = parseIp(ip);
      if (!parsed) return { country: null, codes: [] };
      const hits: Hit[] = [];
      if (parsed.version === 4) {
        scan4(v4, parsed.value, hits, false);
        for (const entry of reverse4) {
          const matched: Hit[] = [];
          scan4(entry.index, parsed.value, matched, false);
          if (matched.length === 0) hits.push({ code: entry.code, prefix: 0, ordinal: entry.ordinal, reverse: true });
        }
      } else {
        scan6(v6, parsed.value, hits, false);
        for (const entry of reverse6) {
          const matched: Hit[] = [];
          scan6(entry.index, parsed.value, matched, false);
          if (matched.length === 0) hits.push({ code: entry.code, prefix: 0, ordinal: entry.ordinal, reverse: true });
        }
      }
      return finishLookup(hits);
    },
    lookupDomain(domain: string): string[] {
      const name = normalizeDomain(domain);
      if (!name) return [];
      const categories: string[] = [];
      const add = (found: string[] | undefined) => {
        if (!found) return;
        for (const category of found) {
          if (!categories.includes(category)) categories.push(category);
        }
      };
      add(full.get(name));
      let rest = name;
      while (rest) {
        add(suffix.get(rest));
        const dot = rest.indexOf(".");
        if (dot === -1) break;
        rest = rest.slice(dot + 1);
      }
      for (const rule of plain) {
        if (name.includes(rule.value)) add([rule.category]);
      }
      for (const rule of compiled) {
        if (rule.expression.test(name)) add([rule.category]);
      }
      return categories;
    },
  };
}
