'use strict';

// Apify actor : un numéro de suivi UPS maître -> tous les colis de l'envoi.
// Firefox headless (meilleur contre le WAF Akamai d'UPS) + proxy résidentiel Apify
// (les IP datacenter sont bloquées). Attente robuste du rendu + retry jusqu'à N colis.

const { Actor } = require('apify');
const { firefox } = require('playwright');

const UPS_BASE = 'https://www.ups.com';
const TRACK_URL = (tracking, locale) =>
  `${UPS_BASE}/track?track=yes&trackNums=${tracking}&loc=${locale}&requester=ST/trackdetails`;
const UPS_PATTERN = /\b(1Z[A-Z0-9]{16})\b/g;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseProxyUrl(u) {
  if (!u) return undefined;
  try {
    const m = new URL(u);
    return {
      server: `${m.protocol}//${m.host}`,
      username: decodeURIComponent(m.username || ''),
      password: decodeURIComponent(m.password || ''),
    };
  } catch (_) { return undefined; }
}

function extractPackagesFromJson(rawJson) {
  const seen = new Set();
  const packages = [];
  for (const raw of rawJson) {
    let j;
    try { j = JSON.parse(raw); } catch (_) { continue; }
    if (Array.isArray(j.trackDetails)) {
      for (const d of j.trackDetails) {
        if (d.trackingNumber && /^1Z[A-Z0-9]{16}$/i.test(d.trackingNumber) && !seen.has(d.trackingNumber)) {
          seen.add(d.trackingNumber);
          packages.push({ trackingNumber: d.trackingNumber.toUpperCase(), status: d.packageStatus || '' });
        }
      }
    }
    if (j.trackDetail && Array.isArray(j.trackDetail.additionalPackages)) {
      for (const p of j.trackDetail.additionalPackages) {
        if (p.trackingNumber && /^1Z[A-Z0-9]{16}$/i.test(p.trackingNumber) && !seen.has(p.trackingNumber)) {
          seen.add(p.trackingNumber);
          packages.push({ trackingNumber: p.trackingNumber.toUpperCase(), status: p.packageStatus || '' });
        }
      }
    }
  }
  return packages;
}

function extractFallback(text) {
  const matches = (text.match(UPS_PATTERN) || []).map((n) => n.toUpperCase());
  return [...new Set(matches)].map((n) => ({ trackingNumber: n, status: '' }));
}

