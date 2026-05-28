const ALLOWED_HOST = 'bpweb.stswr.ca';
const BASE_URL = 'https://bpweb.stswr.ca';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // /lookup endpoint: performs the full session-aware lookup
    if (url.pathname === '/lookup') {
      return handleLookup(request);
    }

    // /autocomplete endpoint: session-aware street name autocomplete
    if (url.pathname === '/autocomplete') {
      return handleAutocomplete(request);
    }

    // /ratings endpoint: fetches school ratings from compareschoolrankings.org
    if (url.pathname === '/ratings') {
      return handleRatings();
    }

    // Generic proxy passthrough for autocomplete etc.
    const targetUrl = decodeURIComponent(url.pathname.slice(1));
    if (!targetUrl) {
      return new Response('Missing target URL', { status: 400, headers: corsHeaders() });
    }

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return new Response('Invalid target URL', { status: 400, headers: corsHeaders() });
    }

    if (parsed.hostname !== ALLOWED_HOST) {
      return new Response('Forbidden host', { status: 403, headers: corsHeaders() });
    }

    try {
      const headers = buildUpstreamHeaders();
      headers.set('Referer', `${parsed.origin}/`);
      headers.set('Origin', parsed.origin);
      const ct = request.headers.get('content-type');
      if (ct) headers.set('Content-Type', ct);

      let body = null;
      if (request.method === 'POST') {
        body = await request.text();
        headers.set('Content-Length', new TextEncoder().encode(body).length.toString());
      }

      const resp = await fetch(parsed.href, {
        method: request.method,
        headers,
        body,
        redirect: 'follow'
      });

      const respBody = await resp.text();
      const responseHeaders = corsHeaders();
      responseHeaders.set('Content-Type', resp.headers.get('Content-Type') || 'text/html');
      return new Response(respBody, { status: resp.status, headers: responseHeaders });
    } catch (err) {
      return errorResponse(err.message);
    }
  }
};

async function handleLookup(request) {
  try {
    const { streetNumber, streetName, municipality, district } = await request.json();
    let cookieJar = {};

    // Step 1: GET the page to get cookies + viewstate
    const pageResult = await fetchFollowRedirects(`${BASE_URL}/Eligibility`, {
      method: 'GET',
      headers: buildUpstreamHeaders()
    }, cookieJar);

    const pageHtml = pageResult.body;
    cookieJar = pageResult.cookies;

    const viewState = extractHidden(pageHtml, '__VIEWSTATE');
    const viewStateGenerator = extractHidden(pageHtml, '__VIEWSTATEGENERATOR');
    const eventValidation = extractHidden(pageHtml, '__EVENTVALIDATION');

    if (!viewState || !eventValidation) {
      return jsonResponse({ error: 'Could not extract form tokens' }, 502);
    }

    // Resolve actual city value from the page's dropdown
    const cityValue = extractDropdownValue(pageHtml, 'MainContent_eaSchool_ddlCity', municipality);

    // Step 2: POST the form with session cookies
    const formData = buildFormData({
      viewState, viewStateGenerator, eventValidation,
      streetNumber, streetName, municipality: cityValue || municipality, district
    });

    const submitHeaders = buildUpstreamHeaders();
    submitHeaders.set('Content-Type', 'application/x-www-form-urlencoded');
    const body = formData.toString();
    submitHeaders.set('Content-Length', new TextEncoder().encode(body).length.toString());

    const submitResult = await fetchFollowRedirects(`${BASE_URL}/Eligibility`, {
      method: 'POST',
      headers: submitHeaders,
      body
    }, cookieJar);

    const resultHtml = submitResult.body;
    cookieJar = submitResult.cookies;

    // Step 3: Secondary lookup (grade 9) using result page's viewstate
    const vs2 = extractHidden(resultHtml, '__VIEWSTATE');
    const vsg2 = extractHidden(resultHtml, '__VIEWSTATEGENERATOR');
    const ev2 = extractHidden(resultHtml, '__EVENTVALIDATION');

    let secondaryHtml = '';
    if (vs2 && ev2) {
      const cityValue2 = extractDropdownValue(resultHtml, 'MainContent_eaSchool_ddlCity', municipality) || cityValue || municipality;
      const secFormData = buildFormData({
        viewState: vs2, viewStateGenerator: vsg2, eventValidation: ev2,
        streetNumber, streetName, municipality: cityValue2, district,
        grade: 'a85cd392-045a-47c3-b121-04d7efdae5ab'
      });

      const secHeaders = buildUpstreamHeaders();
      secHeaders.set('Content-Type', 'application/x-www-form-urlencoded');
      const secBody = secFormData.toString();
      secHeaders.set('Content-Length', new TextEncoder().encode(secBody).length.toString());

      try {
        const secResult = await fetchFollowRedirects(`${BASE_URL}/Eligibility`, {
          method: 'POST',
          headers: secHeaders,
          body: secBody
        }, cookieJar);
        secondaryHtml = secResult.body;
      } catch {}
    }

    return jsonResponse({ elementaryHtml: resultHtml, secondaryHtml });
  } catch (err) {
    return errorResponse(err.message);
  }
}

