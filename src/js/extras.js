// Extras for the review newspaper: a historical picture (Wikimedia Commons, public domain), a joke, a quote,
// an online horoscope paragraph, and ornaments for the masthead. Network sources are optional; each falls back
// to something built in when it can't be reached.
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const PIC_KEY = 'tempo:npPictures';

const rnd = (n) => Math.floor(Math.random() * n);
const pickR = (list) => list[rnd(list.length)];
const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();

// ---------- historical pictures ----------
// Searches of Wikimedia Commons for 19th-century cartoons, engravings and photographs.
export const PIC_QUERIES = [
  'deepcat:"Punch, or the London Charivari" filetype:bitmap',
  'Punch cartoon 1850 filetype:bitmap', 'Punch cartoon 1860 filetype:bitmap', 'Punch cartoon 1870 filetype:bitmap', 'Punch cartoon 1880 filetype:bitmap', 'Punch cartoon 1890 filetype:bitmap',
  'Tenniel cartoon Punch filetype:bitmap', 'John Leech Punch filetype:bitmap', 'Linley Sambourne Punch filetype:bitmap',
  'Thomas Nast cartoon Harper\'s Weekly filetype:bitmap', 'Honoré Daumier lithograph caricature filetype:bitmap', 'Gustave Doré engraving filetype:bitmap',
  'Julia Margaret Cameron photograph filetype:bitmap', 'Mathew Brady photograph 1860s filetype:bitmap', 'Nadar portrait photograph filetype:bitmap',
  'daguerreotype 1850s filetype:bitmap', 'Victorian street photograph 1880s filetype:bitmap', 'Illustrated London News engraving 1850s filetype:bitmap',
];
const yearOf = (meta) => {
  const txt = [meta?.DateTimeOriginal?.value, meta?.DateTime?.value, meta?.ObjectName?.value, meta?.ImageDescription?.value].map(strip).join(' ');
  const m = txt.match(/\b(1[89]\d\d)\b/);
  return m ? +m[1] : null;
};

