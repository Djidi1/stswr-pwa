function normalizeSchoolName(name) {
  return name
    .toLowerCase()
    .replace(/\b(catholic|public|separate|elementary|secondary|school|collegiate|institute|academy|s\.s\.|ss|p\.s\.|ps|c\.s\.|cs|c\.e\.s\.|ces)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const WATERLOO_REGION_CITIES = new Set([
  'waterloo', 'kitchener', 'cambridge', 'elmira', 'ayr', 'baden',
  'breslau', 'conestogo', 'heidelberg', 'new hamburg', 'st. jacobs',
  'wellesley', 'woolwich', 'wilmot', 'north dumfries', 'st. clements',
  'linwood', 'maryhill', 'bloomingdale', 'new dundee', 'petersburg',
  'mannheim', 'crosshill', 'hawkesville', 'wallenstein', 'west montrose'
]);

function isWaterlooRegion(city) {
  return !city || WATERLOO_REGION_CITIES.has(city.toLowerCase().trim());
}

function findRatings(schoolName, cachedSchools) {
  const normalized = normalizeSchoolName(schoolName);
  const words = normalized.split(' ').filter(w => w.length > 2);
  const regional = cachedSchools.filter(s => isWaterlooRegion(s.city));

  const exact = regional.filter(s => normalizeSchoolName(s.name) === normalized);
  if (exact.length > 0) return exact;

  const wordMatch = regional.filter(s => {
    const cachedNorm = normalizeSchoolName(s.name);
    const cachedWords = cachedNorm.split(' ').filter(w => w.length > 2);
    const shorter = words.length <= cachedWords.length ? words : cachedWords;
    const longer = words.length > cachedWords.length ? words : cachedWords;
    return shorter.length > 0 && shorter.every(w => longer.includes(w));
  });
  if (wordMatch.length > 0) return wordMatch;

  const similar = [];
  for (const s of regional) {
    const score = bigramSimilarity(normalized, normalizeSchoolName(s.name));
    if (score > 0.7) {
      similar.push({ ...s, _score: score });
    }
  }
  similar.sort((a, b) => b._score - a._score);
  return similar;
}

function bigramSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigramsA = new Set();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
  let matches = 0;
  for (let i = 0; i < b.length - 1; i++) {
    if (bigramsA.has(b.slice(i, i + 2))) matches++;
  }
  return (2 * matches) / (a.length - 1 + b.length - 1);
}

function enrichWithRatings(results) {
  const raw = localStorage.getItem('schoolRatings');
  if (!raw) {
    return results.map(r => ({ ...r, rating: null, rank: null, sid: null, schoolType: null, city: null }));
  }

  const data = JSON.parse(raw);
  if (!data.schools) {
    return results.map(r => ({ ...r, rating: null, rank: null, sid: null, schoolType: null, city: null }));
  }

  const cached = data.schools;
  const enriched = [];
  for (const result of results) {
    const matches = findRatings(result.name, cached);
    if (matches.length === 0) {
      enriched.push({ ...result, rating: null, rank: null, sid: null, schoolType: null, city: null });
    } else {
      for (const match of matches) {
        enriched.push({
          ...result,
          rating: match.rating,
          rank: match.rank,
          sid: match.sid,
          schoolType: match.type,
          city: match.city
        });
      }
    }
  }
  return enriched;
}

function importRatingsFromJSON(jsonString) {
  const data = JSON.parse(jsonString);
  if (!data.schools || !Array.isArray(data.schools)) {
    throw new Error('Invalid format: expected { "schools": [...] }');
  }
  const ratingsData = {
    lastUpdated: new Date().toISOString().split('T')[0],
    schools: data.schools
  };
  localStorage.setItem('schoolRatings', JSON.stringify(ratingsData));
  return { count: data.schools.length, lastUpdated: ratingsData.lastUpdated };
}

function getRatingsStatus() {
  const raw = localStorage.getItem('schoolRatings');
  if (!raw) return { lastUpdated: null, count: 0 };
  const data = JSON.parse(raw);
  return { lastUpdated: data.lastUpdated, count: data.schools ? data.schools.length : 0 };
}