async function handleAutocomplete(request) {
  try {
    const { prefixText, count, contextKey } = await request.json();
    let cookieJar = {};

    // Establish session by visiting the page first (follows redirects, collects cookies)
    const pageResult = await fetchFollowRedirects(`${BASE_URL}/Eligibility`, {
      method: 'GET',
      headers: buildUpstreamHeaders()
    }, cookieJar);
    cookieJar = pageResult.cookies;

    // Build headers that mimic a real browser AJAX call from the page
    const headers = new Headers();
    headers.set('Host', ALLOWED_HOST);
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    headers.set('Accept', 'application/json, text/javascript, */*; q=0.01');
    headers.set('Accept-Language', 'en-CA,en;q=0.9');
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Referer', `${BASE_URL}/Eligibility`);
    headers.set('Origin', BASE_URL);
    headers.set('X-Requested-With', 'XMLHttpRequest');
    headers.set('Cache-Control', 'no-cache');
    headers.set('Pragma', 'no-cache');
    const cookieStr = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookieStr) headers.set('Cookie', cookieStr);

    const body = JSON.stringify({ prefixText, count: count || 100, contextKey });
    headers.set('Content-Length', new TextEncoder().encode(body).length.toString());

    const resp = await fetch(`${BASE_URL}/Eligibility.aspx/GetCompletionList`, {
      method: 'POST',
      headers,
      body
    });

    const respBody = await resp.text();
    const responseHeaders = corsHeaders();
    responseHeaders.set('Content-Type', resp.headers.get('Content-Type') || 'application/json');
    return new Response(respBody, { status: resp.status, headers: responseHeaders });
  } catch (err) {
    return errorResponse('Autocomplete failed: ' + err.message);
  }
}

async function handleRatings() {
  try {
    const ht = btoa(Math.ceil(.001 * Date.now() / 60 / 60 / 2 + 12).toString(16)).replace(/=/g, '');
    const apiUrl = `https://www.compareschoolrankings.org/api/v1/schools.json?province=on&ht=${ht}`;

    const resp = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://www.compareschoolrankings.org/'
      }
    });

    if (!resp.ok) {
      return jsonResponse({ error: `Upstream returned ${resp.status}` }, 502);
    }

    const encrypted = await resp.text();
    const fingerprint = encrypted.substr(0, 4);
    const ciphertext = encrypted.substr(4);

    const key = await deriveRatingsKey(fingerprint);
    if (!key) {
      return jsonResponse({ error: 'Could not derive decryption key' }, 502);
    }

    const decrypted = await aesDecrypt(ciphertext, key);
    if (!decrypted) {
      return jsonResponse({ error: 'Decryption failed' }, 502);
    }

    const parsed = JSON.parse(decrypted);
    const schools = Array.isArray(parsed) ? parsed : parsed.data;
    if (!Array.isArray(schools)) {
      return jsonResponse({ error: 'Unexpected data structure' }, 502);
    }
    const filtered = schools
      .filter(s => s.sid && s.title)
      .map(s => {
        const info = s.schoolInfoData || {};
        const years = Object.keys(info).filter(k => /^\d{4}$/.test(k)).sort();
        const latestYear = years[years.length - 1];
        return {
          sid: s.sid,
          name: s.title,
          type: s.schoolType || 'elementary',
          rating: latestYear ? info[latestYear] : null,
          rank: info['Rank This Yr'] || null,
          city: info['SchoolCity'] || null
        };
      });

    return jsonResponse({ lastUpdated: new Date().toISOString().split('T')[0], schools: filtered });
  } catch (err) {
    return errorResponse('Ratings fetch failed: ' + err.message);
  }
}