// Une passe de scrape. Retourne { collectedJson, html, bodyText, expectedCount, blocked, title }.
async function scrapeOnce(browser, trackingNumber, locale, attempt, proxy) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    proxy, // proxy par contexte (rotation IP par tentative). Firefox : exige aussi un proxy au launch.
  });

  const collectedJson = [];
  let xhrCount = 0;
  context.on('response', async (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    if (/webapis\.ups|GetStatus|GetAdditionalPackages|track\/api/i.test(url)) {
      try { collectedJson.push(await response.text()); xhrCount++; } catch (_) {}
    }
  });

  const page = await context.newPage();
  const url = TRACK_URL(trackingNumber, locale);

  try {
    await page.goto(UPS_BASE, { waitUntil: 'commit', timeout: 30000 });
    await page.waitForTimeout(1200);
  } catch (_) {}

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Attendre que le DOM affiche RÉELLEMENT un n° de suivi (le panneau Angular a rendu).
  // Bien plus fiable qu'attendre un XHR (Akamai renvoie du JSON parasite).
  let rendered = false;
  try {
    await page.waitForFunction(
      () => /1Z[A-Z0-9]{16}/.test(document.body ? document.body.innerText : ''),
      null,
      { timeout: 25000 } // IP soft-blockée = on abandonne vite pour tourner d'IP
    );
    rendered = true;
  } catch (_) {}
  await page.waitForTimeout(1200);

  let title = '';
  try { title = await page.title(); } catch (_) {}
  let bodyText = '';
  try { bodyText = await page.evaluate(() => (document.body ? document.body.innerText : '')); } catch (_) {}
  const blocked = /access denied|request unsuccessful|reference #\d|unusual traffic|are you a human|captcha/i.test(
    title + ' ' + bodyText.slice(0, 500)
  );

  // Nombre attendu de colis : "X of N Piece Shipment".
  let expectedCount = 0;
  const nMatch = bodyText.match(/of\s+(\d+)\s+Piece Shipment/i);
  if (nMatch) expectedCount = parseInt(nMatch[1], 10) || 0;

  // Lien multi-colis : attendre qu'il rende, puis cliquer.
  let linkEl = null;
  try {
    linkEl = await page.waitForSelector('#stApp_additionalPackages, a[id*="additionalPackages"]', { timeout: 8000 });
  } catch (_) {}
  if (!linkEl) {
    for (const sel of ['a:has-text("Piece Shipment")', 'a:has-text("of") >> text=/Piece Shipment/']) {
      try { linkEl = await page.$(sel); if (linkEl) break; } catch (_) {}
    }
  }
  let clickedMulti = false;
  if (linkEl) {
    try {
      await page.evaluate((el) => el.click(), linkEl);
      await page.waitForTimeout(5000);
      clickedMulti = true;
    } catch (_) {}
  }

  // Pagination (5 colis/page via GetAdditionalPackages).
  if (clickedMulti) {
    for (let pageNum = 1; pageNum <= 60; pageNum++) {
      try {
        const nextBtn = await page.$('#stApp_pagination_nextBtn, button.ups-pagination-btn_next, button[aria-label="next" i]');
        if (!nextBtn) break;
        const disabled = await nextBtn.evaluate((el) =>
          el.disabled || el.getAttribute('aria-disabled') === 'true' ||
          /disabled/.test(el.className) || el.offsetParent === null
        );
        if (disabled) break;
        const waitXhr = page.waitForResponse(
          (r) => /GetAdditionalPackages/i.test(r.url()) && r.status() < 400,
          { timeout: 12000 }
        ).catch(() => null);
        await page.evaluate((el) => el.click(), nextBtn);
        await waitXhr;
        await page.waitForTimeout(1500);
      } catch (_) { break; }
    }
  }

  const html = await page.content();
  const finalBody = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => bodyText);

  console.log(`[d] tentative ${attempt}: rendu=${rendered} blocké=${blocked} XHR=${xhrCount} attendu(N)=${expectedCount || '?'} lien=${clickedMulti} titre="${title.slice(0, 40)}"`);

  // Debug (dernière tentative).
  try {
    const shot = await page.screenshot({ fullPage: false });
    await Actor.setValue('DEBUG_SCREENSHOT', shot, { contentType: 'image/png' });
    await Actor.setValue('DEBUG_HTML', html, { contentType: 'text/html' });
    await Actor.setValue('DEBUG_JSON', collectedJson.join('\n---\n'), { contentType: 'text/plain' });
  } catch (_) {}

  await context.close();
  return { collectedJson, html, bodyText: finalBody, expectedCount, blocked, title };
}