// Picture sources (Settings → Review): the built-in 19th-century set, a Wikimedia Commons search or category,
// the Art Institute of Chicago's public-domain collection, or a list of image links.
export const DEFAULT_SOURCES = [{ id: 'builtin', name: '19th-century cartoons & photographs', kind: 'builtin', value: '', on: true }];
export const SOURCE_KINDS = { builtin: 'Built-in (19th century)', commons: 'Wikimedia Commons search', commonscat: 'Wikimedia Commons category', aic: 'Art Institute of Chicago (public domain)', urls: 'Image links (one per line)' };
export function fetchPicture({ sources = DEFAULT_SOURCES, fetchFn = fetch, tries = 4 } = {}) {
  const on = (sources?.length ? sources : DEFAULT_SOURCES).filter((x) => x.on !== false && (x.kind === 'builtin' || String(x.value || '').trim()));
  const src = on.length ? pickR(on) : DEFAULT_SOURCES[0];
  if (src.kind === 'aic') return fetchAic(src, { fetchFn, tries });
  if (src.kind === 'urls') return Promise.resolve(fromUrls(src));
  const query = src.kind === 'commons' ? `${src.value} filetype:bitmap` : src.kind === 'commonscat' ? `deepcat:"${String(src.value).replace(/^Category:/i, '').replace(/"/g, '')}" filetype:bitmap` : null;
  return fetchCommons({ query, fetchFn, tries, sourceName: src.name, old: src.kind === 'builtin' });
}
function fromUrls(src) {
  const urls = String(src.value || '').split(/\s+/).filter((u) => /^https:\/\//i.test(u));
  if (!urls.length) return null;
  const u = pickR(urls);
  const pic = { title: decodeURIComponent(u.split('/').pop().replace(/\.[a-z]+(\?.*)?$/i, '').replace(/[_-]+/g, ' ')).slice(0, 80) || src.name, thumb: u, page: u, artist: '', year: null, desc: '', license: src.name, source: src.name, at: Date.now() };
  remember(pic); return pic;
}
async function fetchAic(src, { fetchFn, tries }) {
  for (let i = 0; i < tries; i++) {
    try {
      const q = new URLSearchParams({ q: src.value, 'query[term][is_public_domain]': 'true', limit: '40', page: String(1 + rnd(3)), fields: 'id,title,image_id,artist_display,date_display' });
      const r = await fetchFn(`https://api.artic.edu/api/v1/artworks/search?${q}`); if (!r.ok) continue;
      const list = ((await r.json())?.data || []).filter((x) => x.image_id);
      if (!list.length) continue;
      const a = pickR(list);
      const pic = { title: a.title || 'Untitled', thumb: `https://www.artic.edu/iiif/2/${a.image_id}/full/843,/0/default.jpg`, page: `https://www.artic.edu/artworks/${a.id}`, artist: strip(a.artist_display).split('\n')[0].slice(0, 80), year: null, desc: strip(a.date_display), license: 'Public domain · Art Institute of Chicago', source: src.name, at: Date.now() };
      remember(pic); return pic;
    } catch { /* try again */ }
  }
  return null;
}
async function fetchCommons({ query = null, fetchFn = fetch, tries = 4, sourceName = '', old = true } = {}) {
  for (let i = 0; i < tries; i++) {
    const q = new URLSearchParams({ action: 'query', list: 'search', srnamespace: '6', srsearch: query || pickR(PIC_QUERIES), srlimit: '50', sroffset: String(rnd(query ? 2 : 4) * 50), format: 'json', origin: '*' });
    let hits;
    try { const r = await fetchFn(`${COMMONS}?${q}`); if (!r.ok) continue; hits = (await r.json())?.query?.search || []; } catch { continue; }
    hits = hits.filter((h) => /\.(jpe?g|png|gif)$/i.test(h.title)); // TIFF scans make slow, heavy thumbnails
    if (!hits.length) continue;
    const title = pickR(hits).title;
    const q2 = new URLSearchParams({ action: 'query', titles: title, prop: 'imageinfo', iiprop: 'url|extmetadata|size', iiurlwidth: '960', format: 'json', origin: '*' }); // 960 = a standard Wikimedia thumbnail width
    try {
      const r = await fetchFn(`${COMMONS}?${q2}`); if (!r.ok) continue;
      const page = Object.values((await r.json())?.query?.pages || {})[0];
      const ii = page?.imageinfo?.[0]; if (!ii?.thumburl) continue;
      const meta = ii.extmetadata || {};
      const year = yearOf(meta);
      if (old && year && (year < 1800 || year > 1910) && i < tries - 1) continue; // built-in set: keep to the 19th century (and just after)
      const pic = {
        title: strip(meta.ObjectName?.value) || title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '').replace(/_/g, ' '),
        thumb: ii.thumburl, w: ii.thumbwidth || null, h: ii.thumbheight || null, page: ii.descriptionurl, artist: strip(meta.Artist?.value).slice(0, 80), year,
        desc: strip(meta.ImageDescription?.value).slice(0, 220), license: strip(meta.LicenseShortName?.value) || 'Public domain', source: sourceName, at: Date.now(),
      };
      remember(pic);
      return pic;
    } catch { /* try another */ }
  }
  return null;
}
export function pictureHistory() { try { return JSON.parse(localStorage.getItem(PIC_KEY) || '[]'); } catch { return []; } }
function remember(pic) {
  try { const h = pictureHistory().filter((x) => x.page !== pic.page); h.unshift({ title: pic.title, page: pic.page, thumb: pic.thumb, year: pic.year, at: pic.at }); localStorage.setItem(PIC_KEY, JSON.stringify(h.slice(0, 60))); } catch { /* storage unavailable */ }
}

