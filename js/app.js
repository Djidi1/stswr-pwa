const form = document.getElementById('lookup-form');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const resultsEl = document.getElementById('results');
const resultsBody = document.getElementById('results-body');
const resultsHeader = document.getElementById('results-header');
const searchBtn = document.getElementById('search-btn');
const addressInput = document.getElementById('address');
const municipalitySelect = document.getElementById('municipality');
const ratingsInfoEl = document.getElementById('ratings-info');
const ratingsDot = document.getElementById('ratings-dot');
const ratingsPill = document.getElementById('ratings-pill');
const installBanner = document.getElementById('install-banner');
const installBtn = document.getElementById('install-btn');
const installDismiss = document.getElementById('install-dismiss');
const progressSteps = document.getElementById('progress-steps');

// Restore persisted state
const savedAddress = localStorage.getItem('lastAddress');
const savedMunicipality = localStorage.getItem('lastMunicipality');
const savedResults = localStorage.getItem('lastResults');

if (savedAddress) addressInput.value = savedAddress;
if (savedMunicipality) municipalitySelect.value = savedMunicipality;
if (savedResults) {
  try { showResults(JSON.parse(savedResults)); } catch (e) {}
}

// Ratings — auto-fetch if missing, otherwise show status
initRatings();

async function initRatings() {
  const status = getRatingsStatus();
  if (status.lastUpdated) {
    setRatingsLoaded(status.count);
  } else {
    setRatingsLoading();
    try {
      const result = await fetchRatingsFromProxy();
      setRatingsLoaded(result.count);
    } catch (err) {
      setRatingsError();
    }
  }
}

function setRatingsLoaded(count) {
  ratingsDot.className = 'dot loaded';
  ratingsInfoEl.textContent = `${count.toLocaleString()} schools rated`;
}

function setRatingsLoading() {
  ratingsDot.className = 'dot loading';
  ratingsInfoEl.textContent = 'Loading ratings...';
}

function setRatingsError() {
  ratingsDot.className = 'dot';
  ratingsInfoEl.textContent = 'Ratings unavailable';
}

// Ratings refresh
const refreshRatingsBtn = document.getElementById('refresh-ratings-btn');
refreshRatingsBtn.addEventListener('click', async () => {
  document.getElementById('menu-dropdown').classList.add('hidden');
  refreshRatingsBtn.disabled = true;
  setRatingsLoading();
  try {
    const result = await fetchRatingsFromProxy();
    setRatingsLoaded(result.count);
  } catch (err) {
    setRatingsError();
  } finally {
    refreshRatingsBtn.disabled = false;
  }
});

function parseAddress(input) {
  const parts = input.trim().split(/\s+/);
  const number = parts[0];
  const name = parts.slice(1).join(' ');
  return { number, name };
}

// Form submit
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const raw = addressInput.value.trim();
  const municipality = municipalitySelect.value;

  if (!raw || !municipality) return;

  const { number, name } = parseAddress(raw);
  if (!number || !name) {
    showError('Enter street number and name (e.g. "100 Victoria")');
    return;
  }

  localStorage.setItem('lastAddress', raw);
  localStorage.setItem('lastMunicipality', municipality);

  showLoading();

  try {
    const results = await performLookup(number, name, municipality, addProgressStep);
    addProgressStep('Matching school ratings...');
    const enriched = enrichWithRatings(results, municipality);
    showResults(enriched);
  } catch (err) {
    showError(err.message);
  }
});

// Install prompt
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBanner.classList.remove('hidden');
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBanner.classList.add('hidden');
});

installDismiss.addEventListener('click', () => {
  installBanner.classList.add('hidden');
});

// UI helpers
function showLoading() {
  loadingEl.classList.remove('hidden');
  errorEl.classList.add('hidden');
  resultsEl.classList.add('hidden');
  progressSteps.innerHTML = '';
  searchBtn.disabled = true;
}

function addProgressStep(text) {
  const prev = progressSteps.querySelector('li.active');
  if (prev) {
    prev.classList.remove('active');
    prev.classList.add('done');
  }
  const li = document.createElement('li');
  li.textContent = text;
  li.classList.add('active');
  progressSteps.appendChild(li);
}

function showError(message) {
  loadingEl.classList.add('hidden');
  errorEl.classList.remove('hidden');
  resultsEl.classList.add('hidden');
  errorEl.textContent = message;
  searchBtn.disabled = false;
}

function showResults(results) {
  loadingEl.classList.add('hidden');
  errorEl.classList.add('hidden');
  searchBtn.disabled = false;

  if (!results || results.length === 0) {
    showError('No schools found for this address.');
    return;
  }

  localStorage.setItem('lastResults', JSON.stringify(results));

  resultsHeader.textContent = `${results.length} school${results.length === 1 ? '' : 's'} found`;
  resultsBody.innerHTML = '';

  results.forEach((school, i) => {
    const card = document.createElement('div');
    card.className = 'school-card';
    card.style.animationDelay = `${i * 0.05}s`;

    const ratingHtml = buildRatingPill(school);
    const typeLower = (school.type || 'elementary').toLowerCase();
    const badgeClass = typeLower === 'secondary' ? 'type-badge secondary' : 'type-badge';

    card.innerHTML = `
      <div class="school-info">
        <div class="school-name">${escapeHtml(school.name)}</div>
        <div class="school-meta">
          <span class="${badgeClass}">${escapeHtml(school.type || 'Elementary')}</span>
          <span class="sep">&middot;</span>
          <span>${escapeHtml(school.district)}</span>
          ${school.city ? `<span class="sep">&middot;</span><span>${escapeHtml(school.city)}</span>` : ''}
        </div>
      </div>
      ${ratingHtml}
    `;
    resultsBody.appendChild(card);
  });

  resultsEl.classList.remove('hidden');
}

function buildRatingPill(school) {
  const { rating, sid, schoolType } = school;

  if (!rating) {
    return '<div class="rating-pill none">—</div>';
  }

  const num = parseFloat(rating);
  let colorClass = 'mid';
  if (num >= 7) colorClass = 'high';
  else if (num < 5) colorClass = 'low';

  const display = `${num}/10`;

  if (sid) {
    const url = `https://www.compareschoolrankings.org/school/on/${encodeURIComponent(schoolType || 'elementary')}/${encodeURIComponent(sid)}`;
    return `<div class="rating-pill ${colorClass}"><a href="${url}" target="_blank" rel="noopener">${display}</a></div>`;
  }

  return `<div class="rating-pill ${colorClass}">${display}</div>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