Actor.main(async () => {
  const input = (await Actor.getInput()) || {};
  const trackingNumber = String(input.trackingNumber || input.tracking || '').toUpperCase().trim();
  const locale = input.locale || 'en_US';
  const proxyUrl = input.proxyUrl || process.env.UPS_PROXY_URL || ''; // ProxyBaron via secret Apify (env), override possible par input
  const proxyType = input.proxyType || 'RESIDENTIAL'; // fallback Apify si pas de proxyUrl
  const countryCode = input.countryCode || undefined;
  const maxAttempts = Number(input.maxAttempts || 4);

  if (!/^1Z[A-Z0-9]{16}$/.test(trackingNumber)) {
    throw new Error(`Numéro UPS invalide : "${trackingNumber}" (attendu 1Z + 16 caractères).`);
  }

  // Résout le proxy pour une tentative. ProxyBaron prioritaire : on fait tourner le
  // token de session sticky à chaque tentative -> IP FR résidentielle fraîche par essai.
  let apifyProxy;
  async function proxyForAttempt(attempt) {
    if (proxyUrl) {
      const p = parseProxyUrl(proxyUrl);
      if (p && /session-[^_]+/.test(p.password)) {
        p.password = p.password.replace(/session-[^_]+/, `session-ups${attempt}${Math.floor(Math.random() * 100000)}`);
      }
      return p;
    }
    if (proxyType === 'NONE') return undefined;
    if (!apifyProxy) {
      try {
        const groups = proxyType === 'DATACENTER' ? undefined : ['RESIDENTIAL'];
        const pc = await Actor.createProxyConfiguration({ groups, countryCode });
        apifyProxy = parseProxyUrl(pc ? await pc.newUrl() : null);
      } catch (e) { console.log(`[!] Proxy Apify indisponible: ${String(e).slice(0, 80)}`); }
    }
    return apifyProxy;
  }

  const parallel = Number(input.parallel || 3); // IP tentées en parallèle par vague
  const maxWaves = Number(input.maxWaves || Math.max(1, Math.ceil(maxAttempts / parallel)));
  const firstProxy = await proxyForAttempt(1);
  console.log(`[*] Proxy: ${proxyUrl ? 'ProxyBaron (rotation session/essai)' : proxyType} -> ${firstProxy ? firstProxy.server : 'aucun'}`);
  console.log(`[*] Scrape UPS ${trackingNumber} (locale ${locale}, ${parallel} en //, max ${maxWaves} vagues)`);
  // Firefox exige un proxy au launch pour autoriser l'override par contexte.
  const browser = await firefox.launch({ headless: true, proxy: firstProxy });

  let best = [];
  let bestExpected = 0;
  let lastBlocked = false;
  let lastTitle = '';
  try {
    for (let wave = 1; wave <= maxWaves; wave++) {
      // Une vague = N sessions ProxyBaron (IP distinctes) en parallèle ; la 1re qui
      // rend gagne. Neutralise la flakiness des IP soft-blockées (P(toutes KO)=faible).
      const proxies = [];
      for (let k = 0; k < parallel; k++) proxies.push(await proxyForAttempt(wave * 10 + k));
      const results = await Promise.allSettled(
        proxies.map((px, k) => scrapeOnce(browser, trackingNumber, locale, `${wave}.${k + 1}`, px))
      );
      for (const rs of results) {
        if (rs.status !== 'fulfilled') { console.log(`[!] vague ${wave}: ${String(rs.reason).slice(0, 80)}`); continue; }
        const r = rs.value;
        lastBlocked = r.blocked; lastTitle = r.title;
        let pk = extractPackagesFromJson(r.collectedJson);
        if (pk.length < (r.expectedCount || 1)) {
          const fb = extractFallback(r.html + '\n' + r.bodyText);
          if (fb.length > pk.length) pk = fb;
        }
        if (pk.length > best.length) best = pk;
        bestExpected = Math.max(bestExpected, r.expectedCount || 0);
      }
      const target = Math.max(1, bestExpected);
      console.log(`[*] vague ${wave}: ${best.length}/${target} colis`);
      // Succès : >1 colis = multi-colis résolu (fini) ; sinon mono-colis confirmé (≥2 vagues).
      if (best.length >= target && (best.length > 1 || wave >= 2)) break;
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Maître en tête.
  best.sort((a, b) =>
    a.trackingNumber === trackingNumber ? -1 : b.trackingNumber === trackingNumber ? 1 : 0
  );

  console.log(`[+] ${best.length} colis trouvé(s) (attendu ${bestExpected || '?'}).`);

  await Actor.pushData(best.map((p) => ({ ...p, master: trackingNumber })));
  await Actor.setValue('OUTPUT', {
    trackingNumber,
    count: best.length,
    expectedCount: bestExpected,
    blocked: lastBlocked,
    title: lastTitle,
    packages: best,
  });
});
