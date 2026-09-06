// ---------------------------------------------------------------------------
// Hacking tools — .iplookup .domainwhois .dns .sslcheck .portscan .nmap
//                 .malwarecheck .urlscan
//
// Readable rewrite of the old obfuscated plugin. Every command uses a FREE,
// keyless API where one exists:
//
//   .iplookup     → ipwho.is (HTTPS, no key)  [fallback ipapi.co]
//   .domainwhois  → RDAP via rdap.org (no key, follows to the right registry)
//   .dns          → Google DNS-over-HTTPS (no key)
//   .sslcheck     → Cert Spotter public endpoint (no key)
//   .portscan     → local TCP connect probes (no API at all)
//   .nmap         → local TCP connect probes, extended port list
//   .malwarecheck → urlscan.io public search (no key — only prior scans)
//   .urlscan      → urlscan.io search; submission only with URLSCAN_API_KEY
//
// Optional keys (set in the panel env or .env, NOT required):
//   URLSCAN_API_KEY  — lets .urlscan submit new scans
// ---------------------------------------------------------------------------
const net = require('net')
const dns = require('dns').promises
const { cmd } = require('../lib/plugins')

const HACK = 'hacking'

function log(...a) {
  console.log('[safful-hack]', ...a)
}

async function getJson(url, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeout || 15000)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 (compatible; safful-md/1.0)' }, opts.headers || {}),
      ...(opts.fetch || {}),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function firstArg(args) {
  const s = String(args || '').trim()
  return s.split(/\s+/)[0] || ''
}

function cleanHost(input) {
  let host = String(input || '').trim()
  host = host.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
  host = host.split('/')[0].split(':')[0]
  return host
}

// ---------------------------------------------------------------------------
// .iplookup / .ip / .geoip / .whoisip
// ---------------------------------------------------------------------------
cmd(
  {
    pattern: 'iplookup',
    alias: ['ip', 'geoip', 'whoisip'],
    desc: 'Look up IP address / domain location, ISP & security flags (free keyless API).',
    category: HACK,
    use: '.iplookup 8.8.8.8',
    filename: __filename,
  },
  async (m, args) => {
    const input = firstArg(args)
    if (!input) return m.reply('*Usage:* `.iplookup 8.8.8.8` or `.iplookup example.com`')
    try {
      let target = cleanHost(input)
      const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(target)
      if (!isIp) {
        try {
          const [{ address }] = await dns.lookup(target, { family: 4 })
          if (address) target = address
        } catch (e) { /* keep hostname; API may resolve */ }
      }
      let data = null
      try {
        data = await getJson('https://ipwho.is/' + encodeURIComponent(target))
      } catch (e) {
        try {
          data = await getJson('https://ipapi.co/' + encodeURIComponent(target) + '/json/')
        } catch (e2) { throw new Error('Both IP APIs failed: ' + (e.message || e)) }
      }
      if (!data) return m.reply('*Could not look up IP: ' + input + '*')
      const sec = data.security || {}
      const conn = data.connection || {}
      const flagEmoji = (data.flag && data.flag.emoji) || ''
      const tz = typeof data.timezone === 'string' ? data.timezone : (data.timezone && data.timezone.id) || '—'
      const yesno = (v) => (v === true || v === 1 || (typeof v === 'string' && /^(true|1|yes)$/i.test(v)) ? '⚠️ Yes' : 'No')
      const country = [data.country, data.country_code ? '(' + data.country_code + ')' : ''].filter(Boolean).join(' ')
      const postal = [data.postal ? 'ZIP ' + data.postal : '', data.calling_code ? '+' + data.calling_code : ''].filter(Boolean).join(' · ')
      const lines = [
        '*IP Lookup — ' + (data.ip || target) + '*',
        '• Type: ' + (data.type || '—'),
        '• Country: ' + (flagEmoji ? flagEmoji + ' ' : '') + (country || '—'),
        '• Region: ' + ([data.region, data.city].filter(Boolean).join(' / ') || '—'),
        '• Postal / Calling: ' + (postal || '—'),
        '• Coordinates: ' + ([data.latitude, data.longitude].filter(Boolean).join(', ') || '—'),
        '• Timezone: ' + tz,
        '• ISP: ' + (conn.isp || data.isp || '—'),
        '• Organization: ' + (conn.org || data.org || '—') + (conn.domain ? ' (' + conn.domain + ')' : ''),
        '• ASN: ' + (conn.asn || data.as || '—'),
        '• Proxy: ' + yesno(sec.proxy) + ' • VPN: ' + yesno(sec.vpn) + ' • TOR: ' + yesno(sec.tor),
      ]
      // Reverse DNS (PTR) for plain IP queries — best effort
      if (isIp && /^\d{1,3}(\.\d{1,3}){3}$/.test(target)) {
        try {
          const hosts = await dns.reverse(target)
          if (hosts && hosts.length) {
            const idx = lines.findIndex((l) => l.startsWith('• Timezone:'))
            lines.splice(idx + 1, 0, '• Hostname (rDNS): ' + hosts[0])
          }
        } catch (e) { /* no PTR record */ }
      }
      return m.reply(lines.join('\n'))
    } catch (e) {
      log('iplookup error:', (e && e.message) || e)
      return m.reply('*Error:* ' + ((e && e.message) || e))
    }
  }
)