// ---------- jokes ----------
export const JOKES = [
  'I told my calendar a joke about Wednesday. It said, "Don\'t worry, it\'ll pass."',
  'Why did the clock get detention? It tocked too much in class.',
  'My to-do list and I have an understanding: I write things down, it keeps them safe forever.',
  'I tried to schedule some procrastination, but I kept putting it off.',
  'Why don\'t calendars ever win at poker? Everyone can see their dates.',
  'Time flies like an arrow. Fruit flies like a banana.',
  'I\'m reading a book about anti-gravity. I can\'t put it down.',
  'Why did the scarecrow get promoted? He was outstanding in his field.',
  'What do you call a meeting that could have been an email? Tuesday.',
  'I used to be indecisive. Now I\'m not so sure.',
  'Why was the calendar so popular? It had a lot of dates.',
  'Parallel lines have so much in common. It\'s a shame they\'ll never meet.',
  'My boss told me to have a good day. So I went home.',
  'I would tell you a joke about time travel, but you didn\'t like it.',
  'Why did the deadline go to therapy? It felt everyone was always running from it.',
  'What did one wall clock say to the other? "Meet you at the same time tomorrow."',
  'I\'m on a seafood diet. I see food and I eat it — usually during meetings.',
  'Why did the student eat his homework? The teacher said it was a piece of cake.',
  'A Pomodoro walks into a bar. Twenty-five minutes later, it walks out for a five-minute break.',
  'Why do bees have sticky hair? Because they use honeycombs.',
  'What\'s the best thing about Switzerland? I don\'t know, but the flag is a big plus.',
  'Did you hear about the claustrophobic astronaut? He just needed a little space.',
  'I asked the librarian for books about paranoia. She whispered, "They\'re right behind you."',
  'Why don\'t skeletons fight each other? They don\'t have the guts.',
  'What do you call a fake noodle? An impasta.',
  'How do you organise a space party? You planet.',
  'Why did the bicycle fall over? It was two-tired.',
  'I only know 25 letters of the alphabet. I don\'t know y.',
  'What do you call a sleeping dinosaur? A dino-snore.',
  'Why couldn\'t the leopard play hide and seek? He was always spotted.',
  'My week planner and I broke up. It said I never made time for it.',
  'Why did the week feel so short? Because Monday took up most of it.',
  'I finally finished my book on productivity. Chapter one is next.',
  'What\'s orange and sounds like a parrot? A carrot.',
  'Why do cows wear bells? Because their horns don\'t work.',
  'Why was the math book sad? It had too many problems.',
  'I\'m great at multitasking. I can waste time, be unproductive and procrastinate all at once.',
  'Why did the hourglass break up with the sundial? It needed someone it could turn to.',
  'What do you call an alligator in a vest? An investigator.',
  'The early bird gets the worm, but the second mouse gets the cheese.',
];
export async function getJoke({ fetchFn = fetch, online = true } = {}) {
  if (online && Math.random() < 0.6) {
    try {
      const r = await fetchFn('https://icanhazdadjoke.com/', { headers: { Accept: 'application/json' } });
      if (r.ok) { const j = await r.json(); if (j?.joke && j.joke.length < 300) return { text: j.joke, source: 'icanhazdadjoke.com', link: `https://icanhazdadjoke.com/j/${j.id}` }; }
    } catch { /* offline: use our own */ }
  }
  return { text: pickR(JOKES), source: null };
}

// ---------- philosophical quotes ----------
export const QUOTES = [
  ['The unexamined life is not worth living.', 'Socrates, in Plato’s Apology'],
  ['We suffer more often in imagination than in reality.', 'Seneca, Letters to Lucilius'],
  ['It is not that we have a short time to live, but that we waste a lot of it.', 'Seneca, On the Shortness of Life'],
  ['Begin at once to live, and count each separate day as a separate life.', 'Seneca, Letters to Lucilius'],
  ['The soul becomes dyed with the colour of its thoughts.', 'Marcus Aurelius, Meditations'],
  ['Waste no more time arguing about what a good man should be. Be one.', 'Marcus Aurelius, Meditations'],
  ['The present is the only thing of which a man can be deprived.', 'Marcus Aurelius, Meditations'],
  ['First say to yourself what you would be; and then do what you have to do.', 'Epictetus, Discourses'],
  ['No man is free who is not master of himself.', 'Epictetus'],
  ['Do not spoil what you have by desiring what you have not.', 'Epicurus, Vatican Sayings'],
  ['Of all the things which wisdom provides to make us entirely happy, much the greatest is the possession of friendship.', 'Epicurus, Principal Doctrines'],
  ['No man ever steps in the same river twice.', 'Heraclitus, as reported by Plato'],
  ['Lifetime is a child at play, moving pieces in a game.', 'Heraclitus, fragment B52'],
  ['Time is the most valuable thing a man can spend.', 'Theophrastus, in Diogenes Laërtius'],
  ['Know thyself.', 'Inscription at the Temple of Apollo, Delphi'],
  ['Nothing in excess.', 'Inscription at the Temple of Apollo, Delphi'],
  ['Wonder is the feeling of a philosopher, and philosophy begins in wonder.', 'Plato, Theaetetus'],
  ['We are what we repeatedly do. Excellence, then, is not an act, but a habit.', 'Will Durant, summarising Aristotle'],
  ['I think, therefore I am.', 'René Descartes, Discourse on the Method'],
  ['The heart has its reasons which reason knows nothing of.', 'Blaise Pascal, Pensées'],
  ['All of humanity’s problems stem from man’s inability to sit quietly in a room alone.', 'Blaise Pascal, Pensées'],
  ['Leisure is the mother of philosophy.', 'Thomas Hobbes, Leviathan'],
  ['Doubt is not a pleasant condition, but certainty is absurd.', 'Voltaire, letter to Frederick the Great'],
  ['We must cultivate our garden.', 'Voltaire, Candide'],
  ['Man is born free, and everywhere he is in chains.', 'Jean-Jacques Rousseau, The Social Contract'],
  ['Two things fill the mind with ever new and increasing admiration and awe: the starry heavens above me and the moral law within me.', 'Immanuel Kant, Critique of Practical Reason'],
  ['Out of the crooked timber of humanity, no straight thing was ever made.', 'Immanuel Kant'],
  ['The owl of Minerva spreads its wings only with the falling of the dusk.', 'G. W. F. Hegel, Philosophy of Right'],
  ['Talent hits a target no one else can hit; genius hits a target no one else can see.', 'Arthur Schopenhauer'],
  ['Life can only be understood backwards; but it must be lived forwards.', 'Søren Kierkegaard, Journals'],
  ['It is better to be a human being dissatisfied than a pig satisfied.', 'John Stuart Mill, Utilitarianism'],
  ['He who has a why to live can bear almost any how.', 'Friedrich Nietzsche, Twilight of the Idols'],
  ['Without music, life would be a mistake.', 'Friedrich Nietzsche, Twilight of the Idols'],
  ['The limits of my language mean the limits of my world.', 'Ludwig Wittgenstein, Tractatus'],
  ['Whereof one cannot speak, thereof one must be silent.', 'Ludwig Wittgenstein, Tractatus'],
  ['Man is condemned to be free.', 'Jean-Paul Sartre, Existentialism Is a Humanism'],
  ['One must imagine Sisyphus happy.', 'Albert Camus, The Myth of Sisyphus'],
  ['In the midst of winter, I found there was, within me, an invincible summer.', 'Albert Camus, Return to Tipasa'],
  ['To be is to be perceived.', 'George Berkeley'],
  ['Act only according to that maxim whereby you can at the same time will that it should become a universal law.', 'Immanuel Kant, Groundwork of the Metaphysics of Morals'],
];
export const randomQuote = () => { const [text, by] = pickR(QUOTES); return { text, by }; };

