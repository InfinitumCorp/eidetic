// © Infinitum Corporation®. All rights reserved.
// Reader for v2fly geoip.dat (GeoIPList) and geosite.dat (GeoSiteList).

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  bytesField,
  encodeBytesField,
  encodeMessageField,
  encodeStringField,
  encodeVarintField,
  packBytes,
  readFields,
  textField,
  varintField,
} from "./protobuf.js";

export type DomainType = "plain" | "regex" | "domain" | "full";

export interface Cidr {
  ip: Uint8Array;
  prefix: number;
}

export interface GeoIpEntry {
  countryCode: string;
  cidrs: Cidr[];
  reverseMatch: boolean;
}

export interface DomainRule {
  type: DomainType;
  value: string;
}

export interface GeoSiteEntry {
  category: string;
  domains: DomainRule[];
}

const DOMAIN_TYPES: DomainType[] = ["plain", "regex", "domain", "full"];
const SAFE_LABEL = /^[A-Za-z0-9_.:!+-]{1,80}$/;

interface IndexedCidr {
  country: string;
  ip: Uint8Array;
  prefix: number;
}

interface IndexedRule {
  order: number;
  category: string;
  type: DomainType;
  value: string;
  regex?: RegExp;
}

export class V2RayGeoDataset {
  private readonly v4Wide: IndexedCidr[] = [];
  private readonly v4 = new Map<number, IndexedCidr[]>();
  private readonly v6Wide: IndexedCidr[] = [];
  private readonly v6 = new Map<number, IndexedCidr[]>();
  private readonly full = new Map<string, IndexedRule[]>();
  private readonly root = new Map<string, IndexedRule[]>();
  private readonly plain: IndexedRule[] = [];
  private readonly regex: IndexedRule[] = [];

  private constructor(
    readonly countries: GeoIpEntry[],
    readonly sites: GeoSiteEntry[],
  ) {
    for (const entry of countries) {
      if (entry.reverseMatch || !SAFE_LABEL.test(entry.countryCode)) continue;
      for (const cidr of entry.cidrs) {
        const indexed = { country: entry.countryCode, ip: cidr.ip, prefix: cidr.prefix };
        if (cidr.ip.length === 4) this.addCidr(this.v4, this.v4Wide, indexed);
        else if (cidr.ip.length === 16) this.addCidr(this.v6, this.v6Wide, indexed);
      }
    }
    sites.forEach((entry, order) => {
      if (!SAFE_LABEL.test(entry.category)) return;
      for (const domain of entry.domains) {
        if (!domain.value || domain.value.length > 253) continue;
        const rule: IndexedRule = { order, category: entry.category, type: domain.type, value: domain.value.toLowerCase() };
        if (domain.type === "regex") {
          if (domain.value.length > 128) continue;
          try {
            rule.regex = new RegExp(domain.value);
          } catch {
            continue;
          }
          this.regex.push(rule);
          continue;
        }
        if (domain.type === "plain") {
          this.plain.push(rule);
          continue;
        }
        const bucket = domain.type === "full" ? this.full : this.root;
        const list = bucket.get(rule.value) ?? [];
        list.push(rule);
        bucket.set(rule.value, list);
      }
    });
  }

  static fromBytes(geoip: Uint8Array, geosite: Uint8Array): V2RayGeoDataset {
    return new V2RayGeoDataset(parseGeoIpList(geoip), parseGeoSiteList(geosite));
  }

  countryForIp(ip: string): string | null {
    const bytes = parseIp(ip);
    if (!bytes) return null;
    const candidates = bytes.length === 4 ? this.candidates(this.v4, this.v4Wide, bytes[0] ?? 0) : this.candidates(this.v6, this.v6Wide, bytes[0] ?? 0);
    let best: IndexedCidr | null = null;
    let ambiguous = false;
    for (const cidr of candidates) {
      if (!cidrContains(bytes, cidr.ip, cidr.prefix)) continue;
      if (!best || cidr.prefix > best.prefix) {
        best = cidr;
        ambiguous = false;
        continue;
      }
      if (cidr.prefix === best.prefix && cidr.country !== best.country) ambiguous = true;
    }
    if (!best || ambiguous) return null;
    return best.country;
  }

