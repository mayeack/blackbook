#!/usr/bin/env node
// PII / secret lint for a PUBLIC repo (npm run lint:pii; CI and .githooks/pre-commit).
// Scans every git-tracked and untracked-but-not-ignored file in the repo (binaries and the lockfile excepted) for:
//   - real-looking phone numbers (E.164, "(xxx) xxx-xxxx", "xxx-xxx-xxxx", and bare or space-separated NANP
//     numbers like "2125550123" / "212 555 0123", the shape Contacts exports and Core Data stores use) outside the
//     fictional ranges (NANP 555-01xx, Ofcom drama numbers),
//   - email addresses outside reserved domains (example.com/.org/.net, *.example, *.test, *.invalid, localhost),
//   - long base64/hex runs that look like secrets, and well-known token prefixes / private keys.
// Phone candidates count only if libphonenumber says they are valid numbers (so constants like +978307200 pass);
// NANP toll-free numbers belong to businesses and are allowed. Hex runs labelled as a hash/digest are allowed.
// Findings print as file:line + kind with the match MASKED (the point is to keep real data out of logs too).
// Exit 1 on any finding.
//
// Known legacy findings live in scripts/pii-baseline.tsv as `path<TAB>kind<TAB>fingerprint<TAB># reason`, where the
// fingerprint is the first 16 hex chars of sha256(match): it identifies a value already in that file without
// repeating it. `node scripts/lint-pii.mjs --fingerprints` prints the line to add for each current finding. Only
// pre-existing fixtures belong there; new code uses synthetic data.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.pdf', '.zip', '.gz', '.sqlite', '.db', '.woff', '.woff2', '.ttf', '.heic', '.mov', '.mp4']);
const SKIP_FILES = new Set(['package-lock.json']);
const MAX_BYTES = 4 * 1024 * 1024;

const digits = (s) => s.replace(/\D/g, '');

// libphonenumber-js is a workspace dependency; without node_modules fall back to a length/shape heuristic.
let isValidNumber = (e164) => /^\+(1[2-9]\d{2}[2-9]\d{6}|[2-9]\d{7,13})$/.test(e164);
try {
  ({ isValidPhoneNumber: isValidNumber } = await import('libphonenumber-js'));
} catch {
  process.stderr.write('lint:pii: libphonenumber-js not installed; using a heuristic phone check\n');
}

const TOLL_FREE = /^1(800|833|844|855|866|877|888)\d{7}$/;
/** Bare 10-digit runs that are well-known integer constants, not phones (INT32/UINT32 limits, FNV, Knuth, 0xDEADBEEF). */
const NUMERIC_CONSTANTS = new Set(['2147483647', '2147483648', '4294967295', '4294967296', '2166136261', '2654435761', '3735928559']);

/** Fictional ranges: NANP xxx-555-01xx (any country prefix), Ofcom drama numbers (UK). */
function fictionalPhone(d) {
  if (/55501\d\d$/.test(d)) return true;
  return [
    /^44(?:113|114|115|116|117|118|121|131|141|151|161)4960\d{3}$/,
    /^441914980\d{3}$/,
    /^442079460\d{3}$/,
    /^442896496\d{3}$/,
    /^442920180\d{3}$/,
    /^441632(?:9600)\d{2}$/,
    /^447700900\d{3}$/,
    /^448081570\d{3}$/,
    /^449098790\d{3}$/,
  ].some((re) => re.test(d));
}

const EMAIL_OK_DOMAINS = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;
const EMAIL_OK_EXACT = new Set(['git@github.com']);

function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

function looksSecret(run) {
  const up = (run.match(/[A-Z]/g) ?? []).length / run.length;
  const lo = (run.match(/[a-z]/g) ?? []).length / run.length;
  const dg = (run.match(/[0-9]/g) ?? []).length / run.length;
  return up >= 0.1 && lo >= 0.1 && dg >= 0.04 && entropy(run) >= 4.2;
}

const HASH_LABEL = /(hash|sha-?(1|256|384|512)|digest|checksum|etag|integrity|md5|fingerprint)\W{0,6}$/i;

const mask = (s) => (s.length <= 6 ? '*'.repeat(s.length) : `${s.slice(0, 2)}${'*'.repeat(Math.min(12, s.length - 4))}${s.slice(-2)}`);

