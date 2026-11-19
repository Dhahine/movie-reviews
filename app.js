/* ------------------------------------------------------------
   Movie Nights
   - Everything is saved on the device first (IndexedDB), so the app
     works offline.
   - When online, it syncs with a private GitHub repo:
       movies/<id>.json
       reviews/<movieId>/<Name>.json   (each person only writes their own file)
   ------------------------------------------------------------ */
(() => {
  'use strict';

  const C = window.CONFIG;
  const USERS = C.USERS;
  const GH = 'https://api.github.com';
  const repoPath = () => `/repos/${C.GITHUB_OWNER}/${C.DATA_REPO}`;

  /* ---------- small helpers ---------- */
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (t) => t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const fmtTime = (t) => t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never';
  const fmtRating = (n) => String(Math.round(n * 10) / 10);
  const uClass = (name) => 'u' + Math.max(0, USERS.indexOf(name));
  const toB64 = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  };
  const fromB64 = (b64) => {
    const bin = atob(b64.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  };

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  /* ---------- local database (IndexedDB) ---------- */
  let dbPromise;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('movie-nights', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          d.createObjectStore('movies', { keyPath: 'id' });
          d.createObjectStore('reviews', { keyPath: 'key' });
          d.createObjectStore('meta', { keyPath: 'k' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  function tx(store, mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      let result;
      const rq = fn(t.objectStore(store));
      if (rq) rq.onsuccess = () => { result = rq.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }
  const dbGet = (s, k) => tx(s, 'readonly', (o) => o.get(k));
  const dbAll = (s) => tx(s, 'readonly', (o) => o.getAll());
  const dbPut = (s, v) => tx(s, 'readwrite', (o) => o.put(v));
  const getMeta = async (k) => (await dbGet('meta', k))?.v;
  const setMeta = (k, v) => dbPut('meta', { k, v });
  const delMeta = (k) => tx('meta', 'readwrite', (o) => o.delete(k));

  async function pendingCount() {
    const [m, r] = await Promise.all([dbAll('movies'), dbAll('reviews')]);
    return m.filter((x) => x.pending).length + r.filter((x) => x.pending).length;
  }
  async function reviewsFor(movieId) {
    const all = await dbAll('reviews');
    const out = {};
    all.filter((r) => r.movieId === movieId).forEach((r) => { out[r.author] = r; });
    return out;
  }

  /* ---------- rating maths ---------- */
  function overall(rs) {
    const vals = USERS.map((u) => rs[u]?.rating).filter((x) => typeof x === 'number' && !Number.isNaN(x));
    if (vals.length === USERS.length) {
      return { complete: true, value: vals.reduce((a, b) => a + b, 0) / vals.length };
    }
    return { complete: false, value: null, count: vals.length };
  }

  /* ---------- GitHub sync ---------- */
  class SyncError extends Error {
    constructor(message, kind) { super(message); this.kind = kind; }
  }
  let syncing = false;
  let lastError = null;
  let lastAttempt = 0;

  async function ghFetch(path, opts = {}) {
    const token = await getMeta('token');
    let res;
    try {
      res = await fetch(GH + path, {
        cache: 'no-store',
        ...opts,
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': 'Bearer ' + token,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    } catch (e) {
      throw new SyncError('Can’t reach GitHub right now.', 'network');
    }
    if (res.status === 401) throw new SyncError('GitHub rejected the token. Paste a new one in Settings.', 'auth');
    return res;
  }
  async function ghJson(path, opts) {
    const res = await ghFetch(path, opts);
    if (!res.ok) {
      const msg = res.status === 404
        ? `Can’t find ${C.GITHUB_OWNER}/${C.DATA_REPO}. Check that the token has access to that repo.`
        : `GitHub error ${res.status}.`;
      throw new SyncError(msg, 'http' + res.status);
    }
    return res.json();
  }

  const movieFile = (m) => ({
    id: m.id, title: m.title, year: m.year || '', posterPath: m.posterPath || '',
    overview: m.overview || '', addedBy: m.addedBy || '', addedAt: m.addedAt || 0,
  });
  const reviewFile = (r) => ({
    movieId: r.movieId, author: r.author, rating: r.rating, text: r.text || '', updatedAt: r.updatedAt,
  });

  async function putFile(path, obj, sha, message) {
    const body = { message, content: toB64(JSON.stringify(obj, null, 2) + '\n') };
    if (sha) body.sha = sha;
    const res = await ghFetch(`${repoPath()}/contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
    if (res.ok) return { sha: (await res.json()).content.sha };
    if (res.status === 409 || res.status === 422) return { conflict: true };
    if (res.status === 403 || res.status === 404) {
      throw new SyncError('The token can’t write to the repo. It needs “Contents: Read and write”.', 'perm');
    }
    throw new SyncError(`GitHub error ${res.status} while saving.`, 'http' + res.status);
  }
  async function currentSha(path) {
    const res = await ghFetch(`${repoPath()}/contents/${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new SyncError(`GitHub error ${res.status}.`, 'http' + res.status);
    return (await res.json()).sha;
  }

  // Download anything new (or changed) from the repo.
  async function pull(branch) {
    const tree = await ghJson(`${repoPath()}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    const [lm, lr] = await Promise.all([dbAll('movies'), dbAll('reviews')]);
    const movies = new Map(lm.map((x) => [x.id, x]));
    const reviews = new Map(lr.map((x) => [x.key, x]));
    const jobs = [];

    for (const e of tree.tree || []) {
      if (e.type !== 'blob') continue;
      let m;
      if ((m = /^movies\/([^/]+)\.json$/.exec(e.path))) {
        const local = movies.get(m[1]);
        if (local && local.sha === e.sha) continue;
        jobs.push({ kind: 'movie', id: m[1], sha: e.sha });
      } else if ((m = /^reviews\/([^/]+)\/([^/]+)\.json$/.exec(e.path))) {
        const movieId = m[1], author = m[2];
        if (!USERS.includes(author)) continue;
        const key = `${movieId}|${author}`;
        const local = reviews.get(key);
        if (local && local.sha === e.sha) continue;
        if (local && local.pending) {           // my unsent edit wins; just remember the latest remote version
          await dbPut('reviews', { ...local, sha: e.sha });
          continue;
        }
        jobs.push({ kind: 'review', movieId, author, key, sha: e.sha });
      }
    }

    let changed = false;
    for (let i = 0; i < jobs.length; i += 6) {
      await Promise.all(jobs.slice(i, i + 6).map(async (j) => {
        const blob = await ghJson(`${repoPath()}/git/blobs/${j.sha}`);
        let data;
        try { data = JSON.parse(fromB64(blob.content)); } catch (e) { return; }   // skip unreadable files
        if (j.kind === 'movie') {
          await dbPut('movies', {
            id: j.id, title: data.title || 'Untitled', year: data.year || '', posterPath: data.posterPath || '',
            overview: data.overview || '', addedBy: data.addedBy || '', addedAt: data.addedAt || 0,
            sha: j.sha, pending: false,
          });
        } else {
          await dbPut('reviews', {
            key: j.key, movieId: j.movieId, author: j.author, rating: Number(data.rating),
            text: data.text || '', updatedAt: data.updatedAt || 0, sha: j.sha, pending: false,
          });
        }
        changed = true;
      }));
    }
    return changed;
  }

  // Upload everything that was saved while offline.
  async function push() {
    let pushed = 0;
    const movies = (await dbAll('movies')).filter((m) => m.pending);
    for (const m of movies) {
      const path = `movies/${m.id}.json`;
      let res = await putFile(path, movieFile(m), m.sha || undefined, `Add movie: ${m.title}`);
      if (res.conflict) res = { sha: await currentSha(path) };      // already there: keep the existing file
      await dbPut('movies', { ...m, sha: res.sha, pending: false });
      pushed++;
    }

    const titles = new Map((await dbAll('movies')).map((m) => [m.id, m.title]));
    const reviews = (await dbAll('reviews')).filter((r) => r.pending);
    for (const r of reviews) {
      const path = `reviews/${r.movieId}/${r.author}.json`;
      const msg = `${r.author} reviewed ${titles.get(r.movieId) || r.movieId}`;
      let res = await putFile(path, reviewFile(r), r.sha || undefined, msg);
      if (res.conflict) {
        res = await putFile(path, reviewFile(r), (await currentSha(path)) || undefined, msg);
        if (res.conflict) throw new SyncError('Couldn’t save a review (version clash). Try syncing again.', 'conflict');
      }
      const now = await dbGet('reviews', r.key);            // the user may have edited it again meanwhile
      if (now && now.updatedAt === r.updatedAt) await dbPut('reviews', { ...now, sha: res.sha, pending: false });
      else if (now) await dbPut('reviews', { ...now, sha: res.sha });
      pushed++;
    }
    return pushed;
  }

  async function sync({ manual = false } = {}) {
    if (syncing) return;
    const token = await getMeta('token');
    if (!token) {
      if (manual) toast('Add your token in Settings first.');
      return updatePill();
    }
    if (!navigator.onLine) {
      if (manual) toast('You’re offline. Your changes will sync later.');
      return updatePill();
    }
    if (!manual && Date.now() - lastAttempt < 30000) return;   // don't hammer GitHub
    lastAttempt = Date.now();
    syncing = true;
    updatePill();

    let changed = false;
    try {
      const repo = await ghJson(repoPath());
      changed = await pull(repo.default_branch);
      const pushed = await push();
      changed = changed || pushed > 0;
      await setMeta('lastSync', Date.now());
      lastError = null;
      if (manual) toast(changed ? 'Synced.' : 'Already up to date.');
    } catch (e) {
      lastError = e.message || 'Sync failed.';
      if (manual || e.kind === 'auth' || e.kind === 'perm') toast(lastError);
    } finally {
      syncing = false;
    }
    if (changed) softRender();
    updatePill();
  }

  async function updatePill() {
    const pill = $('#syncpill');
    const [token, n] = await Promise.all([getMeta('token'), pendingCount()]);
    let state = 'ok', text = 'Synced';
    if (!token) { state = 'warn'; text = 'Set up sync'; }
    else if (syncing) { state = 'busy'; text = 'Syncing…'; }
    else if (!navigator.onLine) { state = 'off'; text = n ? `Offline · ${n} waiting` : 'Offline'; }
    else if (lastError) { state = 'err'; text = 'Sync problem'; }
    else if (n) { state = 'warn'; text = `${n} waiting`; }
    pill.dataset.state = state;
    pill.textContent = text;
    pill.title = lastError || '';
  }

  /* ---------- TMDB ---------- */
  // Remove stray spaces, quotes or line breaks that can sneak in when pasting the key.
  const tmdbKey = () => String(C.TMDB_API_KEY || '').replace(/[\s"'\u2018\u2019\u201C\u201D]/g, '');
  const keyMissing = () => !tmdbKey() || tmdbKey().startsWith('PASTE_');
  async function tmdbSearch(query) {
    const key = tmdbKey();
    const url = new URL('https://api.themoviedb.org/3/search/movie');
    url.searchParams.set('query', query);
    url.searchParams.set('include_adult', 'false');
    const headers = {};
    if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;   // v4 token
    else url.searchParams.set('api_key', key);
    let res;
    try {
      res = await fetch(url.toString(), { headers });
    } catch (e) {
      throw new Error('network');
    }
    if (!res.ok) throw new Error('http ' + res.status);
    return (await res.json()).results || [];
  }

  /* ---------- little view helpers ---------- */
  function poster(m, size = 'w342') {
    if (!m.posterPath) return `<div class="poster fallback"><span>${esc(m.title)}</span></div>`;
    return `<img class="poster" loading="lazy" alt="Poster of ${esc(m.title)}" data-title="${esc(m.title)}" src="https://image.tmdb.org/t/p/${size}${esc(m.posterPath)}">`;
  }
  // If a poster can't load (offline and not cached yet), show the title instead.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.classList.contains('poster')) {
      const div = document.createElement('div');
      div.className = 'poster fallback';
      div.innerHTML = `<span>${esc(img.dataset.title || '')}</span>`;
      img.replaceWith(div);
    }
  }, true);

  /* ---------- sky backgrounds (picked in Settings, saved on this device only) ---------- */
  // dim = automatic darkening so text stays readable on bright skies
  const SKIES = [
    { id: 'sky-01', name: 'Midnight', dim: 0.1 },
    { id: 'sky-02', name: 'Pink morning', dim: 0.5 },
    { id: 'sky-03', name: 'Violet dusk', dim: 0.15 },
    { id: 'sky-04', name: 'Golden cloud', dim: 0.5 },
    { id: 'sky-05', name: 'Blue cumulus', dim: 0.55 },
    { id: 'sky-06', name: 'Ember sunset', dim: 0.45 },
    { id: 'sky-07', name: 'Mint haze', dim: 0.55 },
    { id: 'sky-08', name: 'Ash storm', dim: 0.5 },
    { id: 'sky-09', name: 'Soft blue', dim: 0.55 },
    { id: 'sky-10', name: 'Magenta bloom', dim: 0.5 },
    { id: 'sky-11', name: 'Ocean blue', dim: 0.5 },
    { id: 'sky-12', name: 'Lightning', dim: 0.1 },
    { id: 'sky-13', name: 'Cream mist', dim: 0.55 },
    { id: 'sky-14', name: 'Peach dusk', dim: 0.4 },
    { id: 'sky-15', name: 'Lavender grey', dim: 0.5 },
    { id: 'sky-16', name: 'Ivory cloud', dim: 0.55 },
    { id: 'sky-17', name: 'Noon white', dim: 0.55 },
    { id: 'sky-18', name: 'Pink sun', dim: 0.55 },
    { id: 'sky-19', name: 'Cyan puff', dim: 0.55 },
    { id: 'sky-20', name: 'Moonlit', dim: 0.55 }
  ];
  const BG_KEY = 'movie-nights-bg';
  function loadBgPref() {
    try { return JSON.parse(localStorage.getItem(BG_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveBgPref(p) {
    try { localStorage.setItem(BG_KEY, JSON.stringify(p)); } catch (e) { /* storage blocked: choice just won't persist */ }
  }
  function currentSky() {
    const p = loadBgPref();
    return SKIES.find((s) => s.id === p.id) || null;
  }
  function currentDim() {
    const p = loadBgPref(), sky = currentSky();
    if (!sky) return 0;
    return typeof p.dim === 'number' ? p.dim : sky.dim;
  }
  function applyBg() {
    const sky = currentSky();
    const el = $('#bg');
    document.body.classList.toggle('has-bg', !!sky);
    el.style.backgroundImage = sky ? `url("backgrounds/${sky.id}.png")` : '';
    el.style.setProperty('--dim', sky ? currentDim() : 0);
  }
  // Only switch once the picture has really loaded (so offline never leaves a blank screen).
  function chooseSky(id, done) {
    const p = loadBgPref();
    if (id === 'none') { p.id = 'none'; saveBgPref(p); applyBg(); if (done) done(); return; }
    if (!SKIES.some((s) => s.id === id)) return;
    const img = new Image();
    img.onload = () => { p.id = id; saveBgPref(p); applyBg(); if (done) done(); };
    img.onerror = () => toast('That background isn’t on this device yet. Connect to the internet once to download it.');
    img.src = `backgrounds/${id}.png`;
  }

  /* ---------- screens ---------- */
  let me = null;
  let editingId = null;   // movie whose review is currently open for editing

  function viewWelcome() {
    $('#view').innerHTML = `
      <section class="narrow center">
        <h1 class="serif big">Who’s watching?</h1>
        <p class="muted">Pick your name. Reviews written on this device will be saved as you.</p>
        <div class="stack">
          ${USERS.map((u, i) => `<button class="who-btn u${i}" data-who="${esc(u)}" type="button">${esc(u)}</button>`).join('')}
        </div>
      </section>`;
    $('#view').querySelectorAll('[data-who]').forEach((b) => b.addEventListener('click', async () => {
      me = b.dataset.who;
      await setMeta('me', me);
      const hasToken = !!(await getMeta('token'));
      location.hash = hasToken ? '#/' : '#/settings';
      render();
    }));
  }

  async function viewHome() {
    const [movies, reviews, token] = await Promise.all([dbAll('movies'), dbAll('reviews'), getMeta('token')]);
    const byMovie = {};
    reviews.forEach((r) => { (byMovie[r.movieId] ||= {})[r.author] = r; });
    const items = movies.map((m) => {
      const rs = byMovie[m.id] || {};
      const act = Math.max(m.addedAt || 0, ...Object.values(rs).map((r) => r.updatedAt || 0));
      return { m, rs, act };
    }).sort((a, b) => b.act - a.act);

    const banner = token ? '' : `
      <a class="banner" href="#/settings"><b>Sync isn’t set up yet.</b> Reviews stay on this device until you add the GitHub token in Settings.</a>`;

    if (!items.length) {
      $('#view').innerHTML = `${banner}
        <div class="empty">
          <h2>No movies yet</h2>
          <p>Add the first one you watched together.</p>
          <a class="btn primary" href="#/add">Add a movie</a>
        </div>`;
      return;
    }

    $('#view').innerHTML = `${banner}
      <div class="home-head"><input id="filter" type="search" placeholder="Filter your movies" autocomplete="off"></div>
      <div class="grid">
        ${items.map(({ m, rs }) => {
          const ov = overall(rs);
          return `
          <a class="mcard" href="#/movie/${encodeURIComponent(m.id)}" data-title="${esc(m.title.toLowerCase())}">
            <div class="mposter">${poster(m)}${ov.complete ? `<span class="badge">${fmtRating(ov.value)}</span>` : ''}</div>
            <div class="mmeta">
              <span class="t">${esc(m.title)}</span>
              ${m.year ? `<span class="y">${esc(m.year)}</span>` : ''}
              <span class="scores">${USERS.map((u, i) => rs[u]
                ? `<i class="u${i}" title="${esc(u)}">${fmtRating(rs[u].rating)}</i>`
                : `<i class="none" title="${esc(u)}: no review yet">–</i>`).join('')}</span>
            </div>
          </a>`;
        }).join('')}
      </div>`;

    $('#filter').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      document.querySelectorAll('.mcard').forEach((c) => { c.style.display = c.dataset.title.includes(q) ? '' : 'none'; });
    });
  }

  async function viewMovie(id) {
    const m = await dbGet('movies', id);
    if (!m) {
      $('#view').innerHTML = `
        <section class="narrow center">
          <h1 class="serif big">Movie not found</h1>
          <p class="muted">It may not have reached this device yet. Try syncing.</p>
          <div class="stack"><a class="btn" href="#/">Back to your movies</a></div>
        </section>`;
      return;
    }
    const rs = await reviewsFor(id);
    const ov = overall(rs);
    const mine = rs[me];

    const sideScore = (u, i) => `
      <div class="score u${i}">
        <span class="num">${rs[u] ? fmtRating(rs[u].rating) : '–'}</span>
        <span class="name">${esc(u)}</span>
      </div>`;

    const cards = USERS.map((u, i) => {
      const r = rs[u];
      if (u === me && (!r || editingId === id)) {
        const startVal = r ? r.rating : 7;
        const status = r ? (r.pending ? '<span class="tag wait">Waiting to sync</span>' : '<span class="tag">Saved</span>') : '';
        return `
        <form class="card u${i}" id="rvform">
          <header><b>${esc(u)}</b>${status || '<span class="tag">Your review</span>'}</header>
          <label for="rv-rating">Rating: <output id="rv-out">${fmtRating(startVal)}</output> / 10</label>
          <input id="rv-rating" type="range" min="0" max="10" step="0.5" value="${startVal}">
          <label for="rv-text">What did you think?</label>
          <textarea id="rv-text" placeholder="Write what you liked, what you didn’t, who you’d recommend it to…">${esc(r ? r.text : '')}</textarea>
          <div class="row">
            <button class="btn primary" type="submit">Save review</button>
            ${r ? '<button class="btn ghost" type="button" id="cancelrv">Cancel</button>' : ''}
          </div>
        </form>`;
      }
      if (!r) {
        return `
        <div class="card waiting u${i}">
          <header><b>${esc(u)}</b></header>
          <p>No review yet.</p>
        </div>`;
      }
      return `
        <div class="card u${i}">
          <header><b>${esc(u)}</b>${r.pending ? '<span class="tag wait">Waiting to sync</span>' : ''}</header>
          <div class="rate"><span class="num">${fmtRating(r.rating)}</span><span class="muted">/ 10</span></div>
          <div class="bar"><i style="width:${Math.min(100, r.rating * 10)}%"></i></div>
          ${r.text ? `<p class="text">${esc(r.text)}</p>` : '<p class="muted">No written review.</p>'}
          <p class="when">${esc(fmtDate(r.updatedAt))}</p>
          ${u === me ? '<button class="btn" type="button" id="editrv">Update review</button>' : ''}
        </div>`;
    }).join('');

    $('#view').innerHTML = `
      <article class="movie">
        ${m.posterPath ? `<div class="backdrop" style="background-image:url('https://image.tmdb.org/t/p/w342${esc(m.posterPath)}')"></div>` : ''}
        <a class="back" href="#/">‹ All movies</a>
        <div class="hero">
          <div>${poster(m)}</div>
          <div>
            <h1>${esc(m.title)}</h1>
            ${m.year ? `<p class="year">${esc(m.year)}</p>` : ''}
            ${m.overview ? `<p class="overview">${esc(m.overview)}</p>` : ''}
          </div>
        </div>

        <section class="verdict" aria-label="Ratings">
          ${sideScore(USERS[0], 0)}
          <div class="score overall"><span class="num">${ov.complete ? fmtRating(ov.value) : '–'}</span><span class="name">Overall</span></div>
          ${sideScore(USERS[1], 1)}
          ${ov.complete ? '' : '<p class="hint">The overall rating appears once you’ve both reviewed.</p>'}
        </section>

        <section class="reviews">${cards}</section>
      </article>`;

    const form = $('#rvform');
    if (form) {
      const slider = $('#rv-rating');
      slider.addEventListener('input', () => { $('#rv-out').textContent = fmtRating(parseFloat(slider.value)); });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const prev = await dbGet('reviews', `${id}|${me}`);
        await dbPut('reviews', {
          key: `${id}|${me}`, movieId: id, author: me,
          rating: parseFloat(slider.value), text: $('#rv-text').value.trim(),
          updatedAt: Date.now(), sha: prev?.sha || null, pending: true,
        });
        toast(navigator.onLine ? 'Saved. Syncing…' : 'Saved on this device. It will sync when you’re online.');
        editingId = null;
        await render();
        lastAttempt = 0;
        sync();
      });
    }
    const editBtn = $('#editrv');
    if (editBtn) editBtn.addEventListener('click', () => { editingId = id; render(); });
    const cancelBtn = $('#cancelrv');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { editingId = null; render(); });
  }

  async function addMovie(movie) {
    const id = String(movie.id);
    const existing = await dbGet('movies', id);
    if (!existing) {
      await dbPut('movies', {
        id, title: movie.title, year: movie.year || '', posterPath: movie.posterPath || '',
        overview: movie.overview || '', addedBy: me, addedAt: Date.now(), sha: null, pending: true,
      });
      toast('Movie added.');
    }
    location.hash = '#/movie/' + encodeURIComponent(id);
    lastAttempt = 0;
    sync();
  }

  async function viewAdd() {
    $('#view').innerHTML = `
      <section class="narrow">
        <h1 class="serif big" style="font-size:1.8rem;margin-bottom:14px">Add a movie</h1>
        <input id="q" type="search" placeholder="Search by title" autocomplete="off">
        <div id="results" class="results"></div>
        <details class="manual">
          <summary>Can’t find it? Add it by hand</summary>
          <form id="manform">
            <input id="mt" placeholder="Title" required>
            <input id="my" inputmode="numeric" placeholder="Year (optional)" maxlength="4">
            <button class="btn" type="submit">Add movie</button>
          </form>
        </details>
      </section>`;

    const results = $('#results');
    let timer, found = [];

    if (keyMissing()) {
      results.innerHTML = '<p class="notice">Search is off because the TMDB key isn’t in config.js yet. You can still add a movie by hand below.</p>';
    }

    $('#q').addEventListener('input', (e) => {
      clearTimeout(timer);
      const q = e.target.value.trim();
      if (keyMissing()) return;
      if (q.length < 2) { results.innerHTML = ''; return; }
      timer = setTimeout(async () => {
        if (!navigator.onLine) { results.innerHTML = '<p class="notice">Search needs internet. You can add the movie by hand below.</p>'; return; }
        try {
          const list = await tmdbSearch(q);
          found = list.slice(0, 12).map((r) => ({
            id: r.id, title: r.title, year: (r.release_date || '').slice(0, 4),
            posterPath: r.poster_path || '', overview: r.overview || '',
          }));
          results.innerHTML = found.length ? found.map((f, i) => `
            <button class="result" type="button" data-i="${i}">
              ${f.posterPath ? `<img class="poster" alt="" src="https://image.tmdb.org/t/p/w92${esc(f.posterPath)}" data-title="${esc(f.title)}">` : '<div class="poster fallback"></div>'}
              <div><div class="t">${esc(f.title)}</div><div class="y">${esc(f.year || 'Year unknown')}</div><div class="o">${esc(f.overview)}</div></div>
            </button>`).join('') : '<p class="notice">No matches. Try another spelling, or add it by hand.</p>';
        } catch (err) {
          let why;
          if (err.message === 'network') why = 'This device couldn’t reach TMDB. Try another network (mobile data or Wi-Fi), or turn off any ad blocker or private DNS.';
          else if (err.message === 'http 401') why = 'TMDB rejected the key in config.js. Check that it was copied completely, with nothing else on the line.';
          else why = 'TMDB returned an error (' + esc(err.message) + ').';
          results.innerHTML = `<p class="notice">${why} You can also add the movie by hand below.</p>`;
        }
      }, 350);
    });

    results.addEventListener('click', (e) => {
      const b = e.target.closest('.result');
      if (b) addMovie(found[Number(b.dataset.i)]);
    });

    $('#manform').addEventListener('submit', (e) => {
      e.preventDefault();
      const title = $('#mt').value.trim();
      if (!title) return;
      addMovie({ id: 'c' + Date.now(), title, year: $('#my').value.trim().slice(0, 4) });
    });
  }

  async function viewSettings() {
    const [token, last, n] = await Promise.all([getMeta('token'), getMeta('lastSync'), pendingCount()]);
    $('#view').innerHTML = `
      <section class="narrow">
        <h1 class="serif big" style="font-size:1.8rem">Settings</h1>

        <div class="panel">
          <h2>Who you are</h2>
          <div class="seg">
            ${USERS.map((u, i) => `<label class="u${i}"><input type="radio" name="me" value="${esc(u)}" ${u === me ? 'checked' : ''}><span>${esc(u)}</span></label>`).join('')}
          </div>
        </div>

        <div class="panel">
          <h2>Sync with GitHub</h2>
          <p class="muted">${token ? 'A token is saved on this device.' : 'Paste the access token to share reviews between your phones.'}</p>
          <input id="tok" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${token ? 'Paste a new token to replace it' : 'github_pat_…'}">
          <div class="row">
            <button id="savetok" class="btn primary" type="button">Save and test</button>
            <button id="syncnow" class="btn" type="button">Sync now</button>
            ${token ? '<button id="rmtok" class="btn ghost" type="button">Remove token</button>' : ''}
          </div>
          <p class="muted small" style="margin-top:14px">${n} change${n === 1 ? '' : 's'} waiting to sync. Last sync: ${esc(fmtTime(last))}.</p>
        </div>

        <div class="panel">
          <h2>Background</h2>
          <p class="muted small">Saved on this device only, so you can each pick your own.</p>
          <div class="bggrid" role="group" aria-label="Background">
            <button type="button" class="bgtile bgnone" data-bg="none" aria-pressed="false"><span>Plain</span></button>
            ${SKIES.map((s) => `<button type="button" class="bgtile" data-bg="${s.id}" aria-pressed="false" title="${esc(s.name)}"><img src="backgrounds/thumbs/${s.id}.png" alt="${esc(s.name)}" loading="lazy" width="288" height="162"></button>`).join('')}
          </div>
          <div class="dimrow">
            <label for="dim">Dim: <output id="dimout">0</output>%</label>
            <button id="dimauto" class="btn small ghost" type="button">Automatic</button>
          </div>
          <input id="dim" type="range" min="0" max="80" step="5" value="0">
        </div>

        <div class="panel">
          <h2>About</h2>
          <p class="muted small">Reviews are saved on each device first, so everything works offline. They are shared through the private repo ${esc(C.GITHUB_OWNER)}/${esc(C.DATA_REPO)}.</p>
          <p class="muted small" style="margin-top:8px">Sky backgrounds: free pack from Craftpix.net.</p>
        </div>
      </section>`;

    document.querySelectorAll('input[name="me"]').forEach((r) => r.addEventListener('change', async () => {
      me = r.value;
      await setMeta('me', me);
      toast('Now writing as ' + me + '.');
    }));
    // --- background picker ---
    const dimInput = $('#dim'), dimOut = $('#dimout');
    const refreshPicker = () => {
      const sky = currentSky();
      document.querySelectorAll('.bgtile').forEach((b) => {
        const on = b.dataset.bg === (sky ? sky.id : 'none');
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
      const d = Math.round(currentDim() * 100);
      dimInput.disabled = !sky;
      $('#dimauto').disabled = !sky;
      dimInput.value = d;
      dimOut.textContent = d;
    };
    refreshPicker();
    document.querySelectorAll('.bgtile').forEach((b) => b.addEventListener('click', () => chooseSky(b.dataset.bg, refreshPicker)));
    dimInput.addEventListener('input', () => {
      const p = loadBgPref();
      p.dim = Number(dimInput.value) / 100;
      saveBgPref(p);
      applyBg();
      dimOut.textContent = dimInput.value;
    });
    $('#dimauto').addEventListener('click', () => {
      const p = loadBgPref();
      delete p.dim;
      saveBgPref(p);
      applyBg();
      refreshPicker();
    });

    $('#savetok').addEventListener('click', async () => {
      const v = $('#tok').value.trim();
      if (!v) { toast('Paste the token first.'); return; }
      await setMeta('token', v);
      lastError = null;
      await sync({ manual: true });
      if (!lastError) { toast('Token works. Synced.'); }
      render();
    });
    $('#syncnow').addEventListener('click', async () => { await sync({ manual: true }); render(); });
    const rm = $('#rmtok');
    if (rm) rm.addEventListener('click', async () => { await delMeta('token'); toast('Token removed.'); render(); });
  }

  /* ---------- router ---------- */
  async function render() {
    me = await getMeta('me');
    const parts = (location.hash.slice(1) || '/').split('/');
    const route = parts[1] || '';
    if (!me) { viewWelcome(); updatePill(); return; }
    if (route === 'movie') await viewMovie(decodeURIComponent(parts[2] || ''));
    else if (route === 'add') await viewAdd();
    else if (route === 'settings') await viewSettings();
    else await viewHome();
    updatePill();
  }
  // After a background sync, refresh the screen unless the person is typing.
  function softRender() {
    if (editingId) return;
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) return;
    render();
  }

  /* ---------- start ---------- */
  async function boot() {
    applyBg();
    $('#tagline').textContent = USERS.join(' & ');
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    window.addEventListener('hashchange', () => { editingId = null; window.scrollTo(0, 0); render(); });
    window.addEventListener('online', () => { lastAttempt = 0; sync(); });
    window.addEventListener('offline', updatePill);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
    $('#syncpill').addEventListener('click', async () => {
      if (!(await getMeta('token'))) { location.hash = '#/settings'; return; }
      sync({ manual: true });
    });
    await render();
    sync();
  }
  boot();
})();
