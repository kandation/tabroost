// Registrable domain ("site") of a URL without a public-suffix list dependency.
// Rule: strip a leading "www.". If the last two labels are a known multi-label public suffix, keep three labels,
// otherwise two. IPs, localhost and single-label hosts are used as they are. Internal pages map to a pseudo-site.

const MULTI = new Set([
  // Thai
  'co.th', 'ac.th', 'go.th', 'in.th', 'or.th', 'mi.th', 'net.th',
  // common ccTLD second levels
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'com.br', 'net.br', 'org.br', 'gov.br', 'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.hk', 'org.hk', 'edu.hk', 'com.sg', 'edu.sg', 'gov.sg', 'com.my', 'edu.my', 'gov.my', 'co.id', 'ac.id', 'go.id', 'or.id',
  'co.kr', 'or.kr', 'ac.kr', 'go.kr', 'co.nz', 'org.nz', 'govt.nz', 'ac.nz', 'co.in', 'net.in', 'org.in', 'ac.in', 'gov.in', 'edu.in',
  'com.tw', 'org.tw', 'edu.tw', 'gov.tw', 'com.vn', 'edu.vn', 'gov.vn', 'com.ph', 'edu.ph', 'gov.ph', 'co.za', 'org.za', 'ac.za',
  'com.mx', 'com.ar', 'com.co', 'com.tr', 'com.ua', 'co.il', 'com.eg', 'com.pk', 'com.bd', 'com.np', 'com.lk', 'co.ke', 'com.ng',
  // hosting platforms (user content lives under the second label)
  'github.io', 'gitlab.io', 'blogspot.com', 'vercel.app', 'netlify.app', 'pages.dev', 'web.app', 'firebaseapp.com', 'herokuapp.com',
  'azurewebsites.net', 'cloudfront.net', 's3.amazonaws.com', 'appspot.com', 'workers.dev', 'myshopify.com', 'wordpress.com', 'notion.site',
  'onrender.com', 'fly.dev', 'surge.sh', 'glitch.me', 'repl.co', 'substack.com', 'medium.com',
]);

// i18n-allow: stored key of the site index (rows already saved use it); show it with siteLabel() so each language gets its own word
export const INTERNAL_SITE = '(ภายใน)';
export const siteLabel = (site, label) => (site === INTERNAL_SITE ? label : site);
const memo = new Map();

export function siteOfHost(host) {
  let h = String(host || '').toLowerCase();
  if (!h) return INTERNAL_SITE;
  const hit = memo.get(h);
  if (hit) return hit;
  let out;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || h === 'localhost') out = h; // ip / ipv6 / localhost
  else {
    if (h.startsWith('www.')) h = h.slice(4);
    const parts = h.split('.');
    if (parts.length <= 2) out = h;
    else {
      const last2 = parts.slice(-2).join('.');
      out = MULTI.has(last2) ? parts.slice(-3).join('.') : last2;
      if (parts[parts.length - 1] === 'localhost') out = parts.slice(-2).join('.'); // h12.localhost -> keeps hN.localhost as its own site
    }
  }
  if (memo.size > 10000) memo.clear();
  memo.set(h, out);
  return out;
}

export function siteOfUrl(url) {
  const u = String(url || '');
  if (!/^(https?|ftp):/i.test(u)) return INTERNAL_SITE;
  try { return siteOfHost(new URL(u).hostname); } catch { return INTERNAL_SITE; }
}
