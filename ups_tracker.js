#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { Command } = require('commander');
const { chromium, firefox } = require('playwright');


const UPS_BASE = 'https://www.ups.com';
const TRACK_URL = (tracking, locale) =>
  `${UPS_BASE}/track?track=yes&trackNums=${tracking}&loc=${locale}&requester=ST/trackdetails`;

const UPS_PATTERN = /\b(1Z[A-Z0-9]{16})\b/g;

/**
 * Scrape la page UPS avec un vrai navigateur Chromium
 * Intercepte aussi les réponses XHR/fetch pour extraire les numéros depuis le JSON
 */
async function scrapeWithBrowser(trackingNumber, locale, headless, verbose, useFirefox) {
  // Firefox a un fingerprint TLS différent qui passe mieux les WAF comme Akamai
  const browserType = useFirefox ? firefox : chromium;
  const launchArgs = useFirefox
    ? { headless }
    : { headless, args: ['--disable-http2'] };

  if (verbose) console.log(`[d] Navigateur : ${useFirefox ? 'Firefox' : 'Chromium'}`);

  const browser = await browserType.launch(launchArgs);
  const context = await browser.newContext({
    userAgent: useFirefox
      ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
  });

  const collectedJson = [];

  // Intercepter toutes les réponses JSON pour capturer les données de tracking
  context.on('response', async (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    if (
      (url.includes('webapis.ups.com') || url.includes('/track/api/') || url.includes('GetStatus')) &&
      ct.includes('json')
    ) {
      try {
        const body = await response.text();
        if (verbose) console.log(`[d] XHR capturé : ${url.slice(0, 100)}`);
        collectedJson.push(body);
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  const url = TRACK_URL(trackingNumber, locale);

  if (verbose) console.log(`[d] Navigation vers : ${url}`);
  console.log('[*] Chargement de la page UPS...');

  // Naviguer d'abord sur la homepage pour établir une session naturelle
  try {
    await page.goto(UPS_BASE, { waitUntil: 'commit', timeout: 30000 });
    await page.waitForTimeout(1500);
    if (verbose) console.log('[d] Page d\'accueil chargée');
  } catch (_) {
    if (verbose) console.log('[d] Homepage inaccessible, tentative directe...');
  }

  await page.goto(url, { waitUntil: 'commit', timeout: 60000 });

  // Attendre que la page charge les données de tracking
  try {
    await page.waitForSelector(
      '[class*="tracking"], [class*="shipment"], [data-testid*="track"], text=1Z',
      { timeout: 20000 }
    );
    if (verbose) console.log('[d] Sélecteur de tracking détecté');
  } catch (_) {
    if (verbose) console.log('[d] Sélecteur non trouvé, attente supplémentaire...');
    await page.waitForTimeout(5000);
  }

  // Chercher et cliquer sur le lien "X of N Piece Shipment" pour les envois multi-colis
  const multiPkgSelectors = [
    '#stApp_additionalPackages',           // ID exact du lien "1 of 16 Piece Shipment"
    'a[id*="additionalPackages"]',
    'a:has-text("Piece Shipment")',
    'a:has-text("of") >> text=/Piece Shipment/',
  ];

  let clickedMulti = false;
  for (const sel of multiPkgSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        if (verbose) console.log(`[d] Lien multi-colis trouvé : ${sel}`);
        // Forcer le click via JS pour bypasser les checks d'actionabilité
        await page.evaluate((element) => element.click(), el);
        // Attendre que les nouvelles données chargent
        await page.waitForTimeout(6000);
        clickedMulti = true;
        break;
      }
    } catch (err) {
      if (verbose) console.log(`[d] Erreur click sur ${sel} : ${err.message.slice(0, 80)}`);
    }
  }

  if (!clickedMulti && verbose) {
    console.log('[d] Lien multi-colis non trouvé (envoi à 1 colis ou sélecteur obsolète)');
  }

  // Parcourir toutes les pages de pagination pour les envois multi-colis.
  // L'UI Angular d'UPS utilise le bouton #stApp_pagination_nextBtn (5 colis/page,
  // via GetAdditionalPackages startingTrackIndex). On clique "Next" jusqu'à ce
  // qu'il soit désactivé, en attendant le XHR de chaque page.
  if (clickedMulti) {
    for (let pageNum = 1; pageNum <= 50; pageNum++) {
      try {
        const nextBtn = await page.$('#stApp_pagination_nextBtn, button.ups-pagination-btn_next, button[aria-label="next" i]');
        if (!nextBtn) {
          if (verbose) console.log(`[d] Pagination : pas de bouton Next (page ${pageNum})`);
          break;
        }
        const disabled = await nextBtn.evaluate((el) =>
          el.disabled || el.getAttribute('aria-disabled') === 'true' ||
          /disabled/.test(el.className) || el.offsetParent === null
        );
        if (disabled) {
          if (verbose) console.log(`[d] Pagination : dernière page atteinte (page ${pageNum})`);
          break;
        }
        if (verbose) console.log(`[d] Pagination : clic Next -> page ${pageNum + 1}`);
        // On attend le XHR de la page suivante déclenché par le clic.
        const waitXhr = page.waitForResponse(
          (r) => /GetAdditionalPackages/i.test(r.url()) && r.status() < 400,
          { timeout: 12000 }
        ).catch(() => null);
        await page.evaluate((el) => el.click(), nextBtn);
        await waitXhr;
        await page.waitForTimeout(1500);
      } catch (_) {
        break;
      }
    }
  }

  // Récupérer tout le contenu HTML rendu
  const htmlContent = await page.content();

  // Extraire aussi depuis les XHR interceptés
  const allContent = [htmlContent, ...collectedJson].join('\n');

  // Dump HTML pour debug si verbose
  if (verbose) {
    const debugHtml = 'debug_page.html';
    fs.writeFileSync(debugHtml, htmlContent, 'utf8');
    console.log(`[d] HTML rendu sauvegardé dans : ${debugHtml}`);
  }

  await browser.close();
  return { content: allContent, rawJson: collectedJson };
}

/**
 * Extraire les packages (numéro + statut) depuis les réponses JSON de l'API UPS.
 * Retourne [{ trackingNumber, status }], dédupliqué.
 */
function extractPackagesFromJson(rawJson) {
  const seen = new Set();
  const packages = [];

  for (const raw of rawJson) {
    let j;
    try { j = JSON.parse(raw); } catch (_) { continue; }

    // GetStatus → trackDetails[].{ trackingNumber, packageStatus }
    if (Array.isArray(j.trackDetails)) {
      for (const d of j.trackDetails) {
        if (d.trackingNumber && !seen.has(d.trackingNumber)) {
          seen.add(d.trackingNumber);
          packages.push({ trackingNumber: d.trackingNumber, status: d.packageStatus || '' });
        }
      }
    }

    // GetAdditionalPackages → trackDetail.additionalPackages[].{ trackingNumber, packageStatus }
    if (j.trackDetail && Array.isArray(j.trackDetail.additionalPackages)) {
      for (const p of j.trackDetail.additionalPackages) {
        if (p.trackingNumber && !seen.has(p.trackingNumber)) {
          seen.add(p.trackingNumber);
          packages.push({ trackingNumber: p.trackingNumber, status: p.packageStatus || '' });
        }
      }
    }
  }

  return packages;
}

/**
 * Fallback regex si le JSON n'a pas suffi.
 */
function extractTrackingNumbersFallback(content) {
  const matches = content.match(UPS_PATTERN) || [];
  return [...new Set(matches)].map((n) => ({ trackingNumber: n, status: '' }));
}

/**
 * Sauvegarde dans un fichier texte avec statuts.
 */
function saveToFile(packages, trackingNumber, outputPath) {
  const timestamp = new Date().toISOString();
  const maxLen = Math.max(...packages.map((p) => p.trackingNumber.length));
  const lines = [
    `# UPS Tracking Results`,
    `# Base tracking : ${trackingNumber}`,
    `# Generated    : ${timestamp}`,
    `# Total        : ${packages.length} colis`,
    '',
    ...packages.map((p) => `${p.trackingNumber.padEnd(maxLen)}  ${p.status}`),
    '',
  ];
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
}

/**
 * Point d'entrée CLI
 */
async function main() {
  const program = new Command();

  program
    .name('ups-tracker')
    .description("Scrape tous les numéros de suivi UPS d'un envoi multi-colis")
    .argument('[tracking]', 'Numéro de suivi UPS')
    .option('-t, --tracking <number>', 'Numéro de suivi UPS (forme longue)')
    .option('-o, --output <file>', 'Output file path', 'tracking_results.txt')
    .option('-l, --locale <locale>', 'UPS locale', 'en_US')
    .option('-f, --format <fmt>', 'Output format: text or json', 'text')
    .option('--show-browser', 'Show browser window (disables headless)')
    .option('--chromium', 'Use Chromium instead of Firefox')
    .option('-v, --verbose', 'Verbose debug output')
    .parse(process.argv);

  const opts = program.opts();
  const trackingNumber = program.args[0] || opts.tracking;

  if (!trackingNumber) {
    console.error('[!] Erreur : fournir un numéro de suivi UPS.');
    console.error('    Exemple : node ups_tracker.js 1ZB57B606834792857');
    process.exit(1);
  }

  if (!/^1Z[A-Z0-9]{16}$/.test(trackingNumber.toUpperCase())) {
    console.warn(
      `[~] Avertissement : "${trackingNumber}" ne ressemble pas à un numéro UPS standard (1Z + 16 chars).`
    );
  }

  const tracking = trackingNumber.toUpperCase();
  const headless = !opts.showBrowser;
  const useFirefox = !opts.chromium; // Firefox par défaut (meilleur contre Akamai WAF)

  console.log(`[*] Numéro de suivi : ${tracking}`);
  console.log(`[*] Locale          : ${opts.locale}`);
  console.log(`[*] Mode            : ${headless ? 'headless' : 'navigateur visible'} | ${useFirefox ? 'Firefox' : 'Chromium'}`);

  let packages = [];

  try {
    const { content, rawJson } = await scrapeWithBrowser(tracking, opts.locale, headless, opts.verbose, useFirefox);

    if (opts.verbose) {
      console.log(`[d] Taille contenu récupéré : ${content.length} chars`);
      if (rawJson.length > 0) {
        const debugFile = `debug_api_${tracking}.json`;
        fs.writeFileSync(debugFile, rawJson.join('\n---\n'), 'utf8');
        console.log(`[d] JSON brut API sauvegardé dans : ${debugFile}`);
      }
    }

    // Extraire depuis le JSON de l'API (avec statuts)
    packages = extractPackagesFromJson(rawJson);

    // Fallback regex si le JSON n'a rien donné
    if (packages.length === 0) {
      if (opts.verbose) console.log('[d] Fallback regex (JSON insuffisant)');
      packages = extractTrackingNumbersFallback(content);
    }
  } catch (err) {
    console.error('[!] Erreur lors du scraping :', err.message);
    if (opts.verbose) console.error(err.stack);
    process.exit(1);
  }

  if (packages.length === 0) {
    console.log('\n[!] No tracking numbers found.');
    console.log('    Try --show-browser to watch the browser navigate.');
    console.log('    Or --verbose for detailed debug output.');
    process.exit(1);
  }

  // JSON format
  if (opts.format === 'json') {
    const out = JSON.stringify(packages, null, 2);
    process.stdout.write(out + '\n');
    if (opts.output !== 'tracking_results.txt') {
      fs.writeFileSync(opts.output, out, 'utf8');
      console.error(`[+] JSON saved to: ${opts.output}`);
    }
    return;
  }

  // Text format — affichage console
  const maxLen = Math.max(...packages.map((p) => p.trackingNumber.length));
  console.log(`\n[+] ${packages.length} package(s) found:\n`);
  packages.forEach((p, i) => {
    const num = String(i + 1).padStart(3, ' ');
    const tn = p.trackingNumber.padEnd(maxLen);
    const status = p.status ? `  →  ${p.status}` : '';
    console.log(`  ${num}. ${tn}${status}`);
  });

  // Sauvegarde fichier
  saveToFile(packages, tracking, opts.output);
  console.log(`\n[+] Results saved to: ${opts.output}`);
}

main().catch((err) => {
  console.error('[!] Erreur fatale :', err.message);
  process.exit(1);
});