// ---------- horoscope paragraph from an online source ----------
// APIVerve (free key, set in the paper) or, without a key, the community Horoscope API (texts from horoscope.com).
const HKEY = 'tempo:npHoroscope';
export async function fetchHoroscope(sign, { apiKey = '', fetchFn = fetch, today = new Date().toISOString().slice(0, 10) } = {}) {
  const cacheKey = `${today}|${sign}|${apiKey ? 'v' : 'c'}`;
  try { const c = JSON.parse(localStorage.getItem(HKEY) || '{}'); if (c[cacheKey]) return c[cacheKey]; } catch { /* ignore */ }
  let out = null;
  try {
    if (apiKey) {
      const r = await fetchFn(`https://api.apiverve.com/v1/horoscope?sign=${encodeURIComponent(sign)}`, { headers: { 'x-api-key': apiKey } });
      const j = r.ok ? await r.json() : null;
      if (j?.data?.horoscope) out = { text: strip(j.data.horoscope), source: 'APIVerve', link: 'https://apiverve.com/marketplace/horoscope' };
    } else {
      const S = sign[0].toUpperCase() + sign.slice(1);
      const r = await fetchFn(`https://horoscope-app-api.vercel.app/api/v1/get-horoscope/daily?sign=${S}&day=TODAY`);
      const j = r.ok ? await r.json() : null;
      if (j?.data?.horoscope_data) out = { text: strip(j.data.horoscope_data), source: 'horoscope.com (via Horoscope API)', link: `https://www.horoscope.com/us/horoscopes/general/horoscope-general-daily-today.aspx?sign=${['aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo', 'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces'].indexOf(sign) + 1}` };
    }
  } catch { out = null; }
  if (out) { try { localStorage.setItem(HKEY, JSON.stringify({ [cacheKey]: out })); } catch { /* ignore */ } }
  return out;
}

