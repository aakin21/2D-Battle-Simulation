// Who a request comes from, as far as the quota needs it: the address Cloudflare saw
// (CF-Connecting-IP), an IPv4 address whole and an IPv6 address by its /64 (one home or phone
// usually gets a whole /64 and picks addresses in it at will). The address itself is never kept:
// the counter is named by an HMAC of it with a secret salt (QUOTA_SALT), so the stored names
// cannot be turned back into addresses without the salt.

const encoder = new TextEncoder();

// "a.b.c.d" as four numbers, or null
function ipv4(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

// An IPv6 address as its eight 16-bit words, or null (`::` once at most, an IPv4 tail allowed,
// no zone or brackets: CF-Connecting-IP has none)
function ipv6(text: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const words = (part: string, last: boolean): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const groups = part.split(':');
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (last && i === groups.length - 1 && group.includes('.')) {
        const v4 = ipv4(group);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(group)) {
        out.push(parseInt(group, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = words(halves[0], halves.length === 1);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = words(halves[1], true);
  if (!tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

// The quota's key for a client address: "4:a.b.c.d", or "6:" and the /64 prefix as four words;
// an IPv4-mapped IPv6 address (::ffff:a.b.c.d) is its IPv4 address. Null when it is no address.
export function clientKey(address: string | null): string | null {
  const text = address?.trim() ?? '';
  if (!text) return null;
  const v4 = ipv4(text);
  if (v4) return `4:${v4.join('.')}`;
  const v6 = ipv6(text);
  if (!v6) return null;
  if (v6.slice(0, 5).every((w) => w === 0) && v6[5] === 0xffff)
    return `4:${v6[6] >> 8}.${v6[6] & 255}.${v6[7] >> 8}.${v6[7] & 255}`;
  return `6:${v6
    .slice(0, 4)
    .map((w) => w.toString(16).padStart(4, '0'))
    .join(':')}::/64`;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The counter's name for a client key: HMAC-SHA-256 with the salt, in hex
export async function counterName(salt: string, key: string): Promise<string> {
  const hmac = await crypto.subtle.importKey(
    'raw',
    encoder.encode(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return `v1:${hex(await crypto.subtle.sign('HMAC', hmac, encoder.encode(key)))}`;
}

// Whether `given` is `secret`, in time that does not depend on where they differ: both are hashed
// (equal lengths) and every byte is compared. Never true without a secret.
export async function sameSecret(given: string | null, secret: string | null): Promise<boolean> {
  if (given === null || secret === null || secret === '') return false;
  const [a, b] = await Promise.all(
    [given, secret].map(
      async (text) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
    )
  );
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
