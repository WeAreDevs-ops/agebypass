// birthdate-server-railway.js - Railway-optimized version with better error handling

const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Logger helper
function log(msg, logs = null) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    if (logs) logs.push(line);
}

// Find Chrome executable
async function findChrome() {
    // Check environment variable first
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    
    // Common paths on Railway/Linux
    const possiblePaths = [
        '/app/.cache/puppeteer/chrome/linux-*/chrome-linux/chrome',
        '/root/.cache/puppeteer/chrome/linux-*/chrome-linux/chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        'google-chrome',
        'chromium',
        'chromium-browser'
    ];
    
    const fs = require('fs');
    const path = require('path');
    const { execSync } = require('child_process');
    
    for (const p of possiblePaths) {
        try {
            // Handle wildcards
            if (p.includes('*')) {
                const dir = p.split('*')[0];
                if (fs.existsSync(dir)) {
                    const files = fs.readdirSync(dir);
                    for (const f of files) {
                        const fullPath = p.replace('*', f);
                        if (fs.existsSync(fullPath)) {
                            return fullPath;
                        }
                    }
                }
            } else {
                // Try which command
                try {
                    const result = execSync(`which ${p}`, { encoding: 'utf8' }).trim();
                    if (result) return result;
                } catch (e) {}
                
                // Check if file exists
                if (fs.existsSync(p)) {
                    return p;
                }
            }
        } catch (e) {}
    }
    
    return null;
}

// Browser singleton
let browser = null;
let browserError = null;

async function initBrowser() {
    if (browser) return browser;
    if (browserError) throw browserError;
    
    try {
        const chromePath = await findChrome();
        log(`Chrome path: ${chromePath || 'not found, using bundled'}`);
        
        const launchOptions = {
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--single-process',
                '--no-zygote',
                '--window-size=1280,720',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
            defaultViewport: { width: 1280, height: 720 }
        };
        
        if (chromePath) {
            launchOptions.executablePath = chromePath;
        }
        
        log('Launching browser...');
        browser = await puppeteer.launch(launchOptions);
        log('Browser launched successfully');
        
        browser.on('disconnected', () => {
            log('Browser disconnected');
            browser = null;
        });
        
        return browser;
    } catch (error) {
        browserError = error;
        log(`Browser init error: ${error.message}`);
        throw error;
    }
}

function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function randomDelay(min, max) {
    return delay(Math.floor(Math.random() * (max - min + 1)) + min);
}

// Extract tokens from page
async function extractTokens(page) {
    return await page.evaluate(() => {
        const result = { csrf: null, bound: null, machineId: null };
        
        // Check window.Roblox
        if (window.Roblox) {
            result.csrf = window.Roblox.CsrfToken || window.Roblox.csrfToken;
            result.bound = window.Roblox.BoundAuthToken || window.Roblox.boundAuthToken;
            result.machineId = window.Roblox.MachineId || window.Roblox.machineId;
        }
        
        // Check meta tags
        if (!result.csrf) {
            const meta = document.querySelector('meta[name="csrf-token"]');
            if (meta) result.csrf = meta.content;
        }
        
        // Check data attributes
        if (!result.csrf) {
            const body = document.body;
            if (body) result.csrf = body.dataset.csrfToken;
        }
        
        return result;
    });
}