/** A real-looking phone: a valid number that is neither fictional nor a business toll-free line. */
function realPhone(d) {
  return d.length >= 8 && d.length <= 15 && isValidNumber(`+${d}`) && !fictionalPhone(d) && !TOLL_FREE.test(d);
}

const RULES = [
  { kind: 'phone', re: /(?<![\w+])\+[1-9][\d\s().-]{6,18}\d(?!\d)/g, bad: (m) => realPhone(digits(m)) },
  { kind: 'phone', re: /\(\d{3}\)\s?\d{3}[\s.-]\d{4}(?!\d)/g, bad: (m) => realPhone(`1${digits(m)}`) },
  { kind: 'phone', re: /(?<![\w.-])\d{3}[.-]\d{3}[.-]\d{4}(?![\w.-]*\d)/g, bad: (m) => realPhone(`1${digits(m)}`) },
  {
    kind: 'phone',
    re: /(?<![\w.+-])1?[2-9]\d{2}[ .-]?[2-9]\d{2}[ .-]?\d{4}(?![\w.-]*\d)/g,
    bad: (m) => {
      const d = digits(m);
      return !NUMERIC_CONSTANTS.has(d) && realPhone(d.length === 10 ? `1${d}` : d);
    },
  },
  {
    kind: 'email',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    bad: (m) => !EMAIL_OK_EXACT.has(m.toLowerCase()) && !EMAIL_OK_DOMAINS.test(m.split('@')[1]),
  },
  {
    kind: 'hex-secret',
    re: /(?<![0-9a-zA-Z])[0-9a-f]{32,}(?![0-9a-zA-Z])|(?<![0-9a-zA-Z])[0-9A-F]{32,}(?![0-9a-zA-Z])/g,
    bad: (m, line, index) => /\d/.test(m) && /[a-f]/i.test(m) && !HASH_LABEL.test(line.slice(Math.max(0, index - 40), index)),
  },
  { kind: 'base64-secret', re: /[A-Za-z0-9+/_-]{40,}={0,2}/g, bad: looksSecret },
  { kind: 'token', re: /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/g, bad: () => true },
  { kind: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, bad: () => true },
];

const fingerprint = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);

function loadBaseline() {
  const file = path.join(ROOT, 'scripts', 'pii-baseline.tsv');
  if (!fs.existsSync(file)) return new Set();
  return new Set(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split('\t').slice(0, 3).join('\t')),
  );
}
const baseline = loadBaseline();

function listFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}

function scan(rel) {
  if (SKIP_EXT.has(path.extname(rel).toLowerCase()) || SKIP_FILES.has(path.basename(rel))) return [];
  const abs = path.resolve(ROOT, rel);
  let buf;
  try {
    if (fs.statSync(abs).size > MAX_BYTES) return [{ rel, line: 0, kind: 'too-large', sample: '' }];
    buf = fs.readFileSync(abs);
  } catch {
    return []; // deleted in the working tree
  }
  if (buf.subarray(0, 8192).includes(0)) return []; // binary
  const findings = [];
  buf
    .toString('utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const rule of RULES) {
        for (const m of line.matchAll(rule.re)) {
          if (!rule.bad(m[0], line, m.index ?? 0)) continue;
          const fp = fingerprint(m[0]);
          if (baseline.has(`${rel}\t${rule.kind}\t${fp}`)) continue;
          findings.push({ rel, line: i + 1, kind: rule.kind, sample: mask(m[0]), fp });
        }
      }
    });
  return findings;
}

// `node scripts/lint-pii.mjs <file>…` scans just those files (used by the linter's own test).
const args = process.argv.slice(2);
const printFingerprints = args.includes('--fingerprints');
const explicit = args.filter((a) => a !== '--fingerprints');
const files = explicit.length ? explicit : listFiles();
const findings = files.flatMap(scan);
if (findings.length) {
  for (const f of findings) process.stderr.write(`${f.rel}:${f.line}: ${f.kind} ${f.sample}\n`);
  if (printFingerprints) {
    const lines = [...new Set(findings.map((f) => `${f.rel}\t${f.kind}\t${f.fp}\t# reason`))];
    process.stderr.write(`baseline lines (scripts/pii-baseline.tsv):\n${lines.join('\n')}\n`);
  }
  process.stderr.write(`lint:pii: ${findings.length} finding(s) in ${new Set(findings.map((f) => f.rel)).size} file(s). Use synthetic data (555-01xx, example.com).\n`);
  process.exit(1);
}
process.stdout.write(`lint:pii: ${files.length} files clean\n`);
