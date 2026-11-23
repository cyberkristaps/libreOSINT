// Value normalization for deduplication. Must match `normalize_value` in src-tauri/src/model.rs;
// both are tested against schema/dedup-vectors.json.
import { EntityType } from './entity';

export class InvalidValueError extends Error {
  constructor(type: EntityType, value: string, reason: string) {
    super(`Invalid ${type} "${value}": ${reason}`);
    this.name = 'InvalidValueError';
  }
}

/** Dedup identity key for an entity. */
export function entityKey(type: EntityType, value: string): string {
  return `${type}\u0000${normalizeValue(type, value)}`;
}

export function normalizeValue(type: EntityType, raw: string): string {
  const v = raw.trim();
  const fail = (reason: string): never => {
    throw new InvalidValueError(type, raw, reason);
  };
  if (!v) fail('value is empty');

  switch (type) {
    case 'Domain':
    case 'Subdomain': {
      if (/[\s/@:?#]/.test(v)) fail('host names cannot contain spaces or any of / @ : ? #');
      const d = v.toLowerCase().replace(/\.$/, '');
      return d || fail('value is empty');
    }
    case 'Email':
      return v.toLowerCase();
    case 'IPv4':
      return parseIPv4(v)?.join('.') ?? fail('not a dotted-quad IPv4 address');
    case 'IPv6':
      return normalizeIPv6(v) ?? fail('not a valid IPv6 address');
    case 'URL':
      return normalizeUrl(v);
    case 'Social_Account':
      return normalizeSocialAccount(v) ?? fail('expected a profile URL, platform/handle or @user@instance');
    case 'Phone_Number':
      return normalizePhone(v) ?? fail('expected 5–15 digits, optionally starting with + or 00');
    case 'Alias': {
      const a = v.replace(/^@/, '').trim().replace(/\s+/g, ' ').toLowerCase();
      return a || fail('value is empty');
    }
    case 'Location': {
      const loc = normalizeLocation(v);
      if (loc === null) fail('coordinates out of range (latitude ±90, longitude ±180)');
      return loc!;
    }
    default:
      return v;
  }
}

function parseIPv4(v: string): number[] | null {
  const parts = v.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    // Leading zeros are rejected (ambiguous octal), matching Rust's Ipv4Addr parser.
    if (!/^\d{1,3}$/.test(p) || (p.length > 1 && p.startsWith('0'))) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** RFC 5952 canonical form; IPv4-mapped addresses render as `::ffff:a.b.c.d` (like Rust's Display). */
function normalizeIPv6(input: string): string | null {
  const groups = parseIPv6(input);
  return groups ? formatIPv6(groups) : null;
}

/** Parse an IPv6 address into its 8 16-bit groups. */
function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  if (s.includes('%') || s.includes('/')) return null;

  const lastColon = s.lastIndexOf(':');
  if (lastColon < 0) return null;
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
    return groups.map((g) => parseInt(g, 16));
  };

  const halves = s.split('::');
  let groups: number[];
  if (halves.length > 2) return null;
  if (halves.length === 2) {
    const a = parseGroups(halves[0]);
    const b = parseGroups(halves[1]);
    if (!a || !b || a.length + b.length > 7) return null;
    groups = [...a, ...new Array<number>(8 - a.length - b.length).fill(0), ...b];
  } else {
    const g = parseGroups(s);
    if (!g || g.length !== 8) return null;
    groups = g;
  }
  return groups;
}

function formatIPv6(groups: number[]): string {
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `::ffff:${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }

  // Longest run (>= 2) of zero groups is compressed; ties go to the first run.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (gs: number[]) => gs.map((g) => g.toString(16)).join(':');
  if (bestLen < 2) return hex(groups);
  return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLen))}`;
}

/** Lowercase scheme and host only; userinfo, port, path, query and fragment are kept verbatim. */
function normalizeUrl(v: string): string {
  const sep = v.indexOf('://');
  if (sep < 0) return v;
  const scheme = v.slice(0, sep).toLowerCase();
  const rest = v.slice(sep + 3);
  const authEnd = rest.search(/[/?#]/);
  const authority = authEnd < 0 ? rest : rest.slice(0, authEnd);
  const after = authEnd < 0 ? '' : rest.slice(authEnd);
  const at = authority.lastIndexOf('@');
  const userinfo = at < 0 ? '' : authority.slice(0, at + 1);
  const hostPort = authority.slice(at + 1).toLowerCase();
  return `${scheme}://${userinfo}${hostPort}${after}`;
}

// --- social accounts -------------------------------------------------------------------

/** Hosts whose profile handles are case-insensitive, so the whole path can be lowercased. */
const CASE_INSENSITIVE_HOSTS = new Set([
  'x.com', 'instagram.com', 'github.com', 'gitlab.com', 'reddit.com', 'linkedin.com', 'facebook.com',
  'tiktok.com', 't.me', 'threads.net', 'bsky.app', 'pinterest.com', 'twitch.tv', 'medium.com',
  'keybase.io', 'snapchat.com', 'vk.com', 'telegram.me',
]);
const HOST_ALIASES: Record<string, string> = { 'twitter.com': 'x.com', 'telegram.me': 't.me', 'fb.com': 'facebook.com' };
const FEDIVERSE = /^@([a-z0-9_.-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

/**
 * Canonical form `host/path` (e.g. `x.com/jdoe`, `mastodon.social/@jdoe`), or a lowercased bare handle (`@jdoe`).
 * Must match `normalize_social_account` in src-tauri/src/model.rs.
 */
function normalizeSocialAccount(v: string): string | null {
  const fedi = FEDIVERSE.exec(v);
  if (fedi) return `${fedi[2].toLowerCase()}/@${fedi[1].toLowerCase()}`;
  let s = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.split(/[?#]/)[0].replace(/\/+$/, '');
  if (!s) return null;
  if (!s.includes('/') && !s.includes('.')) return s.toLowerCase(); // bare handle
  const slash = s.indexOf('/');
  let host = (slash < 0 ? s : s.slice(0, slash)).toLowerCase().replace(/^(www|m|mobile)\./, '');
  host = HOST_ALIASES[host] ?? host;
  let path = slash < 0 ? '' : s.slice(slash + 1);
  if (!host) return null;
  if (CASE_INSENSITIVE_HOSTS.has(host) || path.startsWith('@')) path = path.toLowerCase();
  return path ? `${host}/${path}` : host;
}

export interface SocialAccountInfo {
  platform: string;
  handle: string;
  profile_url: string;
}

const PLATFORM_NAMES: Record<string, string> = {
  'x.com': 'X', 'instagram.com': 'Instagram', 'github.com': 'GitHub', 'gitlab.com': 'GitLab', 'reddit.com': 'Reddit',
  'linkedin.com': 'LinkedIn', 'facebook.com': 'Facebook', 'tiktok.com': 'TikTok', 't.me': 'Telegram',
  'threads.net': 'Threads', 'bsky.app': 'Bluesky', 'youtube.com': 'YouTube', 'twitch.tv': 'Twitch',
  'medium.com': 'Medium', 'pinterest.com': 'Pinterest', 'keybase.io': 'Keybase', 'snapchat.com': 'Snapchat', 'vk.com': 'VK',
};

/** Derive platform / handle / profile URL from a (normalized) Social_Account value, for entity properties. */
export function socialAccountInfo(value: string): SocialAccountInfo | null {
  const norm = normalizeSocialAccount(value.trim());
  if (!norm || !norm.includes('/')) return null;
  const [host, ...rest] = norm.split('/');
  // Skip path prefixes that are not the handle itself (linkedin.com/in/x, reddit.com/user/x, youtube.com/c/x, bsky.app/profile/x).
  const segs = rest.filter(Boolean);
  const skip = new Set(['in', 'company', 'u', 'user', 'users', 'c', 'channel', 'profile', 'people']);
  const handleSeg = segs.find((seg) => !skip.has(seg.toLowerCase())) ?? segs[0] ?? '';
  const platform = PLATFORM_NAMES[host] ?? (handleSeg.startsWith('@') ? `Fediverse (${host})` : host);
  return { platform, handle: handleSeg.replace(/^@/, ''), profile_url: `https://${norm}` };
}

// --- phone numbers and locations ---------------------------------
// Each must match its counterpart in src-tauri/src/model.rs (shared vectors in schema/dedup-vectors.json).

/** Digits only, `+` kept, `00` international prefix → `+`. Not reformatted per country (no metadata). */
function normalizePhone(v: string): string | null {
  let s = v.replace(/^tel:/i, '').replace(/[\s\-.()/]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  return /^\+?\d{5,15}$/.test(s) ? s : null;
}

const COORD = /^[+-]?\d{1,3}(\.\d+)?$/;

/** `+056.94960` → `56.9496`, `-0.0` → `0`. String-based so Rust and TS agree exactly. */
function canonNumber(n: string): string {
  const neg = n.startsWith('-');
  const [intPart, frac = ''] = n.replace(/^[+-]/, '').split('.');
  const i = intPart.replace(/^0+/, '') || '0';
  const f = frac.replace(/0+$/, '');
  const out = f ? `${i}.${f}` : i;
  return neg && out !== '0' ? `-${out}` : out;
}

function splitCoordinates(v: string): [string, string] | null {
  let pair: string[];
  if (v.includes(',')) pair = v.split(',');
  else if (v.includes(';')) pair = v.split(';');
  else pair = v.split(/\s+/);
  if (pair.length !== 2) return null;
  const [a, b] = pair.map((p) => p.trim());
  return COORD.test(a) && COORD.test(b) ? [a, b] : null;
}

/**
 * `lat, lon` coordinates are canonicalized (and must be in range → otherwise null);
 * place names are whitespace-collapsed, `", "`-separated and lowercased.
 */
function normalizeLocation(v: string): string | null {
  const coords = splitCoordinates(v);
  if (coords) {
    const [lat, lon] = coords.map(canonNumber);
    return Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180 ? `${lat}, ${lon}` : null;
  }
  return v.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim().toLowerCase();
}

// --- derived properties ----------------------------------------------------------------

export function locationInfo(value: string): { kind: 'coordinates'; latitude: number; longitude: number } | null {
  const coords = splitCoordinates(value.trim());
  if (!coords) return null;
  const [lat, lon] = coords.map((c) => Number(canonNumber(c)));
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { kind: 'coordinates', latitude: lat, longitude: lon } : null;
}