  categoriesForDomain(domain: string): string[] {
    const normalized = normalizeDomain(domain);
    if (!normalized) return [];
    const hits: IndexedRule[] = [];
    hits.push(...(this.full.get(normalized) ?? []));
    for (const suffix of domainSuffixes(normalized)) hits.push(...(this.root.get(suffix) ?? []));
    for (const rule of this.plain) {
      if (normalized.includes(rule.value)) hits.push(rule);
    }
    for (const rule of this.regex) {
      rule.regex!.lastIndex = 0;
      if (rule.regex!.test(normalized)) hits.push(rule);
    }
    hits.sort((left, right) => left.order - right.order);
    const categories: string[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      if (seen.has(hit.category)) continue;
      seen.add(hit.category);
      categories.push(hit.category);
    }
    return categories;
  }

  private addCidr(bucket: Map<number, IndexedCidr[]>, wide: IndexedCidr[], cidr: IndexedCidr): void {
    if (cidr.prefix < 8) {
      wide.push(cidr);
      return;
    }
    const key = cidr.ip[0] ?? 0;
    const list = bucket.get(key) ?? [];
    list.push(cidr);
    bucket.set(key, list);
  }

  private candidates(bucket: Map<number, IndexedCidr[]>, wide: IndexedCidr[], first: number): IndexedCidr[] {
    return [...wide, ...(bucket.get(first) ?? [])];
  }
}

export function parseGeoIpList(bytes: Uint8Array): GeoIpEntry[] {
  return bytesField(readFields(bytes), 1).map(parseGeoIp).filter((entry): entry is GeoIpEntry => entry !== null);
}

export function parseGeoSiteList(bytes: Uint8Array): GeoSiteEntry[] {
  return bytesField(readFields(bytes), 1).map(parseGeoSite).filter((entry): entry is GeoSiteEntry => entry !== null);
}

export function loadV2RayDataset(dir: string): V2RayGeoDataset {
  const geoip = readFileSync(path.join(dir, "geoip.dat"));
  const geosite = readFileSync(path.join(dir, "geosite.dat"));
  return V2RayGeoDataset.fromBytes(geoip, geosite);
}

function parseGeoIp(bytes: Uint8Array): GeoIpEntry | null {
  const fields = readFields(bytes);
  const countryCode = textField(fields, 1).trim();
  if (!countryCode) return null;
  const cidrs = bytesField(fields, 2).map(parseCidr).filter((cidr): cidr is Cidr => cidr !== null);
  return { countryCode, cidrs, reverseMatch: (varintField(fields, 3) ?? 0) !== 0 };
}

function parseCidr(bytes: Uint8Array): Cidr | null {
  const fields = readFields(bytes);
  const ip = bytesField(fields, 1)[0];
  const prefix = varintField(fields, 2);
  if (!ip || (ip.length !== 4 && ip.length !== 16) || prefix === undefined) return null;
  if (prefix > ip.length * 8) return null;
  return { ip, prefix };
}

function parseGeoSite(bytes: Uint8Array): GeoSiteEntry | null {
  const fields = readFields(bytes);
  const category = textField(fields, 1).trim();
  if (!category) return null;
  const domains = bytesField(fields, 2).map(parseDomain).filter((domain): domain is DomainRule => domain !== null);
  return { category, domains };
}

function parseDomain(bytes: Uint8Array): DomainRule | null {
  const fields = readFields(bytes);
  const type = DOMAIN_TYPES[varintField(fields, 1) ?? 0];
  const value = textField(fields, 2).trim();
  if (!type || !value) return null;
  return { type, value };
}

export function parseIp(input: string): Uint8Array | null {
  const value = input.trim();
  if (!value || value.includes("%") || value.includes("/")) return null;
  if (!value.includes(":")) return parseV4(value);
  return parseV6(value);
}

function parseV4(value: string): Uint8Array | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index] ?? "";
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const number = Number(part);
    if (number > 255) return null;
    out[index] = number;
  }
  return out;
}

