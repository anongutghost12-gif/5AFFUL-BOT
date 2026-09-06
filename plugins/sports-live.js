const { cmd } = require('../lib/plugins');
const cheerio = require('cheerio');
let fetch;
try { fetch = require('node-fetch'); } catch { fetch = globalThis.fetch; }

function log(msg) {
  process.stderr.write('[safful-sports] ' + msg + '\n');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// ─── League mappings ───────────────────────────────────────────────────────
const LEAGUES = {
  epl:         { espnId: 'eng.1',          rapidId: 47, name: 'Premier League',  emoji: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  laliga:      { espnId: 'esp.1',          rapidId: 87, name: 'La Liga',          emoji: '🇪🇸' },
  seriea:      { espnId: 'ita.1',          rapidId: 55, name: 'Serie A',          emoji: '🇮🇹' },
  bundesliga:  { espnId: 'ger.1',          rapidId: 54, name: 'Bundesliga',       emoji: '🇩🇪' },
  ligue1:      { espnId: 'fra.1',          rapidId: 53, name: 'Ligue 1',          emoji: '🇫🇷' },
  ucl:         { espnId: 'uefa.champions', rapidId: 42, name: 'Champions League', emoji: '⚽' },
  europa:      { espnId: 'uefa.europa',    rapidId: 73, name: 'Europa League',    emoji: '🏆' },
  eredivisie:  { espnId: 'ned.1',          rapidId: 57, name: 'Eredivisie',       emoji: '🇳🇱' },
};

// ─── ESPN live scores, standings and scorers (no API token) ────────────────
async function espnRequest(url, asText = false) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: asText ? 'text/html' : 'application/json' },
    timeout: 15000,
  });
  if (!res.ok) throw new Error('Sports data service ' + res.status);
  return asText ? await res.text() : await res.json();
}

async function espnLive(leagueId) {
  const id = leagueId || 'all';
  const data = await espnRequest('https://site.web.api.espn.com/apis/site/v2/sports/soccer/' + encodeURIComponent(id) + '/scoreboard');
  return (data.events || []).filter(event => event.status?.type?.state === 'in');
}

function collectStandingEntries(node, output = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectStandingEntries(item, output);
  } else if (node && typeof node === 'object') {
    if (Array.isArray(node.standings?.entries)) output.push(...node.standings.entries);
    if (Array.isArray(node.children)) collectStandingEntries(node.children, output);
  }
  return output;
}

async function espnStandings(leagueId) {
  const data = await espnRequest('https://site.web.api.espn.com/apis/v2/sports/soccer/' + encodeURIComponent(leagueId) + '/standings');
  return collectStandingEntries(data.children || data);
}

async function espnScorers(leagueId) {
  const html = await espnRequest('https://www.espn.com/soccer/stats/_/league/' + encodeURIComponent(leagueId), true);
  const $ = cheerio.load(html);
  const scorers = [];
  $('.top-score-table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 5 || scorers.length >= 10) return;
    scorers.push({
      name: $(cells[1]).text().trim(),
      team: $(cells[2]).text().trim(),
      appearances: Number($(cells[3]).text().trim()) || 0,
      goals: Number($(cells[4]).text().trim()) || 0,
    });
  });
  return scorers;
}

// ─── RapidAPI fallback ─────────────────────────────────────────────────────

const VERIFIED_FOOTBALL_KEY = '838a49c740msh66f2cc2a92d1ddcp1e3662jsne682454bc725';
const rejectedRapidApiKeys = new Set();

function getRapidApiKeys() {
  const configured = (process.env.RAPIDAPI_KEYS || process.env.RAPIDAPI_KEY || '')
    .split(',')
    .map(key => key.trim())
    .filter(Boolean);
  return [...new Set([...configured, VERIFIED_FOOTBALL_KEY])];
}

async function rapidRequest(path) {
  const host = 'free-api-live-football-data.p.rapidapi.com';
  let lastError;
  for (const key of getRapidApiKeys()) {
    if (rejectedRapidApiKeys.has(key)) continue;
    const res = await fetch('https://' + host + path, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host },
      timeout: 15000,
    });
    if (res.ok) return await res.json();

    lastError = new Error('RapidAPI ' + res.status);
    if ([401, 403, 429].includes(res.status)) {
      rejectedRapidApiKeys.add(key);
      continue;
    }
    throw lastError;
  }
  throw lastError || new Error('No usable RapidAPI key');
}

const fixtureCache = new Map();