async function deriveRatingsKey(fingerprint) {
  for (const offset of [0, -1, -2, -3, 1, 2]) {
    const t = parseInt(Math.ceil(.001 * Date.now() / 60 / 60 / 6)) + offset;
    const raw = 'sr_encrypt' + t.toString() + parseInt(Math.ceil(125 * Math.sin(t))).toString() + parseInt(Math.ceil(375 * Math.cos(t))).toString() + (t << 5).toString() + (3 | t).toString();
    const key = (await sha1hex(raw)).substr(0, 32);
    const check = (await sha1hex(key)).substr(10, 4);
    if (check === fingerprint) {
      return key;
    }
  }
  return null;
}

async function sha1hex(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function aesDecrypt(ciphertext, passphrase) {
  const raw = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));

  if (raw.length < 16) return null;
  const prefix = new TextDecoder().decode(raw.slice(0, 8));
  if (prefix !== 'Salted__') return null;

  const salt = raw.slice(8, 16);
  const ct = raw.slice(16);

  // EVP_BytesToKey: derive 32-byte key + 16-byte IV from passphrase + salt using MD5
  const passBytes = new TextEncoder().encode(passphrase);
  let derived = new Uint8Array(0);
  let block = new Uint8Array(0);
  while (derived.length < 48) {
    const input = new Uint8Array(block.length + passBytes.length + salt.length);
    input.set(block); input.set(passBytes, block.length); input.set(salt, block.length + passBytes.length);
    block = md5Bytes(input);
    const newDerived = new Uint8Array(derived.length + block.length);
    newDerived.set(derived); newDerived.set(block, derived.length);
    derived = newDerived;
  }

  const key = await crypto.subtle.importKey('raw', derived.slice(0, 32), 'AES-CBC', false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: derived.slice(32, 48) }, key, ct);
  return new TextDecoder().decode(decrypted);
}