function parseV6(value: string): Uint8Array | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = parseV6Side(halves[0] ?? "");
  if (!left) return null;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    return wordsToBytes(left);
  }
  const right = parseV6Side(halves[1] ?? "");
  if (!right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return wordsToBytes([...left, ...new Array<number>(missing).fill(0), ...right]);
}

function parseV6Side(side: string): number[] | null {
  if (side === "") return [];
  const parts = side.split(":");
  const words: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    if (part.includes(".")) {
      if (index !== parts.length - 1) return null;
      const v4 = parseV4(part);
      if (!v4) return null;
      words.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    words.push(Number.parseInt(part, 16));
  }
  return words;
}

function wordsToBytes(words: number[]): Uint8Array {
  const out = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const word = words[index] ?? 0;
    out[index * 2] = word >> 8;
    out[index * 2 + 1] = word & 0xff;
  }
  return out;
}

export function normalizeDomain(input: string): string | null {
  const value = input.trim().toLowerCase().replace(/\.$/, "");
  if (!value || value.length > 253 || value.includes("..") || value.startsWith(".") || value.startsWith("-")) return null;
  if (!/^[a-z0-9.-]+$/.test(value)) return null;
  return value;
}

function domainSuffixes(domain: string): string[] {
  const labels = domain.split(".");
  const suffixes: string[] = [];
  for (let index = 0; index < labels.length; index += 1) suffixes.push(labels.slice(index).join("."));
  return suffixes;
}

function cidrContains(ip: Uint8Array, network: Uint8Array, prefix: number): boolean {
  if (ip.length !== network.length || prefix < 0 || prefix > ip.length * 8) return false;
  const full = Math.floor(prefix / 8);
  for (let index = 0; index < full; index += 1) {
    if (ip[index] !== network[index]) return false;
  }
  const rest = prefix % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (ip[full]! & mask) === (network[full]! & mask);
}

function encodeCidr(ip: number[], prefix: number): number[] {
  return [...encodeBytesField(1, Uint8Array.from(ip)), ...encodeVarintField(2, prefix)];
}

function encodeDomain(type: number, value: string): number[] {
  return [...encodeVarintField(1, type), ...encodeStringField(2, value)];
}

/** Tiny synthetic lists used by tests. These bytes are not the v2fly releases. */
export function buildSyntheticGeoFixtures(): { geoip: Uint8Array; geosite: Uint8Array } {
  const us = [
    ...encodeStringField(1, "US"),
    ...encodeMessageField(2, encodeCidr([1, 2, 3, 0], 24)),
  ];
  const ca = [
    ...encodeStringField(1, "CA"),
    ...encodeMessageField(2, encodeCidr([1, 2, 3, 4], 32)),
  ];
  const fr = [
    ...encodeStringField(1, "FR"),
    ...encodeMessageField(2, encodeCidr([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 32)),
  ];
  const excluded = [
    ...encodeStringField(1, "ZZ"),
    ...encodeMessageField(2, encodeCidr([9, 9, 9, 0], 24)),
    ...encodeVarintField(3, 1),
  ];
  const geoip = packBytes([
    encodeMessageField(1, us),
    encodeMessageField(1, ca),
    encodeMessageField(1, fr),
    encodeMessageField(1, excluded),
  ]);
  const google = [
    ...encodeStringField(1, "google"),
    ...encodeMessageField(2, encodeDomain(2, "google.com")),
  ];
  const workspace = [
    ...encodeStringField(1, "workspace"),
    ...encodeMessageField(2, encodeDomain(3, "mail.google.com")),
  ];
  const cn = [
    ...encodeStringField(1, "cn"),
    ...encodeMessageField(2, encodeDomain(3, "example.cn")),
  ];
  const ads = [
    ...encodeStringField(1, "ads"),
    ...encodeMessageField(2, encodeDomain(0, "adservice")),
  ];
  const pinned = [
    ...encodeStringField(1, "pinned"),
    ...encodeMessageField(2, encodeDomain(1, "^pinned\\.example$")),
  ];
  const geosite = packBytes([
    encodeMessageField(1, google),
    encodeMessageField(1, workspace),
    encodeMessageField(1, cn),
    encodeMessageField(1, ads),
    encodeMessageField(1, pinned),
  ]);
  return { geoip, geosite };
}
