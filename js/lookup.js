const PROXY_PREFIX = 'https://stswr-proxy.djidi1.workers.dev/';

const TARGET_URL = 'https://bpweb.stswr.ca/Eligibility';

const DISTRICTS = [
  { value: 'WCDSB', name: 'Waterloo Catholic District School Board' },
  { value: 'WRDSB', name: 'Waterloo Region District School Board' }
];

const SCHOOL_YEAR_GUID = '16f9713c-1b82-45f8-9b85-376db865fb68';
const GRADE_09_GUID = 'a85cd392-045a-47c3-b121-04d7efdae5ab';

async function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const needsProxy = PROXY_PREFIX && !url.startsWith(PROXY_PREFIX);
    const target = needsProxy ? PROXY_PREFIX + encodeURIComponent(url) : url;
    return await fetch(target, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

async function performLookup(streetNumber, streetName, municipality, onProgress) {
  onProgress('Resolving street name...');
  const resolvedStreet = await resolveStreetName(streetName, municipality);
  if (!resolvedStreet) throw new Error('Could not resolve street name from autocomplete');
  onProgress(`Street resolved: ${resolvedStreet}`);

  const allResults = [];
  for (const district of DISTRICTS) {
    onProgress(`Looking up ${district.name}...`);
    const results = await lookupDistrict(streetNumber, resolvedStreet, municipality, district);
    allResults.push(...results);
  }
  return allResults;
}

async function resolveStreetName(streetName, municipality) {
  const items = await queryAutocomplete(streetName, municipality);
  if (items.length > 0) return pickBestMatch(streetName, items);

  const words = streetName.trim().split(/\s+/);
  for (let len = words.length - 1; len >= 1; len--) {
    const prefix = words.slice(0, len).join(' ');
    const retry = await queryAutocomplete(prefix, municipality);
    if (retry.length > 0) return pickBestMatch(streetName, retry);
  }

  return null;
}

async function queryAutocomplete(prefix, municipality) {
  const resp = await fetchWithTimeout(PROXY_PREFIX + 'autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      prefixText: prefix,
      count: 100,
      contextKey: municipality.toUpperCase()
    })
  });
  if (!resp.ok) throw new Error('Autocomplete request failed');
  const data = await resp.json();
  return data.d || [];
}

function pickBestMatch(streetName, items) {
  const upper = streetName.toUpperCase();
  return items.find(i => i.toUpperCase() === upper)
    || items.find(i => i.toUpperCase().startsWith(upper))
    || items.find(i => i.toUpperCase().includes(upper))
    || items.find(i => upper.includes(i.toUpperCase()))
    || items[0];
}

async function lookupDistrict(streetNumber, streetName, municipality, district) {
  const lookupUrl = PROXY_PREFIX + 'lookup';
  const resp = await fetchWithTimeout(lookupUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ streetNumber, streetName, municipality, district: district.value })
  });

  if (!resp.ok) throw new Error(`Lookup failed for ${district.value}`);
  const data = await resp.json();

  if (data.error) throw new Error(data.error);

  const elementaryResults = parseResults(data.elementaryHtml || '', district);
  const secondaryResults = parseResults(data.secondaryHtml || '', district);

  return [...elementaryResults, ...secondaryResults];
}

function parseResults(html, district) {
  const jsonMatch = html.match(/SchoolPositions\s*=\s*JSON\.parse\('(.+?)'\);/);
  if (jsonMatch) {
    try {
      const cleaned = jsonMatch[1].replace(/\\"/g, '"');
      const parsed = JSON.parse(cleaned);
      const schools = Array.isArray(parsed[0]) ? parsed.flat() : parsed;
      return schools.map(s => ({
        name: s.Name ? s.Name.replace(/\s*\(\d{3}-\d{3}-\d{4}\)\s*$/, '').trim() : 'Unknown',
        type: s.GradeSchoolType || inferType(s),
        district: district.value
      }));
    } catch (e) { console.warn('SchoolPositions JSON parse failed, using HTML fallback', e); }
  }

  return parseResultsFromHtml(html, district);
}

function parseResultsFromHtml(html, district) {
  const results = [];
  const linkRegex = /id="MainContent_repSchoolDetail_hlSchoolName_(\d+)"[^>]*>([^<]+)</g;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const rawName = match[2].trim();
    const name = rawName.replace(/\s*\(\d{3}-\d{3}-\d{4}\)\s*$/, '').trim();

    let type = 'Elementary';
    const lower = name.toLowerCase();
    if (lower.includes('secondary') || lower.includes('collegiate') || lower.includes('high school')) {
      type = 'Secondary';
    }

    results.push({ name, type, district: district.value });
  }

  const gradeRegex = /id="MainContent_repSchoolDetail_rBoundary_0_lblGradeList_(\d+)"[^>]*>([^<]+)</g;
  while ((match = gradeRegex.exec(html)) !== null) {
    const idx = parseInt(match[1], 10);
    if (idx < results.length && results[idx].type === 'Elementary') {
      const grades = match[2].trim();
      const hasHigh = grades.split(',').some(g => parseInt(g, 10) >= 9);
      if (hasHigh) results[idx].type = 'Secondary';
    }
  }

  return results;
}

function inferType(school) {
  if (school.GradeSchoolType) return school.GradeSchoolType;
  const lower = (school.Name || '').toLowerCase();
  if (lower.includes('secondary') || lower.includes('collegiate') || lower.includes('high school')) {
    return 'Secondary';
  }
  if (school.Grades && school.Grades.some(g => parseInt(g, 10) >= 9)) {
    return 'Secondary';
  }
  return 'Elementary';
}

function extractHidden(html, name) {
  const regex = new RegExp(`id="${name}"[^>]*value="([^"]*)"`, 'i');
  const match = html.match(regex);
  return match ? match[1] : null;
}