// ---------------------------------------------------------------------------
// .domainwhois / .domaininfo / .dwhois  — RDAP, free & keyless
// ---------------------------------------------------------------------------
cmd(
  {
    pattern: 'domainwhois',
    alias: ['domaininfo', 'dwhois'],
    desc: 'WHOIS/registration data for a domain via free RDAP (no key).',
    category: HACK,
    use: '.domainwhois example.com',
    filename: __filename,
  },
  async (m, args) => {
    const input = firstArg(args)
    if (!input) return m.reply('*Usage:* `.domainwhois example.com`')
    const domain = cleanHost(input)
    try {
      const data = await getJson('https://rdap.org/domain/' + encodeURIComponent(domain), { timeout: 20000 })
      const events = {}
      for (const ev of data.events || []) events[ev.eventAction] = ev.eventDate
      const entityInfo = (entity) => {
        try {
          const vc = entity.vcardArray && entity.vcardArray[1]
          if (!vc) return { name: '', email: '', tel: '' }
          const get = (f) => {
            const r = vc.find((x) => x[0] === f)
            return r ? (Array.isArray(r[3]) ? r[3].join(', ') : String(r[3] || '')) : ''
          }
          return { name: get('fn') || get('org'), email: get('email'), tel: get('tel') }
        } catch (e) { return { name: '', email: '', tel: '' } }
      }
      const contact = (info) => {
        if (!info || !info.name) return '—'
        let out = info.name
        if (info.email) out += ' · ' + info.email
        if (info.tel) out += ' · ' + info.tel
        return out
      }
      const byRole = {}
      let registrarInfo = null
      let fallbackInfo = null
      for (const ent of data.entities || []) {
        const roles = ent.roles || []
        const info = entityInfo(ent)
        if (!fallbackInfo) fallbackInfo = info
        if (roles.includes('registrar') && !registrarInfo) registrarInfo = info
        for (const role of roles) {
          if (!byRole[role] && ['registrant', 'administrative', 'technical', 'abuse'].includes(role)) byRole[role] = info
        }
      }
      const registrar = registrarInfo || (byRole.abuse ? null : fallbackInfo)
      const ns = (data.nameservers || []).map((n) => n.ldhName).filter(Boolean)
      const ds = data.secureDNS || {}
      const dsData = (ds.dsData || [])[0]
      const lines = [
        '*Domain WHOIS — ' + (data.ldhName || domain) + '*',
        '• Status: ' + ((data.status || []).join(', ') || '—'),
        '• Registered: ' + (events.registration || '—'),
        '• Updated: ' + (events['last changed'] || '—'),
        '• Expires: ' + (events.expiration || '—'),
        '• Registrar: ' + contact(registrar),
        '• Registrant: ' + contact(byRole.registrant),
        '• Administrative: ' + contact(byRole.administrative),
        '• Technical: ' + contact(byRole.technical),
        '• Abuse contact: ' + contact(byRole.abuse),
        '• Nameservers: ' + (ns.length ? ns.slice(0, 6).join(', ') + (ns.length > 6 ? ' (+' + (ns.length - 6) + ' more)' : '') : '—'),
        '• DNSSEC: ' + (ds.delegationSigned ? 'Yes' + (dsData ? ' (DS keyTag ' + dsData.keyTag + ', algorithm ' + dsData.algorithm + ')' : '') : 'No'),
      ]
      if (!events.registration && !events.expiration && !(data.entities || []).length && !ns.length) {
        return m.reply('*No WHOIS data found for ' + domain + '*')
      }
      return m.reply(lines.join('\n'))
    } catch (e) {
      log('whois error:', (e && e.message) || e)
      return m.reply('*No WHOIS data found for ' + domain + '*')
    }
  }
)