// ---------- masthead ornaments (drawn here; a new combination each visit) ----------
const leaf = (x, y, a, s = 1) => `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${(7 * s).toFixed(1)}" ry="${(2.8 * s).toFixed(1)}" transform="rotate(${a.toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
function laurel() {
  let g = '<path d="M60 92 C 30 80, 14 52, 22 14" fill="none" stroke="currentColor" stroke-width="2"/>';
  for (let i = 0; i < 9; i++) {
    const t = i / 8, x = 60 - 44 * t + 6 * Math.sin(t * 3), y = 92 - 78 * t;
    g += leaf(x - 6, y, -50 - 30 * t) + leaf(x + 6, y - 3, 40 - 20 * t);
  }
  return `<g fill="currentColor">${g}</g>`;
}
function quill() {
  return `<g fill="none" stroke="currentColor" stroke-width="1.6"><path d="M18 96 L 70 12"/><path d="M70 12 C 58 22, 46 40, 40 60 C 50 48, 62 32, 70 12 Z" fill="currentColor"/><path d="M66 18 C 76 30, 74 50, 56 66 C 60 50, 64 34, 66 18 Z" fill="currentColor" opacity=".6"/><circle cx="22" cy="96" r="3" fill="currentColor"/></g>`;
}
function scroll() {
  return `<g fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 54 C 30 20, 60 20, 70 50 S 50 84, 40 64 S 52 40, 58 52"/><path d="M14 64 C 34 90, 62 88, 76 70"/><circle cx="58" cy="52" r="2.5" fill="currentColor"/><path d="M76 70 c 6 -6 10 -6 12 0" /></g>`;
}
function hourglassSide() {
  return `<g fill="none" stroke="currentColor" stroke-width="1.8"><path d="M24 14 h40 M24 96 h40 M28 14 C 28 44, 60 44, 60 55 C 60 66, 28 66, 28 96 M60 14 C 60 44, 28 44, 28 55 C 28 66, 60 66, 60 96"/><path d="M34 88 h20 L44 70 Z" fill="currentColor"/><path d="M36 30 h16 L44 42 Z" fill="currentColor" opacity=".5"/></g>`;
}
const SIDES = [laurel, quill, scroll, hourglassSide];
function crown() {
  return `<g fill="currentColor" stroke="currentColor"><path d="M10 40 L20 12 L34 32 L50 6 L66 32 L80 12 L90 40 Z" stroke-width="1.5"/><rect x="10" y="40" width="80" height="8" rx="1"/><circle cx="20" cy="10" r="3.5"/><circle cx="50" cy="4" r="4"/><circle cx="80" cy="10" r="3.5"/></g>`;
}
function crest() {
  return `<g fill="none" stroke="currentColor" stroke-width="1.8"><path d="M30 6 h40 v22 c0 14 -10 22 -20 26 c-10 -4 -20 -12 -20 -26 Z"/><circle cx="50" cy="26" r="9"/><path d="M50 26 v-6 M50 26 l5 3"/><path d="M8 30 c8 -8 16 -8 22 -2 M92 30 c-8 -8 -16 -8 -22 -2"/></g>`;
}
function sunburst() {
  let rays = '';
  for (let i = 0; i < 16; i++) { const a = Math.PI + (i / 15) * Math.PI, r1 = 12, r2 = i % 2 ? 26 : 34; rays += `<path d="M${(50 + r1 * Math.cos(a)).toFixed(1)} ${(46 + r1 * Math.sin(a)).toFixed(1)} L${(50 + r2 * Math.cos(a)).toFixed(1)} ${(46 + r2 * Math.sin(a)).toFixed(1)}"/>`; }
  return `<g stroke="currentColor" stroke-width="2" fill="none">${rays}<circle cx="50" cy="46" r="10" fill="currentColor"/></g>`;
}
function stars() {
  const star = (x, y, r) => { let d = ''; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r; d += `${i ? 'L' : 'M'}${(x + rr * Math.cos(a)).toFixed(1)} ${(y + rr * Math.sin(a)).toFixed(1)}`; } return `<path d="${d}Z"/>`; };
  return `<g fill="currentColor">${star(22, 30, 7)}${star(50, 22, 10)}${star(78, 30, 7)}</g>`;
}
const TOPS = [crown, crest, sunburst, stars];
export const MOTTOS = ['Tempus fugit', 'Carpe diem', 'Festina lente', 'Ars longa, vita brevis', 'Hora ruit', 'Memento vivere', 'Dum spiro, spero', 'Nulla dies sine linea', 'Age quod agis', 'Omnia tempus habent'];
export function ornaments() {
  const side = pickR(SIDES), top = pickR(TOPS);
  const svg = (inner, flip = false, w = 100, h = 100) => `<svg viewBox="0 0 ${w} ${h}" class="np-orn${flip ? ' flip' : ''}" aria-hidden="true">${inner}</svg>`;
  return { left: svg(side()), right: svg(side(), true), top: svg(top(), false, 100, 52), motto: pickR(MOTTOS) };
}