// Get fresh session - keeps page OPEN so Roblox JS stays alive for all API calls
async function getSession(cookie, logs) {
    const session = {
        csrfToken: null,
        boundAuthToken: null,
        machineId: null,
        valid: false,
        page: null,   // persistent page for all subsequent API calls
        cdp: null     // CDP session for token capture
    };

    let page = null;

    try {
        const browser = await initBrowser();
        page = await browser.newPage();

        // Set up CDP session - Fetch.enable is called per-request inside cdpFetch
        // No general listener here to avoid conflicting with cdpFetch's fulfill logic
        const cdp = await page.target().createCDPSession();
        await cdp.send('Fetch.enable', {
            patterns: [{ urlPattern: '*roblox.com*', requestStage: 'Request' }]
        });

        // Pass-through handler: let all page navigation requests through normally
        // cdpFetch will temporarily override this for specific API calls
        cdp.on('Fetch.requestPaused', async (params) => {
            await cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
        });

        // Parse cookie
        const cookieValue = cookie.startsWith(".ROBLOSECURITY=") ? cookie.substring(15) : cookie;

        // Step 1: Navigate to Roblox
        log('Navigating to Roblox...', logs);
        await page.goto('https://www.roblox.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 20000
        });

        // Set cookie
        await page.setCookie({
            name: '.ROBLOSECURITY',
            value: cookieValue,
            domain: '.roblox.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'Lax'
        });

        // Step 2: Go to account page - this loads Roblox's full JS bundle
        log('Going to account page...', logs);
        await page.goto('https://www.roblox.com/my/account#!/info', {
            waitUntil: 'networkidle0',
            timeout: 30000
        });

        // Wait for JS to fully initialize
        await randomDelay(2000, 3000);

        // Check if logged in
        const url = page.url();
        if (url.includes('/login')) {
            log('Cookie invalid - redirected to login', logs);
            await page.close();
            return session;
        }

        session.valid = true;
        log('Cookie valid, session established', logs);

        // Extract tokens from page
        const pageTokens = await extractTokens(page);
        if (pageTokens.csrf) session.csrfToken = pageTokens.csrf;
        if (pageTokens.bound) session.boundAuthToken = pageTokens.bound;
        if (pageTokens.machineId) session.machineId = pageTokens.machineId;

        // Assign page + cdp to session - ready for API calls
        session.page = page;
        session.cdp = cdp;

        // x-bound-auth-token is only generated by Roblox's JS on POST requests,
        // so we don't warm-up here. cdpFetch captures it fresh on the first real POST.
        log(`Session status: CSRF=${session.csrfToken ? 'Y' : 'N'}, Bound=pending (captured on first POST), Machine=${session.machineId ? 'Y' : 'N'}`, logs);
        return session;

    } catch (error) {
        log(`Session error: ${error.message}`, logs);
        // Close page on error only
        if (page) try { await page.close(); } catch (e) {}
        throw error;
    }
    // NOTE: No finally close - page stays open intentionally
}

// cdpFetch: triggers a fetch from within the live Roblox page so Roblox's JS attaches
// a fresh x-bound-auth-token, then CDP intercepts it, captures all headers,
// and fulfills it via Node.js fetch (bypasses Chromium's sandboxed network on Railway).
async function cdpFetch(cookie, url, method, body, session) {
    const page = session.page;
    const cdp = session.cdp;
    if (!page || !cdp) throw new Error('No active browser session');

    const cookieValue = cookie.startsWith('.ROBLOSECURITY=') ? cookie : `.ROBLOSECURITY=${cookie}`;
    const targetBase = url.split('?')[0];

    return new Promise((resolve, reject) => {
        // Remove the default pass-through listener so it doesn't race with our handler
        cdp.removeAllListeners('Fetch.requestPaused');

        const handler = async (params) => {
            // Not our target - pass through normally
            if (!params.request.url.startsWith(targetBase)) {
                cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
                return;
            }

            // Our request intercepted - stop listening
            cdp.off('Fetch.requestPaused', handler);

            // Restore default pass-through for any subsequent page requests
            cdp.on('Fetch.requestPaused', async (p) => {
                cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
            });

            // Capture all tokens Roblox's JS attached to this request
            const reqHeaders = params.request.headers || {};
            if (reqHeaders['x-bound-auth-token']) session.boundAuthToken = reqHeaders['x-bound-auth-token'];
            if (reqHeaders['x-csrf-token']) session.csrfToken = reqHeaders['x-csrf-token'];
            if (reqHeaders['roblox-machine-id']) session.machineId = reqHeaders['roblox-machine-id'];

            // Build Node.js headers from what Roblox's JS built, plus cookie + challenge headers
            const nodeHeaders = { ...reqHeaders, 'Cookie': cookieValue };
            if (session.challengeHeaders) Object.assign(nodeHeaders, session.challengeHeaders);

            // Make actual HTTP call via Node.js - unrestricted network
            fetch(url, {
                method,
                headers: nodeHeaders,
                body: body ? JSON.stringify(body) : undefined
            }).then(async (response) => {
                const responseBody = await response.text();
                const responseHeaders = {};
                response.headers.forEach((v, k) => { responseHeaders[k] = v; });

                // Update tokens from response
                if (responseHeaders['x-csrf-token']) session.csrfToken = responseHeaders['x-csrf-token'];
                if (responseHeaders['roblox-machine-id']) session.machineId = responseHeaders['roblox-machine-id'];

                // Fulfill back to the page so Roblox's JS isn't left hanging
                await cdp.send('Fetch.fulfillRequest', {
                    requestId: params.requestId,
                    responseCode: response.status,
                    responseHeaders: Object.entries(responseHeaders).map(([name, value]) => ({ name, value: String(value) })),
                    body: Buffer.from(responseBody).toString('base64')
                }).catch(() => {});

                let data = null;
                try { data = JSON.parse(responseBody); } catch (e) {}
                resolve({ status: response.status, headers: responseHeaders, body: responseBody, data });
            }).catch(async (err) => {
                await cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Failed' }).catch(() => {});
                reject(err);
            });
        };

        // Register our handler before triggering
        cdp.on('Fetch.requestPaused', handler);

        // Trigger fetch from inside the live Roblox page - Roblox's JS interceptor attaches x-bound-auth-token
        page.evaluate(async (url, method, body, csrfToken, challengeHeaders) => {
            const headers = {
                'Content-Type': 'application/json;charset=utf-8',
                'Accept': 'application/json, text/plain, */*',
                'X-Requested-With': 'XMLHttpRequest'
            };
            if (csrfToken) headers['x-csrf-token'] = csrfToken;
            if (challengeHeaders) Object.assign(headers, challengeHeaders);
            try {
                await fetch(url, { method, credentials: 'include', headers, body: body ? JSON.stringify(body) : undefined });
            } catch (e) {}
        }, url, method, body, session.csrfToken, session.challengeHeaders || null).catch(() => {});
    });
}