// ---------------------------------------------------------------------------
// .dns / .dnslookup / .nslookup — Google DNS-over-HTTPS
// ---------------------------------------------------------------------------
cmd(
  {
    pattern: 'dns',
    alias: ['dnslookup', 'nslookup'],
    desc: 'DNS records for a domain via free DNS-over-HTTPS (no key).',
    category: HACK,
    use: '.dns example.com',
    filename: __filename,
  },
  async (m, args) => {
    const input = firstArg(args)
    if (!input) return m.reply('*Usage:* `.dns example.com`')
    const host = cleanHost(input)
    try {
      const types = ['A', 'AAAA', 'MX', 'NS', 'TXT']
      const sections = []
      for (const type of types) {
        try {
          const res = await getJson('https://dns.google/resolve?name=' + encodeURIComponent(host) + '&type=' + type)
          const answers = res.Answer || []
          if (!answers.length) continue
          const vals = answers.map((a) => {
            let v = a.data || ''
            if (type === 'MX') {
              const sp = v.split(' ')
              v = sp.length > 1 ? 'priority ' + sp[0] + ' → ' + sp.slice(1).join(' ') : v
            }
            return v
          })
          sections.push('• *' + type + ':*\n   ' + vals.slice(0, 8).join('\n   '))
        } catch (e) { /* skip type */ }
      }
      if (!sections.length) return m.reply('*No DNS records found for ' + host + '*')
      return m.reply('*DNS Lookup — ' + host + '*\n' + sections.join('\n'))
    } catch (e) {
      log('dns error:', (e && e.message) || e)
      return m.reply('*Error:* ' + ((e && e.message) || e))
    }
  }
)

// ---------------------------------------------------------------------------
// .sslcheck / .ssl — Cert Spotter public endpoint
// ---------------------------------------------------------------------------
cmd(
  {
    pattern: 'sslcheck',
    alias: ['ssl'],
    desc: 'Check SSL certificate(s) issued for a domain (free Cert Spotter API).',
    category: HACK,
    use: '.sslcheck google.com',
    filename: __filename,
  },
  async (m, args) => {
    const input = firstArg(args)
    if (!input) return m.reply('*Usage:* `.sslcheck google.com`')
    const host = cleanHost(input)
    try {
      const data = await getJson(
        'https://api.certspotter.com/v1/issuances?domain=' + encodeURIComponent(host) +
        '&include_subdomains=true&expand=dns_names&expand=issuer'
      )
      if (!data || !data.length) return m.reply('*No SSL certificate found for ' + host + '*')
      const first = data[0]
      const issuer = (first.issuer && (first.issuer.friendly_name || first.issuer.name)) || '—'
      const names = (first.dns_names || []).slice(0, 5).join(', ')
      const lines = [
        '*SSL Certificate — ' + host + '*',
        '• Issuer: ' + issuer,
        '• Domains: ' + (names || '—'),
        '• Valid From: ' + (first.not_before || '—'),
        '• Valid Until: ' + (first.not_after || '—'),
        '• Certificates found: ' + data.length,
      ]
      return m.reply(lines.join('\n'))
    } catch (e) {
      log('sslcheck error:', (e && e.message) || e)
      return m.reply('*No SSL certificate found for ' + host + '*')
    }
  }
)