function md5Bytes(input) {
  // MD5 that returns Uint8Array(16)
  function safeAdd(x, y) { const lsw = (x & 0xffff) + (y & 0xffff); return ((x >> 16) + (y >> 16) + (lsw >> 16)) << 16 | lsw & 0xffff; }
  function bitRotateLeft(num, cnt) { return num << cnt | num >>> 32 - cnt; }
  function md5cmn(q, a, b, x, s, t) { return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function md5ff(a, b, c, d, x, s, t) { return md5cmn(b & c | ~b & d, a, b, x, s, t); }
  function md5gg(a, b, c, d, x, s, t) { return md5cmn(b & d | c & ~d, a, b, x, s, t); }
  function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
  function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }

  const x = [];
  for (let i = 0; i < input.length * 8; i += 8) x[i >> 5] |= input[i / 8] << i % 32;
  x[input.length * 8 >> 5] |= 0x80 << input.length * 8 % 32;
  x[(input.length * 8 + 64 >>> 9 << 4) + 14] = input.length * 8;

  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const olda = a, oldb = b, oldc = c, oldd = d;
    a = md5ff(a, b, c, d, x[i], 7, -680876936); d = md5ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = md5ff(c, d, a, b, x[i + 2], 17, 606105819); b = md5ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = md5ff(a, b, c, d, x[i + 4], 7, -176418897); d = md5ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = md5ff(c, d, a, b, x[i + 6], 17, -1473231341); b = md5ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = md5ff(a, b, c, d, x[i + 8], 7, 1770035416); d = md5ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = md5ff(c, d, a, b, x[i + 10], 17, -42063); b = md5ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = md5ff(a, b, c, d, x[i + 12], 7, 1804603682); d = md5ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = md5ff(c, d, a, b, x[i + 14], 17, -1502002290); b = md5ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = md5gg(a, b, c, d, x[i + 1], 5, -165796510); d = md5gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = md5gg(c, d, a, b, x[i + 11], 14, 643717713); b = md5gg(b, c, d, a, x[i], 20, -373897302);
    a = md5gg(a, b, c, d, x[i + 5], 5, -701558691); d = md5gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = md5gg(c, d, a, b, x[i + 15], 14, -660478335); b = md5gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = md5gg(a, b, c, d, x[i + 9], 5, 568446438); d = md5gg(d, a, b, c, x[i + 14], 9, -1019803690);
    c = md5gg(c, d, a, b, x[i + 3], 14, -187363961); b = md5gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = md5gg(a, b, c, d, x[i + 13], 5, -1444681467); d = md5gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = md5gg(c, d, a, b, x[i + 7], 14, 1735328473); b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = md5hh(a, b, c, d, x[i + 5], 4, -378558); d = md5hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = md5hh(c, d, a, b, x[i + 11], 16, 1839030562); b = md5hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = md5hh(a, b, c, d, x[i + 1], 4, -1530992060); d = md5hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = md5hh(c, d, a, b, x[i + 7], 16, -155497632); b = md5hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = md5hh(a, b, c, d, x[i + 13], 4, 681279174); d = md5hh(d, a, b, c, x[i + 0], 11, -358537222);
    c = md5hh(c, d, a, b, x[i + 3], 16, -722521979); b = md5hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = md5hh(a, b, c, d, x[i + 9], 4, -640364487); d = md5hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = md5hh(c, d, a, b, x[i + 15], 16, 530742520); b = md5hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = md5ii(a, b, c, d, x[i], 6, -198630844); d = md5ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = md5ii(c, d, a, b, x[i + 14], 15, -1416354905); b = md5ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = md5ii(a, b, c, d, x[i + 12], 6, 1700485571); d = md5ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = md5ii(c, d, a, b, x[i + 10], 15, -1051523); b = md5ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = md5ii(a, b, c, d, x[i + 8], 6, 1873313359); d = md5ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = md5ii(c, d, a, b, x[i + 6], 15, -1560198380); b = md5ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = md5ii(a, b, c, d, x[i + 4], 6, -145523070); d = md5ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = md5ii(c, d, a, b, x[i + 2], 15, 718787259); b = md5ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = safeAdd(a, olda); b = safeAdd(b, oldb); c = safeAdd(c, oldc); d = safeAdd(d, oldd);
  }

  const result = new Uint8Array(16);
  [a, b, c, d].forEach((v, i) => { result[i*4] = v & 0xff; result[i*4+1] = (v >> 8) & 0xff; result[i*4+2] = (v >> 16) & 0xff; result[i*4+3] = (v >> 24) & 0xff; });
  return result;
}


async function fetchFollowRedirects(url, options, cookieJar, maxRedirects = 5) {
  let currentUrl = url;
  let currentOptions = { ...options };
  let jar = { ...cookieJar };

  for (let i = 0; i <= maxRedirects; i++) {
    const headers = new Headers(currentOptions.headers || {});
    const cookieStr = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookieStr) headers.set('Cookie', cookieStr);

    const isRedirectFollowUp = i > 0;
    const resp = await fetch(currentUrl, {
      ...currentOptions,
      headers,
      body: isRedirectFollowUp ? undefined : currentOptions.body,
      method: isRedirectFollowUp ? 'GET' : currentOptions.method,
      redirect: 'manual'
    });

    mergeCookies(jar, resp.headers);

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('Location');
      if (!location) break;
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }

    return { body: await resp.text(), cookies: jar, status: resp.status };
  }

  throw new Error('Too many redirects');
}