async function rapidFixtures(leagueId) {
  const cached = fixtureCache.get(leagueId);
  if (cached && cached.expires > Date.now()) return cached.matches;

  const data = await rapidRequest('/football-get-all-matches-by-league?leagueid=' + encodeURIComponent(leagueId));
  let matches = selectUpcomingFixtures(data.response?.matches || []);

  // The provider's season endpoint sometimes lags behind its daily feed.
  // Fall back to the next two weeks of dated fixtures when that happens.
  if (!matches.length) {
    const requests = [];
    for (let day = 0; day < 14; day++) {
      const date = new Date(Date.now() + day * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
      requests.push(rapidRequest('/football-get-matches-by-date?date=' + date));
    }
    const results = await Promise.allSettled(requests);
    const successful = results.filter(result => result.status === 'fulfilled');
    if (!successful.length) throw results[0]?.reason || new Error('RapidAPI fixture lookup failed');
    const datedMatches = successful
      .flatMap(result => result.value.response?.matches || [])
      .filter(match => Number(match.leagueId) === Number(leagueId));
    matches = selectUpcomingFixtures(datedMatches);
  }

  fixtureCache.set(leagueId, { expires: Date.now() + 15 * 60 * 1000, matches });
  return matches;
}

function selectUpcomingFixtures(matches, now = Date.now()) {
  return matches
    .filter(match => {
      const kickoff = Date.parse(match.status?.utcTime || '');
      return !match.status?.finished
        && !match.status?.cancelled
        && (match.notStarted === true || (Number.isFinite(kickoff) && kickoff > now));
    })
    .sort((a, b) => Date.parse(a.status?.utcTime || '') - Date.parse(b.status?.utcTime || ''))
    .slice(0, 10);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatMatch(m) {
  const home = m.homeTeam?.name || m.teams?.home?.name || '???';
  const away = m.awayTeam?.name || m.teams?.away?.name || '???';
  const homeScore = m.score?.fullTime?.home ?? m.goals?.home ?? '-';
  const awayScore = m.score?.fullTime?.away ?? m.goals?.away ?? '-';
  const status = m.status || m.fixture?.status?.short || '?';
  const elapsed = m.minute || m.fixture?.status?.elapsed;

  let emoji = '⏰';
  if (status === 'FINISHED') emoji = '✅';
  else if (status === 'TIMED' || status === 'SCHEDULED') emoji = '🕐';
  else if (['IN_PLAY', 'PAUSED', 'HALFTIME', 'LIVE'].includes(status)) emoji = '🔴';

  const timeStr = elapsed ? ' (' + elapsed + "')" : '';
  return emoji + ' ' + home + ' *' + homeScore + '* - *' + awayScore + '* ' + away + timeStr;
}

function formatEspnMatch(event) {
  const competition = event.competitions?.[0] || {};
  const home = (competition.competitors || []).find(team => team.homeAway === 'home') || {};
  const away = (competition.competitors || []).find(team => team.homeAway === 'away') || {};
  const minute = event.status?.type?.shortDetail || competition.status?.type?.shortDetail || 'LIVE';
  return '🔴 ' + (home.team?.displayName || '???') + ' *' + (home.score ?? '-') + '* - *' + (away.score ?? '-') + '* ' + (away.team?.displayName || '???') + ' (' + minute + ')';
}

function statValue(row, name) {
  return row.stats?.find(stat => stat.name === name)?.value ?? 0;
}

function formatStanding(row) {
  const rank = statValue(row, 'rank') || '?';
  const team = row.team?.displayName || row.team?.name || '???';
  const played = statValue(row, 'gamesPlayed');
  const won = statValue(row, 'wins');
  const draw = statValue(row, 'ties');
  const lost = statValue(row, 'losses');
  const pts = statValue(row, 'points');
  const gd = statValue(row, 'pointDifferential');
  return rank + '. ' + team + ' — ' + played + 'P ' + won + 'W ' + draw + 'D ' + lost + 'L *' + pts + 'pts* (GD:' + (gd > 0 ? '+' : '') + gd + ')';
}

// ─── LIVE MATCHES ─────────────────────────────────────────────────────────

cmd({
  pattern: 'live',
  alias: ['livescore', 'livescores', 'nowplaying'],
  desc: 'Show live football scores',
  category: 'sports',
  use: '.live [league]',
}, async (mek, text, extra) => {
  log('.live called');
  const input = String(text || '').trim().toLowerCase();

  try {
    const league = LEAGUES[input];
    const matches = await espnLive(league?.espnId);

    if (matches.length === 0) {
      return mek.reply('*No live matches right now.* ⚽\n\nTry `.live epl` for a specific league.');
    }

    let msg = '*⚽ Live Scores' + (league ? ' — ' + league.name : '') + '*\n\n';
    const byComp = {};
    for (const m of matches) {
      const cid = m.leagueUid || m.leagueName || 'other';
      if (!byComp[cid]) byComp[cid] = { name: m.leagueName || league?.name || 'Football', matches: [] };
      byComp[cid].matches.push(m);
    }
    for (const [, comp] of Object.entries(byComp)) {
      msg += '*' + comp.name + '*\n';
      for (const m of comp.matches.slice(0, 10)) {
        msg += formatEspnMatch(m) + '\n';
      }
      msg += '\n';
    }
    await mek.reply(msg.trim());
  } catch (err) {
    log('Error: ' + err.message);
    await mek.reply('*Error:* ' + String(err.message).slice(0, 200));
  }
});

module.exports = { rapidFixtures, selectUpcomingFixtures, espnLive, espnStandings, espnScorers };

// ─── STANDINGS ────────────────────────────────────────────────────────────

cmd({
  pattern: 'standings',
  alias: ['table', 'league'],
  desc: 'Show league standings',
  category: 'sports',
  use: '.standings <league>\n\nLeagues: epl, laliga, seriea, bundesliga, ligue1, ucl',
}, async (mek, text, extra) => {
  log('.standings called');
  const input = String(text || '').trim().toLowerCase();

  const league = LEAGUES[input];
  if (!league) {
    const list = Object.entries(LEAGUES).map(([k, v]) => '• `.standings ' + k + '` — ' + v.name).join('\n');
    return mek.reply('*Choose a league:*\n\n' + list);
  }

  try {
    const table = await espnStandings(league.espnId);

    if (table.length === 0) return mek.reply('*No standings available for ' + league.name + '*');

    let msg = '*' + league.emoji + ' ' + league.name + ' Standings*\n\n';
    for (const row of table.slice(0, 20)) {
      msg += formatStanding(row) + '\n';
    }
    await mek.reply(msg.trim());
  } catch (err) {
    log('Error: ' + err.message);
    await mek.reply('*Error:* ' + String(err.message).slice(0, 200));
  }
});

// ─── UPCOMING FIXTURES ───────────────────────────────────────────────────

cmd({
  pattern: 'fixtures',
  alias: ['upcoming', 'fixture', 'schedule', 'nextmatches'],
  desc: 'Show upcoming fixtures for a league',
  category: 'sports',
  use: '.fixtures <league>',
}, async (mek, text, extra) => {
  log('.fixtures called');
  const input = String(text || '').trim().toLowerCase();

  const league = LEAGUES[input];
  if (!league) {
    const list = Object.entries(LEAGUES).map(([k, v]) => '• `.fixtures ' + k + '` — ' + v.name).join('\n');
    return mek.reply('*Choose a league:*\n\n' + list);
  }

  try {
    const matches = await rapidFixtures(league.rapidId);

    if (matches.length === 0) return mek.reply('*No upcoming fixtures for ' + league.name + '*');

    let msg = '*' + league.emoji + ' ' + league.name + ' — Upcoming*\n\n';
    for (const m of matches) {
      const utcDate = m.status?.utcTime;
      const date = utcDate ? new Date(utcDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'TBD';
      const time = utcDate ? new Date(utcDate).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
      const home = m.homeTeam?.name || '???';
      const away = m.awayTeam?.name || '???';
      msg += '📅 ' + date + ' ' + time + '\n' + home + ' vs ' + away + '\n\n';
    }
    await mek.reply(msg.trim());
  } catch (err) {
    log('Error: ' + err.message);
    await mek.reply('*Error:* ' + String(err.message).slice(0, 200));
  }
});

// ─── TOP SCORERS ─────────────────────────────────────────────────────────

cmd({
  pattern: 'scorers',
  alias: ['topscorers', 'topscorer', 'goals'],
  desc: 'Show top scorers in a league',
  category: 'sports',
  use: '.scorers <league>',
}, async (mek, text, extra) => {
  log('.scorers called');
  const input = String(text || '').trim().toLowerCase();

  const league = LEAGUES[input];
  if (!league) {
    const list = Object.entries(LEAGUES).map(([k, v]) => '• `.scorers ' + k + '` — ' + v.name).join('\n');
    return mek.reply('*Choose a league:*\n\n' + list);
  }

  try {
    const scorers = await espnScorers(league.espnId);

    if (scorers.length === 0) return mek.reply('*No scorer data available for ' + league.name + '*');

    let msg = '*' + league.emoji + ' ' + league.name + ' Top Scorers*\n\n';
    for (const s of scorers) {
      const name = s.name || '???';
      const team = s.team || '';
      const goals = s.goals || 0;
      msg += '*' + goals + '* ⚽ ' + name + ' (' + team + ') — ' + s.appearances + ' apps\n';
    }
    await mek.reply(msg.trim());
  } catch (err) {
    log('Error: ' + err.message);
    await mek.reply('*Error:* ' + String(err.message).slice(0, 200));
  }
});