// ---------------------------------------------------------------------------
// Port probing core (used by .portscan and .nmap) — pure local TCP checks
// ---------------------------------------------------------------------------
const PORT_SCAN_PORTS = [
  [21, 'FTP'], [22, 'SSH'], [25, 'SMTP'], [53, 'DNS'], [80, 'HTTP'],
  [110, 'POP3'], [143, 'IMAP'], [443, 'HTTPS'], [993, 'IMAPS'], [995, 'POP3S'],
  [3306, 'MySQL'], [3389, 'RDP'], [5432, 'PostgreSQL'], [8080, 'HTTP-Alt'], [8443, 'HTTPS-Alt'],
]
const NMAP_PORTS = [
  [21, 'FTP'], [22, 'SSH'], [25, 'SMTP'], [53, 'DNS'], [80, 'HTTP'],
  [110, 'POP3'], [143, 'IMAP'], [443, 'HTTPS'], [993, 'IMAPS'], [995, 'POP3S'],
  [3306, 'MySQL'], [5432, 'PostgreSQL'], [6379, 'Redis'], [8080, 'HTTP-Alt'],
  [8443, 'HTTPS-Alt'], [27017, 'MongoDB'],
]

function probePort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    const done = (open) => { sock.destroy(); resolve(open) }
    sock.setTimeout(timeoutMs || 2500)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
    sock.connect(port, host)
  })
}

