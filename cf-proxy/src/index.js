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

    // Step 1: GET the page to get cookies + viewstate
    const pageResp = await fetch(`${BASE_URL}/Eligibility`, {
      method: 'GET',
      headers: buildUpstreamHeaders(),
      redirect: 'follow'
    });

    const cookies = extractCookies(pageResp.headers);
    const pageHtml = await pageResp.text();

    const viewState = extractHidden(pageHtml, '__VIEWSTATE');
    const viewStateGenerator = extractHidden(pageHtml, '__VIEWSTATEGENERATOR');
    const eventValidation = extractHidden(pageHtml, '__EVENTVALIDATION');

    if (!viewState || !eventValidation) {
      return jsonResponse({ error: 'Could not extract form tokens' }, 502);
    }

    // Step 2: POST the form with session cookies
    const formData = buildFormData({
      viewState, viewStateGenerator, eventValidation,
      streetNumber, streetName, municipality, district
    });

    const submitHeaders = buildUpstreamHeaders();
    submitHeaders.set('Content-Type', 'application/x-www-form-urlencoded');
    submitHeaders.set('Cookie', cookies);
    const body = formData.toString();
    submitHeaders.set('Content-Length', new TextEncoder().encode(body).length.toString());

    const submitResp = await fetch(`${BASE_URL}/Eligibility`, {
      method: 'POST',
      headers: submitHeaders,
      body,
      redirect: 'follow'
    });

    const resultHtml = await submitResp.text();
    const resultCookies = extractCookies(submitResp.headers) || cookies;

    // Step 3: Secondary lookup (grade 9) using result page's viewstate
    const vs2 = extractHidden(resultHtml, '__VIEWSTATE');
    const vsg2 = extractHidden(resultHtml, '__VIEWSTATEGENERATOR');
    const ev2 = extractHidden(resultHtml, '__EVENTVALIDATION');

    let secondaryHtml = '';
    if (vs2 && ev2) {
      const secFormData = buildFormData({
        viewState: vs2, viewStateGenerator: vsg2, eventValidation: ev2,
        streetNumber, streetName, municipality, district,
        grade: 'a85cd392-045a-47c3-b121-04d7efdae5ab'
      });

      const secHeaders = buildUpstreamHeaders();
      secHeaders.set('Content-Type', 'application/x-www-form-urlencoded');
      secHeaders.set('Cookie', resultCookies);
      const secBody = secFormData.toString();
      secHeaders.set('Content-Length', new TextEncoder().encode(secBody).length.toString());

      try {
        const secResp = await fetch(`${BASE_URL}/Eligibility`, {
          method: 'POST',
          headers: secHeaders,
          body: secBody,
          redirect: 'follow'
        });
        secondaryHtml = await secResp.text();
      } catch {}
    }

    return jsonResponse({ elementaryHtml: resultHtml, secondaryHtml });
  } catch (err) {
    return errorResponse(err.message);
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
  formData.set('ctl00$MainContent$eaSchool$ddlCity', municipality.toUpperCase());
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

function extractCookies(headers) {
  const all = headers.getAll ? headers.getAll('set-cookie') : [];
  if (all.length === 0) {
    const single = headers.get('set-cookie');
    if (single) return single.split(',').map(c => c.split(';')[0].trim()).join('; ');
    return '';
  }
  return all.map(c => c.split(';')[0]).join('; ');
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
