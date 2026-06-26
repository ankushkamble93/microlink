// ─────────────────────────────────────────────────────────────────────────────
// microlink — Base62 Encoder + Knuth Multiplicative Hash (ID Obfuscation)
//
// Why Knuth's hash instead of a simple counter?
//   Sequential IDs (1, 2, 3…) map to sequential Base62 keys, enabling trivial
//   enumeration attacks. Knuth's multiplicative hash is a bijection over a
//   fixed-width integer space, which:
//     1. Scatters IDs across the full 62^N keyspace pseudo-randomly.
//     2. Is completely reversible (no information loss).
//     3. Has zero external dependencies and O(1) time/space complexity.
//
// Security note: this is NOT cryptographically secure — use it only to prevent
// casual enumeration, not as a security guarantee.
// ─────────────────────────────────────────────────────────────────────────────

const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = 62n;

// Knuth's multiplicative hash constant (closest prime to 2^32 * golden ratio).
// Must be odd and coprime with 2^32.
const DEFAULT_SHUFFLE_SEED = 2654435761n;
const MASK_32 = 0xffffffffn;

/**
 * Parse the shuffle seed from the environment or fall back to the default.
 * Seeds arriving as strings are safely coerced to BigInt.
 */
export function parseSeed(raw: string | undefined): bigint {
  if (!raw) return DEFAULT_SHUFFLE_SEED;
  try {
    const n = BigInt(raw);
    if (n <= 0n) throw new Error("seed must be positive");
    return n & MASK_32 || DEFAULT_SHUFFLE_SEED;
  } catch {
    return DEFAULT_SHUFFLE_SEED;
  }
}

/**
 * Knuth's multiplicative bijection over 32-bit integers.
 * Maps any id in [0, 2^32) to a unique, apparently random value in the same range.
 */
export function shuffleId(id: number, seed: bigint = DEFAULT_SHUFFLE_SEED): number {
  const n = BigInt(id >>> 0); // coerce to unsigned 32-bit
  const shuffled = (n * seed) & MASK_32;
  return Number(shuffled);
}

/**
 * Encode a non-negative integer into a Base62 string of at least `minLength`
 * characters (left-padded with '0' if necessary).
 */
export function encodeBase62(n: number, minLength = 6): string {
  if (n < 0 || !Number.isInteger(n)) {
    throw new RangeError(`encodeBase62: expected non-negative integer, got ${n}`);
  }

  let num = BigInt(n);
  const chars: string[] = [];

  if (num === 0n) {
    chars.push("0");
  } else {
    while (num > 0n) {
      const remainder = num % BASE;
      chars.push(BASE62_ALPHABET[Number(remainder)] as string);
      num = num / BASE;
    }
  }

  const encoded = chars.reverse().join("");
  return encoded.padStart(minLength, "0");
}

/**
 * Decode a Base62 string back to its integer representation.
 * Throws if the input contains characters outside the alphabet.
 */
export function decodeBase62(str: string): number {
  if (!str || str.length === 0) {
    throw new RangeError("decodeBase62: input must not be empty");
  }

  let result = 0n;
  for (const char of str) {
    const value = BASE62_ALPHABET.indexOf(char);
    if (value === -1) {
      throw new RangeError(`decodeBase62: invalid character '${char}'`);
    }
    result = result * BASE + BigInt(value);
  }

  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("decodeBase62: decoded value exceeds MAX_SAFE_INTEGER");
  }

  return Number(result);
}

/**
 * Primary entry point: take a raw auto-increment DB id, obfuscate it via
 * Knuth's hash, then encode to Base62.
 */
export function idToKey(id: number, seed?: bigint, minLength = 6): string {
  const obfuscated = shuffleId(id, seed);
  return encodeBase62(obfuscated, minLength);
}

/**
 * Generate a cryptographically random short key of exactly `length` characters.
 * Used as the fallback for hash-based generation or when no auto-increment ID
 * is available.
 */
export function generateRandomKey(length = 7): string {
  const bytes = new Uint8Array(length * 2); // over-sample to avoid bias
  crypto.getRandomValues(bytes);

  let key = "";
  for (const byte of bytes) {
    if (key.length >= length) break;
    // Map byte (0-255) to alphabet index (0-61) without modulo bias:
    // reject bytes >= 62*4=248 (only 8 values out of 256, <3% rejection rate).
    if (byte < 248) {
      key += BASE62_ALPHABET[byte % 62];
    }
  }

  // If rejection sampling didn't produce enough chars (extremely rare), recurse.
  if (key.length < length) {
    return generateRandomKey(length);
  }

  return key.slice(0, length);
}

/**
 * Derive a deterministic short key from a URL via SHA-256 truncation.
 * Used when a content-addressed (stable) key is preferred over an ID-based one.
 * The `salt` parameter enables collision resolution: retry with salt "1", "2"…
 */
export async function urlToKey(url: string, salt = "", length = 7): Promise<string> {
  const data = new TextEncoder().encode(url + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);

  // Convert first 8 bytes to a 64-bit integer (as BigInt to avoid float precision loss).
  let num = 0n;
  for (let i = 0; i < 8; i++) {
    num = (num << 8n) | BigInt(hashArray[i] ?? 0);
  }

  // Fold into Base62 of the requested length.
  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    chars.push(BASE62_ALPHABET[Number(num % BASE)] as string);
    num = num / BASE;
  }

  return chars.reverse().join("");
}