async function scanPorts(host, list) {
  const results = []
  const queue = list.map(([port, name]) => ({ port, name }))
  const worker = async () => {
    while (queue.length) {
      const job = queue.shift()
      const open = await probePort(host, job.port)
      results.push({ ...job, open })
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  return results.sort((a, b) => a.port - b.port)
}

function portReport(host, results, title) {
  const open = results.filter((r) => r.open)
  const rows = results.map((r) => (r.open ? '🟢' : '🔴') + ' ' + r.port + '/' + r.name + (r.open ? ' — OPEN' : ' — closed'))
  return [
    '*' + title + ' — ' + host + '*',
    '*Open:* ' + open.length + '/' + results.length + ' ports',
    '',
    '```',
    rows.join('\n'),
    '```',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// .portscan / .ports / .scanport
// ---------------------------------------------------------------------------
cmd(
  {
    pattern: 'portscan',
    alias: ['ports', 'scanport'],
    desc: 'Check 15 common ports on a host (local TCP probes, no API).',
    category: HACK,
    use: '.portscan example.com',
    filename: __filename,
  },
  async (m, args) => {
    const input = firstArg(args)
    if (!input) return m.reply('*Usage:* `.portscan example.com`')
    const host = cleanHost(input)
    try {
      log('.portscan ' + host)
      const results = await scanPorts(host, PORT_SCAN_PORTS)
      return m.reply(portReport(host, results, 'Port Scan'))
    } catch (e) {
      return m.reply('*Port scan failed:* ' + ((e && e.message) || e))
    }
  }
)

// ---------------------------------------------------------------------------
// .nmap / .netscan / .hscan
// ---------------------------------------------------------------------------
cmd(
  {
    pattern: 'nmap',
    alias: ['netscan', 'hscan'],
    desc: 'Extended port scan (16 common ports, local TCP probes).',
    category: HACK,
    use: '.nmap example.com',
    filename: __filename,
  },
  async (m, args) => {
    const input = firstArg(args)
    if (!input) return m.reply('*Usage:* `.nmap example.com`')
    const host = cleanHost(input)
    try {
      log('.nmap ' + host)
      const results = await scanPorts(host, NMAP_PORTS)
      return m.reply(portReport(host, results, 'Nmap Scan'))
    } catch (e) {
      return m.reply('*Nmap scan failed:* ' + ((e && e.message) || e))
    }
  }
)

// ---------------------------------------------------------------------------
// .malwarecheck / .malware / .viruscheck — urlscan.io public search
// ---------------------------------------------------------------------------
async function urlscanSearch(host) {
  const data = await getJson(
    'https://urlscan.io/api/v1/search/?q=domain:' + encodeURIComponent(host) + '&size=1',
    { timeout: 25000 }
  )
  return (data.results && data.results[0]) || null
}

function urlscanResultLink(x) {
  if (!x) return '—'
  return x.startsWith('http') ? x : 'https://urlscan.io/result/' + x + '/'
}

cmd(
  {
    pattern: 'malwarecheck',
    alias: ['malware', 'viruscheck'],
    desc: 'Check if a domain/URL appears malicious in prior urlscan.io scans (free, no key).',
    category: HACK,
    use: '.malwarecheck https://suspicious-site.com',
    filename: __filename,
  },
  async (m, args) => {
    const input = firstArg(args)
    if (!input) return m.reply('*Usage:* `.malwarecheck https://suspicious-site.com`')
    const host = cleanHost(input)
    try {
      log('.malwarecheck ' + host)
      const hit = await urlscanSearch(host)
      if (!hit) {
        return m.reply('*No prior urlscan.io scans found for ' + host + '*\n' +
          '_For a real-time check: https://www.virustotal.com_')
      }
      const v = (hit.verdicts && hit.verdicts.overall) || {}
      const score = typeof v.score === 'number' ? v.score : 0
      const malicious = v.malicious === true ? '✅ No' : v.malicious === false ? '✅ No' : v.malicious
      const lines = [
        '*Malware Check — ' + host + '*',
        '',
        '• Score: ' + score + '/100',
        '• Malicious: ' + (v.malicious === true ? '⚠️ Yes' : '✅ No'),
        '• Last scanned: ' + ((hit.task && hit.task.time) || '—'),
        '• Result: ' + urlscanResultLink(hit.result),
        '',
        '_For real-time checks: https://www.virustotal.com_',
      ]
      return m.reply(lines.join('\n'))
    } catch (e) {
      log('malwarecheck error:', (e && e.message) || e)
      return m.reply('*Could not reach urlscan.io:* ' + ((e && e.message) || e))
    }
  }
)

// ---------------------------------------------------------------------------
// .urlscan — search always; submit only when URLSCAN_API_KEY is set
// ---------------------------------------------------------------------------
cmd(
  {
    pattern: 'urlscan',
    alias: [],
    desc: 'Search urlscan.io history, or submit a new scan when URLSCAN_API_KEY is set.',
    category: HACK,
    use: '.urlscan https://example.com',
    filename: __filename,
  },
  async (m, args) => {
    const input = firstArg(args)
    if (!input) return m.reply('*Usage:* `.urlscan https://example.com`')
    const host = cleanHost(input)
    const apiKey = process.env.URLSCAN_API_KEY || ''
    try {
      log('.urlscan ' + host)
      if (apiKey) {
        const data = await getJson('https://urlscan.io/api/v1/scan/', {
          timeout: 20000,
          headers: { 'API-Key': apiKey, 'Content-Type': 'application/json' },
          fetch: { method: 'POST', body: JSON.stringify({ url: 'https://' + host, visibility: 'public' }) },
        })
        if (data && data.uuid) {
          return m.reply('*Scan submitted* — https://urlscan.io/result/' + data.uuid + '/')
        }
        return m.reply('*Submission failed:* ' + ((data && data.message) || 'unknown error'))
      }
      const hit = await urlscanSearch(host)
      if (hit) {
        const v = (hit.verdicts && hit.verdicts.overall) || {}
        return m.reply('*URLScan — ' + host + '*\n' +
          '• Score: ' + (typeof v.score === 'number' ? v.score : 0) + '/100\n' +
          '• Malicious: ' + (v.malicious === true ? '⚠️ Yes' : '✅ No') + '\n' +
          '• Result: ' + urlscanResultLink(hit.result))
      }
      return m.reply('*No prior scans found for ' + host + '*\n' +
        'Check previous scans: https://urlscan.io/search/#https%3A%2F%2F' + encodeURIComponent(host) +
        '\n\n_Submission requires a free urlscan.io API key — set URLSCAN_API_KEY in the panel env to enable it._')
    } catch (e) {
      log('urlscan error:', (e && e.message) || e)
      return m.reply('*Could not reach urlscan.io:* ' + ((e && e.message) || e))
    }
  }
)
