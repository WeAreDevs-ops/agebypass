// birthdate-server-railway.js - Fully UI-driven, simulates real user interaction

const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

function log(msg, logs = null) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    if (logs) logs.push(line);
}

async function findChrome() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
    const fs = require('fs');
    const { execSync } = require('child_process');
    const paths = [
        '/app/.cache/puppeteer/chrome/linux-*/chrome-linux/chrome',
        '/root/.cache/puppeteer/chrome/linux-*/chrome-linux/chrome',
        '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
    ];
    for (const p of paths) {
        try {
            if (p.includes('*')) {
                const dir = p.split('*')[0];
                if (fs.existsSync(dir)) {
                    for (const f of fs.readdirSync(dir)) {
                        const full = p.replace('*', f);
                        if (fs.existsSync(full)) return full;
                    }
                }
            } else {
                try { const r = execSync(`which ${p}`, { encoding: 'utf8' }).trim(); if (r) return r; } catch (e) {}
                if (fs.existsSync(p)) return p;
            }
        } catch (e) {}
    }
    return null;
}

let browser = null;
async function initBrowser() {
    if (browser) return browser;
    const chromePath = await findChrome();
    log(`Chrome path: ${chromePath || 'not found, using bundled'}`);
    const opts = {
        headless: "new",
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-gpu', '--disable-software-rasterizer', '--disable-extensions',
            '--single-process', '--no-zygote', '--window-size=1280,720',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
        ],
        defaultViewport: { width: 1280, height: 720 }
    };
    if (chromePath) opts.executablePath = chromePath;
    log('Launching browser...');
    browser = await puppeteer.launch(opts);
    log('Browser launched successfully');
    browser.on('disconnected', () => { log('Browser disconnected'); browser = null; });
    return browser;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(min, max) { return delay(Math.floor(Math.random() * (max - min + 1)) + min); }

// API subdomains fulfilled via Node.js (Railway Chromium sandbox can't reach these)
// Proxy ALL roblox API subdomains through Node.js - Railway's Chromium sandbox
// can't reach any *.roblox.com subdomain except www.roblox.com directly
const PASSTHROUGH_URLS = [
    'rbxcdn.com',              // static CDN assets - always passthrough
    'rbx.com',                 // short domain
    'robloxlabs.com',          // labs
    // www.roblox.com pages that are navigation/static (NOT API endpoints)
    'www.roblox.com/js/',
    'www.roblox.com/css/',
    'www.roblox.com/worker-resources/',
    'www.roblox.com/favicon',
];

function isApiCall(url) {
    if (!url.includes('roblox.com')) return false;
    // Let static/CDN pass through
    if (PASSTHROUGH_URLS.some(d => url.includes(d))) return false;
    // www.roblox.com page navigations pass through (HTML pages, not JSON APIs)
    if (url.includes('www.roblox.com/') && !url.includes('.json') && 
        !url.includes('/v1/') && !url.includes('/v2/') && !url.includes('/v3/') &&
        !url.match(/\.roblox\.com\/[a-z-]+\/[a-z]/)) {
        const path = url.split('www.roblox.com')[1] || '';
        // Only pass through actual page navigations
        if (path === '/' || path.startsWith('/my/account') || path.startsWith('/NewLogin') || 
            path.startsWith('/home') || path.startsWith('/worker-')) {
            return false;
        }
    }
    // Everything else (all API subdomains + JSON endpoints) goes through Node.js
    return true;
}

