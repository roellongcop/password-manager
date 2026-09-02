// URL matching. The whole point of this file is that `evil-paypal.com` must never
// match a credential saved for `paypal.com`, so matching is done on the
// registrable domain (eTLD+1) and never on a substring.

// A full Public Suffix List would be ~250KB. This covers the multi-part suffixes
// that actually show up in a personal vault, including the hosting providers where
// each subdomain belongs to a different party.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'asn.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'school.nz',
  'co.za', 'org.za', 'net.za', 'web.za', 'gov.za', 'ac.za',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'lg.jp',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.mx', 'org.mx', 'gob.mx', 'com.ar', 'net.ar', 'org.ar', 'gob.ar',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr',
  'com.sg', 'com.hk', 'com.tw', 'com.my', 'com.ph', 'com.vn', 'com.pk', 'com.bd',
  'co.id', 'or.id', 'ac.id', 'go.id', 'web.id', 'my.id', 'biz.id', 'sch.id',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'edu.in', 'firm.in',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr',
  'co.th', 'in.th', 'ac.th', 'go.th', 'or.th',
  'com.pl', 'net.pl', 'org.pl', 'com.ua', 'net.ua', 'org.ua', 'kiev.ua',
  'co.il', 'org.il', 'ac.il', 'gov.il', 'net.il',
  'com.co', 'com.pe', 'com.ec', 'com.uy', 'com.ve', 'com.bo',
  'com.sa', 'com.eg', 'com.ng', 'com.gh', 'co.ke', 'co.tz', 'co.ug',
  'com.ru', 'net.ru', 'org.ru', 'edu.ru', 'gov.ru',
  'com.es', 'nom.es', 'org.es', 'gob.es', 'com.pt', 'com.gr', 'com.cy',
  // Hosting suffixes where each label belongs to a different owner.
  'github.io', 'gitlab.io', 'pages.dev', 'vercel.app', 'netlify.app', 'netlify.com',
  'herokuapp.com', 'web.app', 'firebaseapp.com', 'glitch.me', 'workers.dev',
  'onrender.com', 'fly.dev', 'azurewebsites.net', 'cloudfront.net', 'appspot.com',
  'blogspot.com', 'wordpress.com', 'myshopify.com', 'zendesk.com', 'freshdesk.com',
  'atlassian.net', 'sharepoint.com', 'onmicrosoft.com', 'notion.site', 'replit.dev',
  'ngrok.io', 'ngrok-free.app', 'ts.net',
]);

export const MATCH_TYPES = Object.freeze([
  { value: 'domain', label: 'Base domain' },
  { value: 'host', label: 'Host and subdomain' },
  { value: 'startsWith', label: 'URL starts with' },
  { value: 'exact', label: 'Exact URL' },
  { value: 'never', label: 'Never' },
]);

export function isIpHost(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

export function parseUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
  try {
    const url = new URL(withScheme);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

export function hostOf(input) {
  const url = parseUrl(input);
  if (!url) return null;
  return url.hostname.toLowerCase().replace(/\.$/, '');
}

// eTLD+1. IP addresses, localhost and single-label hosts come back unchanged.
export function registrableDomain(input) {
  const text = String(input || '');
  const host = text.includes('://') ? hostOf(text) : text.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  if (isIpHost(host) || host === 'localhost') return host;

  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 1) return host;

  // Longest suffix wins, so foo.github.io keeps its own identity.
  for (let suffixLength = 3; suffixLength >= 2; suffixLength--) {
    if (labels.length <= suffixLength) continue;
    const candidate = labels.slice(-suffixLength).join('.');
    if (MULTI_PART_SUFFIXES.has(candidate)) {
      return labels.slice(-(suffixLength + 1)).join('.');
    }
  }
  return labels.slice(-2).join('.');
}

export function sameRegistrableDomain(a, b) {
  const left = registrableDomain(a);
  const right = registrableDomain(b);
  return Boolean(left && right && left === right);
}

export function uriMatches(entry, pageUrl) {
  const matchType = (entry && entry.matchType) || 'domain';
  const savedRaw = typeof entry === 'string' ? entry : entry && entry.uri;
  if (!savedRaw || !pageUrl) return false;
  if (matchType === 'never') return false;

  const page = parseUrl(pageUrl);
  if (!page) return false;

  if (matchType === 'exact') {
    const saved = parseUrl(savedRaw);
    return Boolean(saved) && stripTrailingSlash(saved.href) === stripTrailingSlash(page.href);
  }

  if (matchType === 'startsWith') {
    const saved = parseUrl(savedRaw);
    return Boolean(saved) && page.href.toLowerCase().startsWith(saved.href.toLowerCase());
  }

  if (matchType === 'host') {
    const savedHost = hostOf(savedRaw);
    return Boolean(savedHost) && savedHost === page.hostname.toLowerCase();
  }

  return sameRegistrableDomain(savedRaw, page.href);
}

// Logins and standalone authenticator entries can both be attached to a site;
// notes and cards are never filled, so they never match.
const FILLABLE_TYPES = new Set(['login', 'totp']);

export function itemMatches(item, pageUrl) {
  if (!item || !FILLABLE_TYPES.has(item.type)) return false;
  return (item.uris || []).some((entry) => uriMatches(entry, pageUrl));
}

// Exact host beats base domain, then most recently used. Keeps the right account
// at the top when several are saved for one site.
export function rankMatches(items, pageUrl) {
  const page = parseUrl(pageUrl);
  if (!page) return [];
  const pageHost = page.hostname.toLowerCase();

  return items
    .filter((item) => itemMatches(item, pageUrl))
    .map((item) => {
      const hostHit = (item.uris || []).some((entry) => {
        const savedHost = hostOf(typeof entry === 'string' ? entry : entry.uri);
        return savedHost === pageHost;
      });
      return { item, score: hostHit ? 2 : 1 };
    })
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const usedA = a.item.lastUsedAt || '';
      const usedB = b.item.lastUsedAt || '';
      if (usedA !== usedB) return usedA < usedB ? 1 : -1;
      return (a.item.name || '').localeCompare(b.item.name || '');
    })
    .map((entry) => entry.item);
}

export function stripTrailingSlash(value) {
  return String(value).replace(/\/$/, '').toLowerCase();
}

// Sensible default title for a newly captured credential.
export function suggestedName(pageUrl) {
  const domain = registrableDomain(pageUrl);
  if (!domain) return 'New login';
  const [first] = domain.split('.');
  return first ? first[0].toUpperCase() + first.slice(1) : domain;
}
