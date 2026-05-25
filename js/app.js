const form = document.getElementById('lookup-form');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const resultsEl = document.getElementById('results');
const resultsBody = document.getElementById('results-body');
const searchBtn = document.getElementById('search-btn');
const streetNumberInput = document.getElementById('street-number');
const streetNameInput = document.getElementById('street-name');
const municipalityInput = document.getElementById('municipality');
const ratingsInfoEl = document.getElementById('ratings-info');
const ratingsFileInput = document.getElementById('ratings-file');
const installBanner = document.getElementById('install-banner');
const installBtn = document.getElementById('install-btn');
const installDismiss = document.getElementById('install-dismiss');
const progressSteps = document.getElementById('progress-steps');

// Restore persisted state
const savedNumber = localStorage.getItem('lastStreetNumber');
const savedName = localStorage.getItem('lastStreetName');
const savedMunicipality = localStorage.getItem('lastMunicipality');
const savedResults = localStorage.getItem('lastResults');

if (savedNumber) streetNumberInput.value = savedNumber;
if (savedName) streetNameInput.value = savedName;
if (savedMunicipality) municipalityInput.value = savedMunicipality;
if (savedResults) {
  try { showResults(JSON.parse(savedResults)); } catch (e) {}
}

// Ratings status
const status = getRatingsStatus();
if (status.lastUpdated) {
  ratingsInfoEl.textContent = `Ratings: ${status.count} schools (${status.lastUpdated})`;
}

// Ratings import
ratingsFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const result = importRatingsFromJSON(reader.result);
      ratingsInfoEl.textContent = `Ratings: ${result.count} schools (${result.lastUpdated})`;
    } catch (err) {
      ratingsInfoEl.textContent = `Error: ${err.message}`;
    }
  };
  reader.readAsText(file);
  ratingsFileInput.value = '';
});

// Form submit
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const streetNumber = streetNumberInput.value.trim();
  const streetName = streetNameInput.value.trim();
  const municipality = municipalityInput.value.trim();

  if (!streetNumber || !streetName || !municipality) return;

  localStorage.setItem('lastStreetNumber', streetNumber);
  localStorage.setItem('lastStreetName', streetName);
  localStorage.setItem('lastMunicipality', municipality);

  showLoading();

  try {
    const results = await performLookup(streetNumber, streetName, municipality, addProgressStep);
    addProgressStep('Matching school ratings...');
    const enriched = enrichWithRatings(results);
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

  resultsBody.innerHTML = '';
  results.forEach(({ name, type, district, rating, sid, schoolType, city }) => {
    const row = document.createElement('tr');
    let ratingCell;
    if (rating && sid) {
      const url = `https://www.compareschoolrankings.org/school/on/${escapeHtml(schoolType || 'elementary')}/${escapeHtml(sid)}`;
      ratingCell = `<a href="${url}" target="_blank" rel="noopener" class="rating-link">${escapeHtml(String(rating))}/10</a>`;
    } else if (rating) {
      ratingCell = `${escapeHtml(String(rating))}/10`;
    } else {
      ratingCell = '—';
    }
    row.innerHTML = `<td>${escapeHtml(name)}</td><td>${escapeHtml(type)}</td><td>${escapeHtml(district)}</td><td>${escapeHtml(city || '—')}</td><td>${ratingCell}</td>`;
    resultsBody.appendChild(row);
  });

  resultsEl.classList.remove('hidden');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
