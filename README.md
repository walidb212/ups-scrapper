# 📦 UPS Multi-Package Scraper

> **One tracking number → every package number in the shipment, automatically.**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-Firefox-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/topics/ups)

UPS groups dozens of packages under a single master tracking number — but gives you **no easy way to get them all at once**. This CLI solves that: hand it one tracking number, get every package number + status back in seconds.

---

## ✨ Demo

```
$ node ups_tracker.js 1ZB57B606834792857

[*] Tracking number : 1ZB57B606834792857
[*] Locale          : en_US
[*] Mode            : headless | Firefox
[*] Loading UPS page...

[+] 16 package(s) found:

    1. 1ZB57B606834792857  →  Shipment Ready for UPS
    2. 1ZB57B606820588005  →  Shipment Ready for UPS
    3. 1ZB57B606822940067  →  Shipment Ready for UPS
    4. 1ZB57B606823387959  →  Shipment Ready for UPS
    5. 1ZB57B606824150685  →  Shipment Ready for UPS
    6. 1ZB57B606824444724  →  Shipment Ready for UPS
    7. 1ZB57B606824601732  →  Shipment Ready for UPS
    8. 1ZB57B606825526090  →  Shipment Ready for UPS
    9. 1ZB57B606825997117  →  Shipment Ready for UPS
   10. 1ZB57B606828097192  →  Shipment Ready for UPS
   11. 1ZB57B606829544143  →  Shipment Ready for UPS
   12. 1ZB57B606829622906  →  Shipment Ready for UPS
   13. 1ZB57B606830580673  →  Shipment Ready for UPS
   14. 1ZB57B606832889168  →  Shipment Ready for UPS
   15. 1ZB57B606833043775  →  Shipment Ready for UPS
   16. 1ZB57B606836687780  →  Shipment Ready for UPS

[+] Results saved to: tracking_results.txt
```

---

## 🚀 Quick Start

```bash
# 1. Clone & install
git clone https://github.com/walidwalid/ups-scrapper.git
cd ups-scrapper
npm install

# 2. Install Firefox browser (one-time)
npx playwright install firefox

# 3. Run
node ups_tracker.js YOUR_TRACKING_NUMBER
```

---

## 📋 Features

- ✅ **Bulk extraction** — one master tracking number → all individual package numbers
- ✅ **Package status** — shows real-time status for each package (e.g. *In Transit*, *Out for Delivery*)
- ✅ **Bypasses Akamai WAF** — uses Firefox's unique TLS fingerprint to avoid bot detection
- ✅ **Auto-pagination** — handles shipments split across multiple pages
- ✅ **3-layer fallback** — JSON API interception → rendered HTML → regex
- ✅ **Export to file** — saves a clean `.txt` report
- ✅ **JSON output** — pipe-friendly `--format json` flag
- ✅ **Zero config** — works out of the box, no API keys required

---

## ⚙️ CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `[tracking]` | — | UPS tracking number (positional) |
| `-t, --tracking <n>` | — | UPS tracking number (named flag) |
| `-o, --output <file>` | `tracking_results.txt` | Output file path |
| `-l, --locale <locale>` | `en_US` | UPS locale |
| `--format <fmt>` | `text` | Output format: `text` or `json` |
| `--show-browser` | off | Show the browser window (useful for debugging) |
| `--chromium` | off | Use Chromium instead of Firefox |
| `-v, --verbose` | off | Verbose debug output |

**Examples:**

```bash
# Basic usage
node ups_tracker.js 1ZB57B606834792857

# Save to a custom file
node ups_tracker.js 1ZB57B606834792857 --output shipment_42.txt

# Get JSON output (great for scripting)
node ups_tracker.js 1ZB57B606834792857 --format json

# Debug: watch the browser navigate live
node ups_tracker.js 1ZB57B606834792857 --show-browser --verbose
```

---

## 📁 Output File

```
# UPS Tracking Results
# Base tracking : 1ZB57B606834792857
# Generated    : 2026-03-17T16:30:00.000Z
# Total        : 16 packages

1ZB57B606834792857  Shipment Ready for UPS
1ZB57B606820588005  Shipment Ready for UPS
1ZB57B606822940067  Shipment Ready for UPS
...
```

---

## 🔍 How It Works

UPS's tracking site is a JavaScript-rendered Angular app protected by **Akamai Bot Manager**. Simple HTTP clients (curl, axios, Python requests) get silently blocked via TLS fingerprint inspection.

This tool works around it in 3 steps:

```
1. Firefox headless  ──►  Passes Akamai TLS check (real browser fingerprint)
         │
         ▼
2. XHR interception  ──►  Captures internal API calls:
                           • /track/api/Track/GetStatus
                           • /track/api/Track/GetAdditionalPackages
         │
         ▼
3. Pagination loop   ──►  Clicks through all pages of the package list
                           to collect every tracking number
```

**Why Firefox and not Chromium?**
Akamai Bot Manager inspects the TLS ClientHello fingerprint ([JA3 hash](https://engineering.salesforce.com/tls-fingerprinting-with-ja3-and-ja3s-247362855967/)). Headless Chromium has a well-known JA3 signature that Akamai blocks. Firefox's fingerprint passes through.

---

## 🛠 Requirements

- **Node.js** 18+
- **npm** 8+
- Internet access to `www.ups.com` and `webapis.ups.com`

---

## 🤝 Contributing

Pull requests welcome! Ideas for improvement:

- [ ] Support for FedEx / DHL multi-package shipments
- [ ] CSV export with full shipment metadata
- [ ] Watch mode (`--watch`) that polls for status changes
- [ ] Webhook notifications when a package is delivered

---

## ⚠️ Disclaimer

This tool is for personal use only. It scrapes the public UPS tracking page in the same way a browser would. Use responsibly and respect UPS's Terms of Service.

---

## 📄 License

[MIT](LICENSE) © 2026