// CDP intercept: all API calls go through Node.js fetch, not Chromium's sandboxed network
async function setupCDP(page, cookieHeader, logs) {
    const cdp = await page.target().createCDPSession();
    await cdp.send('Fetch.enable', {
        patterns: [{ urlPattern: '*roblox.com*', requestStage: 'Request' }]
    });

    const tokens = { csrf: null, boundAuth: null, machineId: null };

    cdp.on('Fetch.requestPaused', async (params) => {
        const { requestId, request } = params;
        const url = request.url;

        // Non-API requests pass through - but log unexpected roblox subdomains
        if (!isApiCall(url)) {
            const skip = url.includes('rbxcdn.com') || url.includes('ecsv2.roblox.com') || url.includes('rbx.com') || !url.includes('roblox.com');
            if (!skip) log(`⚠ PASSTHROUGH: ${request.method} ${url.replace('https://', '').substring(0, 80)}`, logs);
            await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
            return;
        }

        // OPTIONS preflight — fake CORS success so browser sends the real request
        if (request.method === 'OPTIONS') {
            await cdp.send('Fetch.fulfillRequest', {
                requestId,
                responseCode: 204,
                responseHeaders: [
                    { name: 'Access-Control-Allow-Origin', value: 'https://www.roblox.com' },
                    { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,DELETE,PATCH,OPTIONS' },
                    { name: 'Access-Control-Allow-Headers', value: 'Content-Type,x-csrf-token,x-bound-auth-token,roblox-machine-id,X-Requested-With,Accept' },
                    { name: 'Access-Control-Allow-Credentials', value: 'true' },
                    { name: 'Access-Control-Max-Age', value: '86400' }
                ],
                body: ''
            }).catch(() => {});
            return;
        }

        // Capture tokens Roblox's own JS attached to this request
        const reqHeaders = request.headers || {};
        if (reqHeaders['x-bound-auth-token']) tokens.boundAuth = reqHeaders['x-bound-auth-token'];
        if (reqHeaders['x-csrf-token']) tokens.csrf = reqHeaders['x-csrf-token'];
        if (reqHeaders['roblox-machine-id']) tokens.machineId = reqHeaders['roblox-machine-id'];

        log(`→ ${request.method} ${url.replace('https://', '')} [bound=${!!tokens.boundAuth}]`, logs);

        // Fulfill via Node.js
        try {
            const nodeHeaders = { ...reqHeaders, 'Cookie': cookieHeader };
            // Strip HTTP/2 pseudo-headers
            delete nodeHeaders[':method'];
            delete nodeHeaders[':path'];
            delete nodeHeaders[':authority'];
            delete nodeHeaders[':scheme'];

            const resp = await fetch(url, {
                method: request.method,
                headers: nodeHeaders,
                body: request.postData || undefined
            });

            const bodyBuf = await resp.arrayBuffer();
            const respHeaders = {};
            resp.headers.forEach((v, k) => { respHeaders[k] = v; });

            if (respHeaders['x-csrf-token']) tokens.csrf = respHeaders['x-csrf-token'];
            if (respHeaders['roblox-machine-id']) tokens.machineId = respHeaders['roblox-machine-id'];

            log(`← ${resp.status} ${url.replace('https://', '')}`, logs);
            // Log key response bodies for debugging
            if (url.includes('/my/settings/json')) {
                try { log(`SETTINGS_JSON: ${Buffer.from(body,'base64').toString('utf8').substring(0,600)}`, logs); } catch(e) {}
            }

            await cdp.send('Fetch.fulfillRequest', {
                requestId,
                responseCode: resp.status,
                responseHeaders: Object.entries(respHeaders).map(([name, value]) => ({ name, value: String(value) })),
                body: Buffer.from(bodyBuf).toString('base64')
            }).catch(() => {});
        } catch (err) {
            log(`✗ ${url}: ${err.message}`, logs);
            await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
        }
    });

    return { cdp, tokens };
}

// Main: fully UI-driven birthdate change
async function changeBirthdateViaUI(cookie, password, birthMonth, birthDay, birthYear, logs) {
    const cookieValue = cookie.startsWith('.ROBLOSECURITY=') ? cookie.substring(15) : cookie;
    const cookieHeader = `.ROBLOSECURITY=${cookieValue}`;

    const b = await initBrowser();
    const page = await b.newPage();

    try {
        // Set up CDP before any navigation
        const { tokens } = await setupCDP(page, cookieHeader, logs);

        // Bootstrap CSRF via Node.js (safe, no side effects)
        log('Bootstrapping CSRF...', logs);
        try {
            const csrfRes = await fetch('https://auth.roblox.com/v1/authentication-ticket', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://www.roblox.com',
                    'Referer': 'https://www.roblox.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
                    'Cookie': cookieHeader
                }
            });
            const csrf = csrfRes.headers.get('x-csrf-token');
            const machineId = csrfRes.headers.get('roblox-machine-id');
            if (csrf) { tokens.csrf = csrf; log('CSRF ready', logs); }
            if (machineId) { tokens.machineId = machineId; }
        } catch (e) {
            log(`CSRF bootstrap error: ${e.message}`, logs);
        }

        // 1. Navigate to roblox.com first (unauthenticated) to establish the domain context
        log('Loading Roblox domain...', logs);
        await page.goto('https://www.roblox.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });

        // 2. Inject cookie via both setCookie API and document.cookie (belt + suspenders)
        log('Injecting cookie...', logs);
        await page.setCookie({
            name: '.ROBLOSECURITY', value: cookieValue, domain: '.roblox.com',
            path: '/', httpOnly: false, secure: true, sameSite: 'None'
        });
        // Verify cookie was set
        const cookies = await page.cookies('https://www.roblox.com/');
        const robloxCookie = cookies.find(c => c.name === '.ROBLOSECURITY');
        log(`Cookie set: ${robloxCookie ? 'YES (len=' + robloxCookie.value.length + ')' : 'NO - COOKIE MISSING'}`, logs);

        // 3. Now navigate to account settings with cookie in jar
        log('Going to account settings...', logs);
        await page.goto('https://www.roblox.com/my/account#!/info', {
            waitUntil: 'load', timeout: 30000
        });
        // Wait for Angular to bootstrap ng-view content
        log('Waiting for Angular to render settings...', logs);
        await page.waitForFunction(() => {
            const ngView = document.querySelector('[ng-view], .ng-scope');
            return ngView && ngView.innerHTML && ngView.innerHTML.length > 100;
        }, { timeout: 15000 }).catch(() => {});
        await randomDelay(4000, 5000);

        if (page.url().includes('/login')) throw new Error('Cookie invalid');
        log('On account page ✓', logs);

        // Scroll to birthday section
        await page.evaluate(() => window.scrollBy(0, 500));
        await randomDelay(600, 900);

        // 3. Wait for AngularJS to render the birthday button then click it
        // Dump actual page HTML to verify birthday section is present
        const pageHTML = await page.content();
        const hasBirthdayBtn = pageHTML.includes('Change Birthday');
        const hasBirthdayText = pageHTML.includes('Birthday');
        const pageUrl = page.url();
        log(`Page URL: ${pageUrl}`, logs);
        log(`HTML has 'Change Birthday' button: ${hasBirthdayBtn}`, logs);
        log(`HTML has 'Birthday' text: ${hasBirthdayText}`, logs);
        if (!hasBirthdayBtn) {
            // Show snippet of HTML around any birthday reference, or start of body
            const idx = pageHTML.toLowerCase().indexOf('birthday');
            const snippet = idx >= 0 
                ? pageHTML.substring(Math.max(0, idx-100), idx+300)
                : pageHTML.substring(0, 500);
            log(`Page HTML snippet: ${snippet.replace(/\s+/g, ' ')}`, logs);
        }

        log('Waiting for birthday button to render...', logs);

        // Use waitForSelector - far more reliable than fixed delays for SPA content
        // The exact selector comes from inspecting the real Roblox HTML
        let birthdaySel = null;
        const candidateSelectors = [
            'button[aria-label="Change Birthday"]',
            'button[title="Change Birthday"]',
            'button[data-testid="setting-text-field-edit-btn"]',
            '.account-change-settings-button.btn-generic-edit-sm'
        ];
        for (const sel of candidateSelectors) {
            try {
                await page.waitForSelector(sel, { timeout: 20000 });
                birthdaySel = sel;
                break;
            } catch (e) {}
        }

        if (!birthdaySel) {
            // Dump DOM to see what AngularJS actually rendered
            const domDump = await page.evaluate(() => {
                const main = document.querySelector('[ng-view], #content, main, .container, body');
                return (main ? main.innerHTML : document.body.innerHTML).substring(0, 1000);
            });
            log(`DOM after timeout: ${domDump.replace(/\s+/g, ' ')}`, logs);
            throw new Error('Birthday button never appeared in DOM after 20s');
        }
        log(`Birthday button found: ${birthdaySel}`, logs);

        // Small human-like pause before clicking
        await randomDelay(500, 900);
        await page.click(birthdaySel);
        log('Birthday edit clicked ✓', logs);
        await randomDelay(1000, 1500);

        // 4. "Update Your Birthday" modal - set dropdowns
        log('Waiting for birthday modal...', logs);
        await page.waitForSelector('[role="dialog"], .modal, [class*="modal"]', { timeout: 10000 });
        await randomDelay(700, 1000);

        const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        const targetMonth = MONTHS[parseInt(birthMonth) - 1];

        const setsResult = await page.evaluate((tMonth, tDay, tYear) => {
            const set = [];
            for (const sel of document.querySelectorAll('select')) {
                const opts = [...sel.options].map(o => o.text.trim());
                if (opts.some(o => ['January','February','March','Jan','Feb','Mar'].includes(o))) {
                    const match = [...sel.options].find(o => o.text.trim().startsWith(tMonth.slice(0, 3)));
                    if (match) { sel.value = match.value; sel.dispatchEvent(new Event('change', {bubbles:true})); set.push('month'); }
                } else if (opts.some(o => /^\d{1,2}$/.test(o)) && parseInt(opts.filter(o => /^\d/.test(o))[0]) <= 31) {
                    const match = [...sel.options].find(o => parseInt(o.text.trim()) === parseInt(tDay));
                    if (match) { sel.value = match.value; sel.dispatchEvent(new Event('change', {bubbles:true})); set.push('day'); }
                } else if (opts.some(o => /^(19|20)\d{2}$/.test(o))) {
                    const match = [...sel.options].find(o => parseInt(o.text.trim()) === parseInt(tYear));
                    if (match) { sel.value = match.value; sel.dispatchEvent(new Event('change', {bubbles:true})); set.push('year'); }
                }
            }
            return set;
        }, targetMonth, birthDay, birthYear);

        log(`Dropdowns set: ${setsResult.join(', ')}`, logs);
        await randomDelay(500, 800);

        // 5. Click Continue (birthday modal)
        log('Clicking Continue (birthday modal)...', logs);
        await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Continue' && b.offsetParent);
            if (btn) btn.click(); else throw new Error('No Continue button');
        });
        await randomDelay(800, 1200);

        // 6. "Are you sure?" — click Continue if it appears
        const hadConfirm = await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Continue' && b.offsetParent);
            if (btn) { btn.click(); return true; }
            return false;
        });
        log(hadConfirm ? 'Confirmed ✓' : 'No confirmation needed', logs);
        await randomDelay(800, 1200);

        // 7. Password input
        log('Waiting for password prompt...', logs);
        await page.waitForSelector('input[type="password"]', { timeout: 10000 });
        log('Typing password...', logs);

        await randomDelay(300, 500);
        await page.click('input[type="password"]');
        await randomDelay(200, 400);
        await page.type('input[type="password"]', password, { delay: 50 + Math.random() * 80 });
        await randomDelay(500, 900);

        // 8. Click Verify
        log('Clicking Verify...', logs);
        await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Verify' && b.offsetParent);
            if (btn) btn.click(); else throw new Error('No Verify button');
        });

        // 9. Wait for outcome
        await randomDelay(3000, 4500);

        const outcome = await page.evaluate(() => {
            // Modal gone = success
            const modal = document.querySelector('[role="dialog"], .modal, [class*="modal"]');
            if (!modal || !modal.offsetParent) return { success: true };
            const text = modal.innerText.toLowerCase();
            if (text.includes('incorrect') || text.includes('invalid') || text.includes('wrong')) {
                return { error: 'Incorrect password' };
            }
            return { success: true, note: modal.innerText.substring(0, 100) };
        });

        log(`Outcome: ${JSON.stringify(outcome)}`, logs);
        if (outcome.error) throw new Error(outcome.error);

        return { success: true };

    } finally {
        await page.close().catch(() => {});
    }
}

app.post("/api/change-birthdate", async (req, res) => {
    const logs = [];
    try {
        const { cookie, password, birthMonth, birthDay, birthYear } = req.body;
        if (!cookie || !password || !birthMonth || !birthDay || !birthYear) {
            return res.status(400).json({ success: false, error: "Missing fields" });
        }
        log('=== Starting birthdate change ===', logs);
        await changeBirthdateViaUI(cookie, password, birthMonth, birthDay, birthYear, logs);
        log('SUCCESS!', logs);
        res.json({ success: true, message: "Birthdate changed!", newBirthdate: { month: birthMonth, day: birthDay, year: birthYear }, logs });
    } catch (error) {
        log(`ERROR: ${error.message}`, logs);
        console.error(error);
        res.status(500).json({ success: false, error: error.message, logs });
    }
});

app.get("/api/health", async (req, res) => {
    try {
        const b = await initBrowser();
        res.json({ status: "ok", puppeteer: true, browser: await b.version(), chromePath: await findChrome() });
    } catch (error) {
        res.json({ status: "error", puppeteer: false, error: error.message });
    }
});

process.on('SIGINT', async () => { if (browser) await browser.close(); process.exit(0); });

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => log(`🚀 Server on port ${PORT}`));