function mergeCookies(jar, headers) {
  const raw = headers.getAll ? headers.getAll('set-cookie') : [];
  const cookieHeaders = raw.length > 0 ? raw : (headers.get('set-cookie') || '').split(',');
  for (const cookie of cookieHeaders) {
    if (!cookie.trim()) continue;
    const nameValue = cookie.split(';')[0].trim();
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx > 0) {
      jar[nameValue.slice(0, eqIdx)] = nameValue.slice(eqIdx + 1);
    }
  }
}

function buildFormData({ viewState, viewStateGenerator, eventValidation, streetNumber, streetName, municipality, district, grade }) {
  const formData = new URLSearchParams();
  formData.set('__VIEWSTATE', viewState);
  formData.set('__VIEWSTATEGENERATOR', viewStateGenerator || '');
  formData.set('__VIEWSTATEENCRYPTED', '');
  formData.set('__EVENTVALIDATION', eventValidation);
  formData.set('__EVENTTARGET', '');
  formData.set('__EVENTARGUMENT', '');
  formData.set('__LASTFOCUS', '');
  formData.set('ctl00$hfApplicationRoot', '/');
  formData.set('ctl00$hfDateFormat', 'yy-mm-dd');
  formData.set('ctl00$MainContent$eaSchool$txtStreetNumber', streetNumber);
  formData.set('ctl00$MainContent$eaSchool$meeStreetNumber_ClientState', '');
  formData.set('ctl00$MainContent$eaSchool$txtStreetName', streetName);
  formData.set('ctl00$MainContent$eaSchool$ddlCity', municipality);
  formData.set('ctl00$MainContent$eaSchool$hfPostCode', '');
  formData.set('ctl00$MainContent$eaSchool$ddlDistrict', district);
  if (grade) {
    formData.set('ctl00$MainContent$eaSchool$ddlGrade', grade);
  }
  formData.set('ctl00$_cbDatabase', '16f9713c-1b82-45f8-9b85-376db865fb68');
  formData.set('ctl00$ddlLanguages', 'en-CA');
  formData.set('ctl00$cbDefaultDatabase', '16f9713c-1b82-45f8-9b85-376db865fb68');
  formData.set('hiddenInputToUpdateATBuffer_CommonToolkitScripts', '1');
  formData.set('ctl00$MainContent$btnSubmit', 'Submit');
  return formData;
}

function extractHidden(html, name) {
  const regex = new RegExp(`id="${name}"[^>]*value="([^"]*)"`, 'i');
  const match = html.match(regex);
  return match ? match[1] : null;
}

function extractDropdownValue(html, selectId, targetCity) {
  const selectRegex = new RegExp(`id="${selectId}"[^>]*>([\\s\\S]*?)</select>`, 'i');
  const selectMatch = html.match(selectRegex);
  if (!selectMatch) return null;

  const optionRegex = /value="([^"]*)"/gi;
  const options = [];
  let m;
  while ((m = optionRegex.exec(selectMatch[1])) !== null) {
    options.push(m[1]);
  }

  const upper = targetCity.toUpperCase();
  return options.find(o => o.toUpperCase() === upper) || options.find(o => o.toUpperCase().includes(upper)) || null;
}


function buildUpstreamHeaders() {
  const headers = new Headers();
  headers.set('Host', ALLOWED_HOST);
  headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8');
  headers.set('Accept-Language', 'en-CA,en;q=0.9');
  return headers;
}

function corsHeaders() {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return headers;
}

function jsonResponse(data, status = 200) {
  const headers = corsHeaders();
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(message) {
  const headers = corsHeaders();
  headers.set('Content-Type', 'text/plain');
  return new Response(`Proxy error: ${message}`, { status: 502, headers });
}