async function apiRequest(cookie, url, method, body, session, logs) {
    return cdpFetch(cookie, url, method, body, session);
}

// API endpoint
app.post("/api/change-birthdate", async (req, res) => {
    const logs = [];
    let session = null;

    try {
        const { cookie, password, birthMonth, birthDay, birthYear } = req.body;
        
        if (!cookie || !password || !birthMonth || !birthDay || !birthYear) {
            return res.status(400).json({ success: false, error: "Missing fields" });
        }
        
        log('=== Starting birthdate change ===', logs);
        
        // Step 1: Get session
        log('Step 1: Getting session...', logs);
        session = await getSession(cookie, logs);
        
        if (!session.valid) {
            return res.status(401).json({ success: false, error: "Invalid cookie", logs });
        }
        
        await randomDelay(1000, 2000);
        
        // Step 2: Trigger birthdate change
        log('Step 2: Triggering birthdate change...', logs);
        
        const changeRes = await apiRequest(
            cookie,
            'https://users.roblox.com/v1/birthdate',
            'POST',
            {
                birthMonth: parseInt(birthMonth),
                birthDay: parseInt(birthDay),
                birthYear: parseInt(birthYear)
            },
            session,
            logs
        );
        
        log(`Response: ${changeRes.status}`, logs);
        
        if (changeRes.status === 200) {
            log('Success! No challenge needed.', logs);
            return res.json({
                success: true,
                message: "Birthdate changed!",
                newBirthdate: { month: birthMonth, day: birthDay, year: birthYear },
                logs
            });
        }
        
        if (changeRes.status !== 403) {
            log(`Unexpected status: ${changeRes.status}`, logs);
            return res.status(500).json({ success: false, error: `Status ${changeRes.status}`, logs });
        }
        
        // Handle challenge
        const challengeId = changeRes.headers['rblx-challenge-id'];
        const challengeType = changeRes.headers['rblx-challenge-type'];
        const challengeMetadata = changeRes.headers['rblx-challenge-metadata'];
        
        if (!challengeId) {
            log('No challenge headers', logs);
            return res.status(500).json({ success: false, error: "No challenge", logs });
        }
        
        log(`Challenge: ${challengeType} (${challengeId.substring(0, 20)}...)`, logs);
        
        let metadata = {};
        try {
            metadata = JSON.parse(Buffer.from(challengeMetadata, 'base64').toString());
        } catch (e) {}
        
        await randomDelay(1500, 2500);
        
        // Step 3: Continue challenge
        log('Step 3: Continuing challenge...', logs);
        
        const contRes = await apiRequest(
            cookie,
            'https://apis.roblox.com/challenge/v1/continue',
            'POST',
            {
                challengeID: challengeId,
                challengeType: challengeType,
                challengeMetadata: JSON.stringify({
                    userId: metadata.userId,
                    challengeId: challengeId,
                    browserTrackerId: metadata.browserTrackerId || Date.now().toString()
                })
            },
            session,
            logs
        );
        
        if (contRes.status !== 200) {
            log(`Continue failed: ${contRes.status}`, logs);
            return res.status(500).json({ success: false, error: "Continue failed", logs });
        }
        
        const contData = contRes.data || {};
        let contMeta = {};
        try {
            contMeta = JSON.parse(contData.challengeMetadata || '{}');
        } catch (e) {}
        
        log(`Challenge continued: ${contData.challengeType}`, logs);
        
        await randomDelay(2000, 3500);
        
        // Step 4: Verify password
        log('Step 4: Verifying password...', logs);
        
        const verifyRes = await apiRequest(
            cookie,
            `https://twostepverification.roblox.com/v1/users/${contMeta.userId}/challenges/password/verify`,
            'POST',
            {
                challengeId: contMeta.challengeId,
                actionType: contMeta.actionType || 'Generic',
                code: password
            },
            session,
            logs
        );
        
        log(`Verify response: ${verifyRes.status}`, logs);
        
        if (verifyRes.status !== 200) {
            log('Password verification failed', logs);
            return res.status(500).json({ success: false, error: "Invalid password", logs });
        }
        
        const verificationToken = verifyRes.data?.verificationToken;
        if (!verificationToken) {
            log('No verification token', logs);
            return res.status(500).json({ success: false, error: "No token", logs });
        }
        
        log('Password verified', logs);
        await randomDelay(1500, 2500);
        
        // Step 5: Complete challenge
        log('Step 5: Completing challenge...', logs);
        
        const completeRes = await apiRequest(
            cookie,
            'https://apis.roblox.com/challenge/v1/continue',
            'POST',
            {
                challengeId: contData.challengeId,
                challengeType: 'twostepverification',
                challengeMetadata: JSON.stringify({
                    rememberDevice: false,
                    actionType: contMeta.actionType || 'Generic',
                    verificationToken: verificationToken,
                    challengeId: contMeta.challengeId
                })
            },
            session,
            logs
        );
        
        if (completeRes.data?.challengeType === 'blocksession') {
            log('BLOCKED: Session flagged as automated', logs);
            return res.status(500).json({ success: false, error: "Blocked - detection", logs });
        }
        
        if (completeRes.status !== 200) {
            log(`Complete failed: ${completeRes.status}`, logs);
            return res.status(500).json({ success: false, error: "Complete failed", logs });
        }
        
        log('Challenge completed', logs);
        await randomDelay(2000, 3000);
        
        // Step 6: Final birthdate change
        log('Step 6: Final birthdate change...', logs);
        
        const finalMeta = Buffer.from(JSON.stringify({
            rememberDevice: false,
            actionType: contMeta.actionType || 'Generic',
            verificationToken: verificationToken,
            challengeId: contMeta.challengeId
        })).toString('base64');
        
        const finalSession = {
            ...session,
            challengeHeaders: {
                'rblx-challenge-id': contData.challengeId,
                'rblx-challenge-type': 'twostepverification',
                'rblx-challenge-metadata': finalMeta
            }
        };
        
        const finalRes = await apiRequest(
            cookie,
            'https://users.roblox.com/v1/birthdate',
            'POST',
            {
                birthMonth: parseInt(birthMonth),
                birthDay: parseInt(birthDay),
                birthYear: parseInt(birthYear)
            },
            finalSession,
            logs
        );
        
        if (finalRes.status !== 200) {
            log(`Final failed: ${finalRes.status}`, logs);
            return res.status(500).json({ success: false, error: "Final failed", logs });
        }
        
        log('SUCCESS! Birthdate changed.', logs);
        
        res.json({
            success: true,
            message: "Birthdate changed!",
            newBirthdate: { month: birthMonth, day: birthDay, year: birthYear },
            logs
        });
        
    } catch (error) {
        log(`ERROR: ${error.message}`, logs);
        console.error(error);
        res.status(500).json({ success: false, error: error.message, logs });
    } finally {
        // Always close the persistent page when request is done
        if (session && session.page) {
            try { await session.page.close(); } catch (e) {}
        }
    }
});

app.get("/api/health", async (req, res) => {
    try {
        const browser = await initBrowser();
        const version = await browser.version();
        res.json({ 
            status: "ok", 
            puppeteer: true,
            browser: version,
            chromePath: await findChrome()
        });
    } catch (error) {
        res.json({ 
            status: "error", 
            puppeteer: false,
            error: error.message
        });
    }
});

// Cleanup
process.on('SIGINT', async () => {
    if (browser) await browser.close();
    process.exit(0);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
    log(`🚀 Railway-Optimized Server on port ${PORT}`);
});
