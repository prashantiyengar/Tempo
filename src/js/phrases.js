// Stock phrases for the newspaper. Each entry is a template: {a|b|c} picks one of the options (options can nest),
// ${name} inserts a value. With several templates per situation and several options in each slot, every
// headline and comment has hundreds of possible wordings; the choice is seeded per issue, so a paper reads the
// same every time it is opened but differently from one issue to the next.

// Expand a template with the issue's random generator.
export function say(rand, tpl, vars = {}) {
  let s = Array.isArray(tpl) ? tpl[Math.floor(rand() * tpl.length)] : tpl;
  s = s.replace(/\$\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
  // innermost {…|…} first, so options can nest
  for (let i = 0; i < 50 && /\{[^{}]*\}/.test(s); i++) {
    s = s.replace(/\{([^{}]*)\}/g, (_, body) => { const o = body.split('|'); return o[Math.floor(rand() * o.length)]; });
  }
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
}
// How many different texts a template list can produce (for the tests and the curious).
export function variety(list) {
  const count = (s) => {
    let n = 1;
    for (let i = 0; i < 50 && /\{[^{}]*\}/.test(s); i++) {
      s = s.replace(/\{([^{}]*)\}/g, (_, body) => { n *= body.split('|').length; return 'x'; });
    }
    return n;
  };
  return (Array.isArray(list) ? list : [list]).reduce((a, s) => a + count(s), 0);
}

// ---------- section names (kicker above each section) ----------
export const KICKERS = {
  lead: ['Zeitgeschehen', 'Zeitgeschehen', 'Aus dem Kalender', 'Die Lage', 'Im Brennpunkt', 'Thema der {Woche|Ausgabe}', 'Leitartikel', 'Chronik'],
  weather: ['Wetter', 'Wetter', 'Wetterbericht', 'Himmel & Wolken', 'Die Aussichten', 'Großwetterlage'],
  horoscope: ['Horoskop', 'Horoskop', 'Sterndeutung', 'Was die Sterne sagen', 'Astro-Ecke'],
  biz: ['Wirtschaft', 'Wirtschaft', 'Börse der Erledigungen', 'Produktion & Handel', 'Bilanz', 'Wirtschaftsteil', 'Der Markt'],
  pic: ['Aus dem Archiv', 'Aus dem Archiv', 'Bild der {Woche|Ausgabe}', 'Fundstück', 'Galerie', 'Damals'],
  feuil: ['Feuilleton', 'Feuilleton', 'Kultur', 'Bücher & Lesen', 'Literatur', 'Die Lesestunde'],
  goals: ['Ziele · Goal progress', 'Ziele', 'Vorsätze & Ziele', 'Zielgerade', 'Etappen'],
  words: ['Gedanke des Tages', 'Gedanke des Tages', 'Zitat der {Woche|Ausgabe}', 'Wort zum Sonntag', 'Weisheit'],
  joke: ['Zum Schmunzeln', 'Zum Schmunzeln', 'Humor', 'Die heitere Ecke', 'Zuletzt gelacht'],
  out: ['Ausblick', 'Ausblick', 'Vorschau', 'Was kommt', 'Die nächsten Tage'],
  corr: ['Korrekturen', 'Korrekturen', 'Berichtigung', 'In eigener Sache', 'Errata'],
  comment: ['Kommentar', 'Kommentar', 'Meinung', 'Analyse', 'Die Glosse', 'Standpunkt'],
  termine: ['Termine ${de}', 'Termine ${de}', 'Kalendarium ${de}', 'Veranstaltungen ${de}'],
};

// ---------- lead story ----------
export const LEAD_QUIET = [
  'A {quiet|sleepy|peaceful|tranquil|hushed} ${noun} on the calendar',
  '{Calm|Quiet|Silence} before the {storm|rush|next big thing}?',
  'The ${noun} the calendar {took a break|went on holiday|put its feet up|forgot to fill in}',
  '{Nothing to report|All quiet|No news}{ from the calendar| on the scheduling front|, and that is the news}',
  '{Empty pages|Blank squares|White space} {everywhere|as far as the eye can see|dominate the ${noun}}',
];
export const LEAD_QUIET_SUB = [
  'Hardly anything was scheduled — the editors {suspect|assume|hope for} {a holiday|an unusually good hiding place|a well-earned rest}.',
  '{Our reporters|The newsroom|Our correspondents} found {almost nothing|barely a single entry|precious little} to write about.',
  '{Either a very good ${noun} off|Either a holiday} or {a calendar left unattended|a lot of unrecorded heroics} — {we cannot tell|the record is silent|sources disagree}.',
];
export const LEAD_DOMINANT = [
  '${top} {${rules}|${dominates}} the ${noun}',
  'All eyes on ${top}',
  '${top} ${takes} the lion\'s share',
  '{Landslide|Clear victory|Runaway lead|Decisive win} for ${top}',
  '${top} {sweeps|steamrolls|conquers|owns} the calendar',
  '{The ${noun} of|A ${noun} belonging to|Unrivalled:} ${top}',
  '${top}, ${top}, {and more ${top}|and then some|from dawn to dusk}',
  '{Nothing comes close to|No rival for|Unchallenged:} ${top}',
];
export const LEAD_DOMINANT_SUB = [
  '${share}% of ${scope} occupied time went to ${top} — ${hours} in total.',
  '{Fully|Almost exactly|Roughly} ${share}% of ${scope} occupied hours: ${hours} for ${top}.',
  '${hours} for ${top}, {or|that is|which makes} ${share}% of ${scope} occupied time{. Everything else fought over the rest|. The rest were crumbs|}.',
];
export const LEAD_BALANCED = [
  'Neck and neck: ${top} ${edges} out ${second}',
  'A {balanced|varied|well-mixed|many-sided} ${noun}, led by ${top}',
  '${top} {just ahead of|a nose in front of|narrowly beats|edges past} ${second}',
  '{Close race|Photo finish|Tight contest} between ${top} and ${second}',
  '{Variety|Balance|Diversity} {wins|rules|is the theme}: ${top} {on top|in front|leads}, ${second} {close behind|not far off|right behind}',
];
export const LEAD_SINGLE = ['${top} ${leads} the ${noun}', '{All about|Mostly|A ${noun} of|Spotlight on} ${top}', '${top} {sets the tone|calls the shots|has the floor|takes centre stage|is the story}'];
export const LEAD_BALANCED_SUB = [
  '${hours} for ${top}${and2}{.| — a fair split.| — nobody ran away with it.}',
  '{The top of the table|The ranking}: ${top} with ${hours}${and2}.',
  '{No single topic dominated|Time was shared out}: ${top} with ${hours}${and2}.',
];

// ---------- analysis paragraph (commentary) ----------
export const FREE_HIGH = [
  '{A generous|A comfortable|A roomy|An enviable} {${free}%|share of ${free}%} of the {available|scheduled} hours stayed free{ — room to breathe| — space for the unexpected| — the calendar was in a forgiving mood|}.',
  '{More than half|Much} of the time stayed open ({${free}%}){; whether by design or by luck, the editors approve|. A rare luxury|}.',
];
export const FREE_MID = [
  '{About|Roughly|Some} ${free}% of the hours stayed free — {a sensible balance|neither idle nor frantic|a healthy middle ground|a reasonable buffer}.',
  'With ${free}% left open, the ${noun} {kept some slack|had a little breathing room|was busy but not crammed}.',
];
export const FREE_LOW = [
  'Only ${free}% of the hours stayed free{ — a packed ${noun}| — the calendar ran close to capacity| — little room for surprises}.',
  '{Wall-to-wall|Back-to-back|Dense} scheduling: {just|barely|merely} ${free}% left open. {Rest is advised|Pace yourself|Mind the gaps you do have}.',
  'The calendar was {full to the brim|bursting at the seams|stretched thin}, with {just|only} ${free}% of the hours free.',
];
export const BUSIEST = [
  'The busiest day was ${day}, with ${hours} spoken for.',
  '${day} {took the crown|was the high point|topped the chart|was the heavyweight} with ${hours}.',
  '{Peak traffic|Rush hour|The crunch} came on ${day}: ${hours} {booked|occupied|accounted for}.',
  '{If one day stood out|Of all the days|The record holder}, {it was|the winner was} ${day} ({${hours}|${hours} occupied}).',
];
export const RUNNERS = [
  '{Further down the ranking|Lower in the table|In the middle of the field}: ${list}.',
  '{Also on the board|Also present|Also in the mix|Supporting cast}: ${list}.',
  '{Honourable mentions|Behind the leaders|The chasing pack}: ${list}.',
];
export const COMPLETION = {
  high: ['{Plans|Intentions} {turned into results|were kept} {almost to the letter|with discipline|reliably} (${pct}%).', '${pct}% of planned sessions {done|delivered|ticked off} — {a strong showing|a record to be proud of|commendable consistency}.'],
  mid: ['${pct}% of planned sessions were done — {solid, with room to grow|respectable|a decent haul}.', '{Most|A good part} of the plan held ({${pct}%}){; the rest is a lesson in optimism|}.'],
  low: ['Only ${pct}% of planned sessions {happened|got done|survived contact with reality} — {plans may have been too ambitious|the ${noun} had other ideas|time to re-plan}.', '{A difficult|A bumpy|A rough} ${noun} for the plan: ${pct}% {delivered|done}.'],
};
export const READING_PACE = [
  '{Reading pace|The reading speed} {averaged|came to|settled at} ${pph} pages an hour.',
  '{At|With} ${pph} pages per hour, {the books moved along nicely|the reading list shrank steadily|the pages kept turning}.',
];
export const COMMENT_CLOSE = [
  '{Our verdict|The editors\' verdict|In short}: {a ${noun} worth remembering|room to improve, reasons to be pleased|carry on|steady as she goes}.',
  '{Next ${noun}, the same again?|Onwards.|Same time next ${noun}.|The newsroom will be watching.}',
  '{As always|As ever}, {the calendar tells only part of the story|the best work is often unscheduled|rest counts too}.',
];

// ---------- business ----------
export const BIZ = {
  none: ['Production halted — or just not recorded', '{Quiet|Closed|Suspended|Thin} {trading|markets|business} on the to-do exchange', 'No output figures {this ${noun}|available|reported}', '{The factory|The workshop|The office} {stood still|was dark|took a holiday}'],
  high: ['Record output: plans delivered {almost to the letter|on schedule|as promised}', 'Productivity {soars|surges|hits new highs}', 'A banner ${noun} for getting things done', '{Bull market|Boom times|Strong gains} on the to-do exchange', '{Everything|Nearly everything} {on time|according to plan}'],
  low: ['Output slumps as plans slip', 'Turbulent ${noun} on the to-do markets', '{Analysts|Economists|Observers} see {room for improvement|headwinds|a soft patch}', '{Bear market|Correction|A dip|Sell-off} on the to-do exchange', 'Plans and reality {part ways|drift apart|disagree|are not on speaking terms}'],
  mid: ['{Solid|Decent|Sound} results, a few slips', '{Steady|Modest|Healthy} growth in finished work', '{Mostly|Largely|Broadly} on track', '{Moderate|Respectable|Measured} gains on the to-do exchange', '{Business as usual|Steady trading|A workmanlike ${noun}}'],
};

// ---------- culture / books ----------
export const BOOKS = [
  'Reader devours ${pages} pages', '${pages} pages later', 'Bookworm alert: ${pages} pages',
  '{${pages} pages|A stack of ${pages} pages} {turned|read|conquered}', '{Between the covers|Book club report|From the reading chair}: ${pages} pages',
  'The {library|bookshelf} {gets a workout|is busy|reports ${pages} pages}',
];
export const NO_BOOKS = ['The library stayed quiet', '{No pages turned|Bookmarks unmoved|Dust on the shelf} {this ${noun}|for now}', 'A {quiet|bookless} ${noun} in the reading room'];

// ---------- weather ----------
export const WEATHER_H = ['The ${noun} ahead, from the sky', 'Outlook', 'Umbrella or sunglasses?', '{Clouds|Sun|Skies} {ahead|over the calendar}', 'What the sky {plans|has in store}', 'Forecast for the {coming days|week ahead}'];

// ---------- goals ----------
export const GOALS = {
  none: ['No goals on record', '{Goals|Targets} {wanted|still to be set}', 'The goal board is {empty|blank}'],
  progress: ['Goal progress', '{Where the goals stand|The state of the goals|Goal tracker|Progress report|The scoreboard}{| at a glance| in numbers}'],
  all: ['Mission accomplished: all ${n} goals reached', 'A clean sweep of goals', '{Every goal|All ${n} goals} {ticked off|reached|done} — {bravo|well played|take a bow|hats off}'],
  most: ['${k} of ${n} goals reached', '{Good progress|Well on the way|Over the hump|Into the home stretch|Strong showing}: ${k} of ${n} goals {reached|done|ticked off}', '{More than half|The majority|The bulk} of the goals {reached|done|in the bag} (${k}/${n})'],
  few: ['Goals in sight: ${k} of ${n} reached', 'Work in progress: ${k} of ${n} goals', '{Still climbing|Long way to go|Early days|Halfway is a state of mind|Room to grow|Plenty left to play for}: ${k} of ${n} goals {reached|done|so far}'],
};

// ---------- projects ----------
KICKERS.proj = ['Projekte', 'Projekte', 'Baustellen', 'Großprojekte', 'Vorhaben'];
export const PROJ_H = {
  none: ['No projects {on the books|in the works|under way}', 'The project desk {is quiet|has nothing to report}'],
  active: ['{Progress report|Construction news|Work in progress}: ${projects} {moving|advancing|under way}', '${hours} {poured into|invested in|spent on} {your projects|the projects}', '{Brick by brick|Step by step|Piece by piece}: {project news|the projects advance|${hours} of project work}'],
  finished: ['{Ribbon cut|Topping-out ceremony|Done and dusted}: ${name} {completed|finished|delivered}', '${name} {crosses the finish line|is complete|wraps up}'],
  quiet: ['{Quiet on the building sites|The scaffolding stands still|Projects on pause} {this ${noun}|for now}', 'No project work {recorded|logged} {this ${noun}|lately}'],
};

// ---------- habits ----------
KICKERS.habits = ['Gewohnheiten', 'Gewohnheiten', 'Routinen', 'Tag für Tag', 'Die Strichliste'];
export const HABIT_H = {
  strong: ['{Creature of habit|Habits stick|Routine wins}: ${pct}% {kept|on track}', '{Clockwork|Like clockwork|Steady as a metronome}: habits at ${pct}%', '${best} {leads the way|sets the pace|is unstoppable}'],
  mid: ['Habits {hold up|mostly hold|keep going}: ${pct}% {kept|done}', '{Some ups, some downs|Two steps forward|Work in progress} on the habit front', '${best} {holds steady|keeps the streak alive|stays the course}'],
  weak: ['Habits {wobble|slip|need a nudge}: ${pct}% kept', '{The habit tracker sounds the alarm|Room to grow on the habit front|Fresh start next ${noun}?}', '{Missed days pile up|A quiet ${noun} for the routines}'],
};

// ---------- game news ----------
KICKERS.game = ['Spielberichte', 'Spielberichte', 'Sportteil', 'Die Rangliste', 'Aus der Arena', 'Punktestand'];
export const GAME_H = {
  rank: ['{Promotion|Coronation|A new title}: ${who} {becomes|rises to|is now} ${rank}', '${rank}! {Level ${level} reached|The ranks open at level ${level}}', '{Trumpets sound|Banners unfurl|The crowd cheers} for the new ${rank}'],
  levelup: ['{Up, up and away|Onwards and upwards|Level up}: ${who} {reaches|climbs to|hits} level ${level}', '{Another rung climbed|Higher still|A step up}: level ${level}', '${n} new level{s|s} {this ${noun}|in one ${noun}}: now at ${level}'],
  clean: ['{Clean sheet|Not a drop lost|Spotless}: ${days} drain-free day{s|s} {in a row|and counting}', '{Discipline pays|Temptation resisted|Willpower wins}: ${xp} XP {earned|banked} this ${noun}'],
  drained: ['{XP leaks|The drain gurgles|Points down the plughole}: −${drain} XP {lost|drained} this ${noun}', '{Costly distractions|A leaky ${noun}}: ${drain} XP {gone|drained}'],
  steady: ['{Steady progress|Points on the board|The tally grows}: +${xp} XP {this ${noun}|in the ${noun}}', '${who} {gathers|collects|earns} ${xp} XP {this ${noun}|and keeps climbing}', '{Quiet climb|On the way up}: ${xp} XP to level ${next}'],
};

// ---------- outlook ----------
export const OUT_RISK = ['Storm warning for the to-do list', 'Deadlines loom', '{Choppy waters|Heavy weather|Rough seas} ahead', '{Brace yourself|Batten down the hatches}: deadlines {approach|close in}', 'Red flags on the horizon'];
export const OUT_CLEAR = ['Clear skies ahead', 'Next ${noun} looks manageable', '{Smooth sailing|Fair weather|Calm waters} ahead', 'No {storms|clouds|alarms} on the horizon', '{The road ahead is clear|All systems go}'];

// ---------- corrections ----------
export const CORR_NONE = [
  'No corrections {this ${noun}|in this issue}. The editors are {insufferable|unbearable|very smug} about it.',
  '{Not a single|No} correction {needed|to print}. {The fact-checkers are on holiday|Our proofreaders are bored|Champagne in the newsroom}.',
  'Everything appeared exactly as printed. {Remarkable|Unprecedented|We are as surprised as you are}.',
];
export const CORR_INTRO = [
  'In our planning of ${period}, the following ${items} did not appear as printed:',
  '{Our|The} {schedule|plan} for ${period} contained {errors|inaccuracies|optimism}:',
  '{A correction|Corrections} to our plan for ${period}:',
];
export const CORR_OUTRO = ['We regret the error.', '{We apologise|Our apologies} {for any confusion|to our readers}.', 'The editors have been spoken to.', 'The responsible planner has been {reassigned|given a stern look}.'];

// ---------- Remembrance of Things Past: Proustian epigraphs, asides and epithets (original pastiche) ----------
export const PROUST_EPIGRAPHS = [
  'For a long time I used to plan my {days|weeks} early.',
  'The real voyage of discovery lies not in finding new hours, but in seeing the old ones with new eyes.',
  'Every {hour|afternoon} we lose is kept somewhere, folded like a letter we have not yet reread.',
  'The calendar remembers what the heart has already begun to forget.',
  'Time, which changes people, does not alter the image we have kept of our {Tuesdays|mornings|evenings}.',
  'It is in the smallest appointment that the whole of a life lies hidden.',
  'We do not receive wisdom; we must discover it for ourselves, one ${noun} at a time.',
  'The hours we did not schedule are perhaps the ones we lived most fully.',
  'A single cup of tea, and the whole ${noun} rose up again, with its streets and its errands.',
  'Habit is a second nature that keeps us from knowing the first — and from finishing chapter two.',
  'Our {days|hours} are like those Japanese paper flowers that open only once they touch the water of memory.',
  'Happiness is beneficial for the body, but it is the ${noun} of disappointments that develops the powers of the mind.',
  'Let us be grateful to the {meetings|errands|lists} that make us happy; they are the charming gardeners of our ${noun}.',
  'The past is not simply gone; it waits, like an unopened diary, in the drawer of the {week|month}.',
  'Nothing is so faithful as a recurring event, nor so forgetful as its attendees.',
  'We imagined the ${noun} ahead; we did not imagine how slowly the afternoons would pass.',
  'In the end, the only true paradises are the {weeks|hours} we have lost.',
  'Each ${noun} is a cathedral built of small, patient minutes.',
  'The bells of {Combray|the town hall|a distant church} counted the hours we had promised to someone else.',
  'Memory, that capricious archivist, files the {lunches|deadlines|walks} wherever it pleases.',
  'One does not plan a ${noun}; one remembers it into existence afterwards.',
  'There are {mornings|days} whose whole perfume is contained in a single unchecked box.',
  'The heart keeps no calendar, yet it knows to the minute when we arrived late.',
  'How many {Sundays|evenings} have dissolved, like sugar, into the warm tea of routine.',
  'Love of time, like any love, begins with the fear of losing it.',
  'An hour is not merely an hour; it is a vase filled with perfumes, sounds, projects and climates.',
  'We are never so far from our ambitions as when we schedule them for tomorrow.',
  'The ${noun} passed as hawthorns pass: we noticed them only when they had gone out of bloom.',
  'What we call reality is a certain relationship between our sensations and the {appointments|tasks|reminders} that surround us.',
  'Perhaps the immobility of the things around us — the desk, the clock — is forced upon them by our certainty that they are on schedule.',
  'Days, in the end, are not lived one after the other; they are kept, layered, like the pages of an old {almanac|ledger|novel}.',
  'Long after the events are over, the smell of the {coffee|rain|ink} remains to tell us what we did.',
  'The things we most want to do, we keep for a ${noun} that never quite arrives.',
  'A week is the shortest novel we write without knowing the ending.',
];
export const PROUST_ASIDES = [
  '— and, as with the madeleine, a single {hour|moment} unfolded into a whole ${noun}.',
  '— a detail which, years from now, will be all that remains of this ${noun}.',
  '— though memory, ever the embellisher, will no doubt make it longer.',
  '— or so the calendar, that faithful but unfeeling witness, insists.',
  '— a fact our correspondent recalls only through a haze of {tea|lime-blossom|afternoon light}.',
  '— each minute laid down like a pressed flower between the pages of the ${noun}.',
  '— which, like all things truly felt, went entirely unscheduled.',
  '— a duration that the heart measured quite differently from the clock.',
  '— as though the hours themselves had been waiting, patiently, to be noticed.',
  '— and one would almost swear one could hear the bells of {Combray|Balbec|a distant steeple} marking it.',
  '— an arrangement of hours as delicate, and as provisional, as a seating plan at the Guermantes.',
  '— and who among us, reading this, does not feel the faint ache of a ${noun} that will not return?',
  '— a modest triumph, but then the greatest are rarely announced.',
  '— the sort of {afternoon|evening|morning} one recognises only when it has already become the past.',
  '— about which, as about all things, there is more to remember than there was to see.',
  '— as the hawthorns, so the deadlines: lovelier in recollection than at the time.',
  '— and the reader will forgive us for lingering on it longer than it lasted.',
  '— a figure that, like a face glimpsed from a train, refuses to stay still.',
  '— time regained, if only on paper.',
  '— the chronicler notes it with that tenderness one reserves for small, unremarked victories.',
  '— the minutes, it must be said, had a scent of {rain|toast|old paper} about them.',
  '— recorded here so that it may, one day, be lovingly misremembered.',
  '— for there is no hour so ordinary that memory cannot gild it.',
  '— a thread one may pull, years hence, to unravel the whole ${noun}.',
  '— which proves once again that habit, that skilful arranger, has its reasons.',
  '— though whether it was {Monday|Thursday|a Sunday} or merely felt like one, the record cannot say.',
  '— one of those intermittences of the heart that the calendar faithfully ignores.',
  '— and somewhere, a teaspoon touched the edge of a cup.',
  '— in a sentence that, like this one, seemed reluctant to end.',
  '— which is perhaps all one can ask of any ${noun}: that it leave a trace.',
  '— a little like a sonata whose phrase returns just when one had stopped expecting it.',
  '— the past, as always, being more punctual than the present.',
  '— the light, at that hour, fell exactly as it had on some {forgotten|half-remembered|distant} summer.',
  '— and so the ${noun} slipped gently into the vast, accommodating archive of things past.',
  '— as surely as the steeple of Saint-Hilaire once rose above the rooftops.',
  '— a reminder that the slowest minutes are often the ones we keep longest.',
];
export const PROUST_EPITHETS = [
  'the ${noun} of lost time', 'the ${noun} of long sentences', 'a ${noun} scented with lime-blossom tea', 'the ${noun} of the madeleine',
  'a ${noun} seen through the window of a slow train', 'the ${noun} of intermittent hearts', 'a ${noun} of hawthorn and deadlines',
  'the ${noun} of Swann\'s way', 'a ${noun} in the shadow of young appointments', 'the ${noun} of the Guermantes\' calendar',
  'a ${noun} recaptured', 'the ${noun} the bells of Combray counted', 'a ${noun} of half-remembered afternoons', 'the ${noun} of unopened letters',
  'a ${noun} of sea-light at Balbec', 'the ${noun} of patient minutes', 'a ${noun} like a pressed flower', 'the ${noun} that smelled of rain',
  'a ${noun} of small cathedrals', 'the ${noun} of Sunday tea', 'a ${noun} of quiet triumphs', 'the ${noun} the heart kept',
  'a ${noun} folded like a letter', 'the ${noun} of the little phrase', 'a ${noun} between two sleeps', 'the ${noun} of the steeple and the clock',
  'a ${noun} of gilded recollection', 'the ${noun} of soft lamplight', 'a ${noun} of habit and wonder', 'the ${noun} of time regained',
];
