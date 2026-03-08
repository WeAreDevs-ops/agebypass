// birthdate-server.js - Puppeteer version with real browser automation
// Extracts x-bound-auth-token dynamically and simulates human behavior

const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

// Apply stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const sessions = new Map();

// Puppeteer browser instance (singleton)
let browserInstance = null;

async function getBrowser() {
    if (!browserInstance) {
        browserInstance = await puppeteer.launch({
            headless: "new", // Use new headless mode
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1920,1080',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-site-isolation-trials'
            ],
            defaultViewport: { width: 1920, height: 1080 }
        });
    }
    return browserInstance;
}

async function closeBrowser() {
    if (browserInstance) {
        await browserInstance.close();
        browserInstance = null;
    }
}

function delay(min, max) {
    return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));
}

function getSession(cookie) {
    const key = cookie.substring(0, 50);
    if (!sessions.has(key)) {
        sessions.set(key, {
            machineId: null,
            csrfToken: null,
            boundAuthToken: null,
            fp: {
                ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
                secChUa: '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
            }
        });
    }
    return sessions.get(key);
}

// Extract x-bound-auth-token from page's JavaScript context
async function extractBoundAuthToken(page) {
    try {
        // Method 1: Try to get from window object or Roblox's internal storage
        const token = await page.evaluate(() => {
            // Check various locations where Roblox might store the token
            if (window.Roblox && window.Roblox.BoundAuthToken) {
                return window.Roblox.BoundAuthToken;
            }
            if (window.boundAuthToken) {
                return window.boundAuthToken;
            }
            // Check localStorage
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.toLowerCase().includes('bound')) {
                    return localStorage.getItem(key);
                }
            }
            // Check sessionStorage
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (key && key.toLowerCase().includes('bound')) {
                    return sessionStorage.getItem(key);
                }
            }
            return null;
        });
        
        if (token) {
            console.log("✅ Found x-bound-auth-token in page context");
            return token;
        }
    } catch (e) {
        console.log("⚠️ Could not extract from page context:", e.message);
    }
    return null;
}

// Intercept network requests to capture x-bound-auth-token from headers
async function setupRequestInterception(page, session) {
    await page.setRequestInterception(true);
    
    page.on('request', (request) => {
        const headers = request.headers();
        
        // Capture x-bound-auth-token from outgoing requests
        if (headers['x-bound-auth-token']) {
            session.boundAuthToken = headers['x-bound-auth-token'];
            console.log("✅ Captured x-bound-auth-token from request headers");
        }
        
        // Capture x-csrf-token
        if (headers['x-csrf-token']) {
            session.csrfToken = headers['x-csrf-token'];
        }
        
        // Continue the request
        request.continue();
    });
    
    // Also capture from responses
    page.on('response', async (response) => {
        const headers = response.headers();
        if (headers['roblox-machine-id']) {
            session.machineId = headers['roblox-machine-id'];
        }
    });
}

// Navigate to Roblox and extract tokens using Puppeteer
async function getTokensViaBrowser(cookie, logs) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    
    const session = getSession(cookie);
    
    try {
        // Set up request interception to capture headers
        await setupRequestInterception(page, session);
        
        // Set user agent and viewport
        await page.setUserAgent(session.fp.ua);
        await page.setViewport({ width: 1920, height: 1080 });
        
        // Parse and set the cookie
        const cookieValue = cookie.startsWith(".ROBLOSECURITY=") ? cookie.substring(15) : cookie;
        
        // Navigate to a blank page first to set cookies
        await page.goto('https://www.roblox.com/', { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Set the auth cookie
        await page.setCookie({
            name: '.ROBLOSECURITY',
            value: cookieValue,
            domain: '.roblox.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'Lax'
        });
        
        logs.push("🔄 Navigating to account settings...");
        
        // Navigate to account info page (this triggers token generation)
        await page.goto('https://www.roblox.com/my/account#!/info', { 
            waitUntil: 'networkidle2', 
            timeout: 30000 
        });
        
        // Wait for page to fully load and scripts to execute
        await delay(3000, 5000);
        
        // Simulate human-like mouse movements
        await simulateHumanBehavior(page);
        
        // Try to extract token from page context
        let token = await extractBoundAuthToken(page);
        
        // If not found, try triggering an API call that would include the token
        if (!token) {
            logs.push("🔄 Triggering API call to capture token...");
            
            // Click on birthdate field or trigger some action that makes an API call
            await page.evaluate(() => {
                // Trigger a fetch to the birthdate endpoint to get the token in headers
                return fetch('https://users.roblox.com/v1/birthdate', {
                    method: 'GET',
                    credentials: 'include'
                }).catch(() => {});
            });
            
            await delay(2000, 3000);
            
            // Check again
            token = session.boundAuthToken || await extractBoundAuthToken(page);
        }
        
        // Get CSRF token if available
        const csrfToken = await page.evaluate(() => {
            // Roblox often stores CSRF token in meta tags or window object
            const meta = document.querySelector('meta[name="csrf-token"]');
            if (meta) return meta.content;
            
            if (window.Roblox && window.Roblox.CsrfToken) {
                return window.Roblox.CsrfToken;
            }
            return null;
        });
        
        if (csrfToken) {
            session.csrfToken = csrfToken;
        }
        
        logs.push(`✅ Browser session established`);
        logs.push(`   CSRF Token: ${session.csrfToken ? 'Found' : 'Not found'}`);
        logs.push(`   Bound Auth Token: ${session.boundAuthToken ? 'Found' : 'Not found'}`);
        
        return {
            success: true,
            csrfToken: session.csrfToken,
            boundAuthToken: session.boundAuthToken,
            machineId: session.machineId
        };
        
    } catch (error) {
        console.error("Browser error:", error);
        logs.push(`❌ Browser error: ${error.message}`);
        throw error;
    } finally {
        await page.close();
    }
}

// Simulate human-like behavior
async function simulateHumanBehavior(page) {
    // Random mouse movements
    for (let i = 0; i < 3; i++) {
        const x = Math.floor(Math.random() * 800) + 200;
        const y = Math.floor(Math.random() * 600) + 100;
        await page.mouse.move(x, y, { steps: 10 });
        await delay(200, 500);
    }
    
    // Random scroll
    await page.evaluate(() => {
        window.scrollBy(0, Math.floor(Math.random() * 300) + 100);
    });
    await delay(500, 1000);
}

// Make API request using fetch within the browser context
async function makeBrowserRequest(cookie, url, method, body = null, logs) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    
    const session = getSession(cookie);
    
    try {
        // Set cookies
        const cookieValue = cookie.startsWith(".ROBLOSECURITY=") ? cookie.substring(15) : cookie;
        await page.goto('https://www.roblox.com/', { waitUntil: 'domcontentloaded' });
        await page.setCookie({
            name: '.ROBLOSECURITY',
            value: cookieValue,
            domain: '.roblox.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'Lax'
        });
        
        // Execute the API request in browser context
        const result = await page.evaluate(async (url, method, body, headers) => {
            try {
                const options = {
                    method: method,
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/json;charset=utf-8',
                        'Accept': 'application/json, text/plain, */*',
                        'X-Requested-With': 'XMLHttpRequest',
                        ...headers
                    }
                };
                
                if (body && method !== 'GET') {
                    options.body = JSON.stringify(body);
                }
                
                const response = await fetch(url, options);
                
                // Get all response headers
                const responseHeaders = {};
                response.headers.forEach((value, key) => {
                    responseHeaders[key.toLowerCase()] = value;
                });
                
                const responseBody = await response.text();
                
                return {
                    status: response.status,
                    headers: responseHeaders,
                    body: responseBody
                };
            } catch (error) {
                return { error: error.message };
            }
        }, url, method, body, {
            'x-csrf-token': session.csrfToken || '',
            'x-bound-auth-token': session.boundAuthToken || '',
            'roblox-machine-id': session.machineId || ''
        });
        
        if (result.error) {
            throw new Error(result.error);
        }
        
        // Parse JSON body if possible
        let data = null;
        if (result.body) {
            try {
                data = JSON.parse(result.body);
            } catch (e) {
                data = null;
            }
        }
        
        // Update tokens from response headers
        if (result.headers['x-csrf-token']) {
            session.csrfToken = result.headers['x-csrf-token'];
        }
        if (result.headers['roblox-machine-id']) {
            session.machineId = result.headers['roblox-machine-id'];
        }
        
        return {
            status: result.status,
            headers: result.headers,
            body: result.body,
            data
        };
        
    } finally {
        await page.close();
    }
}

// Main API endpoint
app.post("/api/change-birthdate", async (req, res) => {
    try {
        const { cookie, password, birthMonth, birthDay, birthYear } = req.body;
        if (!cookie || !password || !birthMonth || !birthDay || !birthYear) {
            return res.status(400).json({ success: false, error: "Missing fields" });
        }

        const logs = [];
        const session = getSession(cookie);
        
        logs.push(`🔐 Using Puppeteer with stealth mode`);

        // Step 1: Get tokens via browser
        logs.push("🔄 Step 1: Establishing browser session...");
        try {
            await getTokensViaBrowser(cookie, logs);
        } catch (e) {
            logs.push(`⚠️ Token extraction warning: ${e.message}`);
        }
        
        if (!session.boundAuthToken) {
            logs.push("⚠️ Could not extract x-bound-auth-token, proceeding anyway...");
        }
        
        await delay(1000, 2000);

        // Step 2: Get CSRF token
        logs.push("🔄 Step 2: Getting CSRF token...");
        const csrfRes = await makeBrowserRequest(
            cookie,
            "https://auth.roblox.com/v2/logout",
            "POST",
            { description: "test" },
            logs
        );
        
        if (csrfRes.headers['x-csrf-token']) {
            session.csrfToken = csrfRes.headers['x-csrf-token'];
            logs.push("✅ Step 2: CSRF obtained");
        } else {
            logs.push("⚠️ Step 2: No CSRF in response, using existing");
        }

        await delay(1500, 2500);

        // Step 3: Trigger birthdate change
        logs.push("🔄 Step 3: Triggering birthdate change...");
        const changeRes = await makeBrowserRequest(
            cookie,
            "https://users.roblox.com/v1/birthdate",
            "POST",
            {
                birthMonth: parseInt(birthMonth),
                birthDay: parseInt(birthDay),
                birthYear: parseInt(birthYear)
            },
            logs
        );
        
        if (changeRes.status === 200) {
            logs.push("✅ Step 3: Success without challenge!");
            return res.json({
                success: true,
                message: "Birthdate changed!",
                newBirthdate: { month: birthMonth, day: birthDay, year: birthYear },
                logs
            });
        }

        if (changeRes.status !== 403) {
            logs.push(`❌ Step 3 failed: ${changeRes.status} - ${JSON.stringify(changeRes.data)}`);
            return res.status(500).json({
                success: false,
                error: `Status ${changeRes.status}`,
                logs
            });
        }

        const challengeId = changeRes.headers['rblx-challenge-id'];
        const challengeType = changeRes.headers['rblx-challenge-type'];
        const challengeMetadata = changeRes.headers['rblx-challenge-metadata'];

        if (!challengeId || !challengeType || !challengeMetadata) {
            logs.push("❌ No challenge headers");
            return res.status(500).json({ success: false, error: "No challenge", logs });
        }

        logs.push(`✅ Step 3: Challenge triggered`);
        logs.push(`   Challenge ID: ${challengeId}`);
        logs.push(`   Challenge Type: ${challengeType}`);

        let initialMetadata;
        try {
            const decodedMetadata = Buffer.from(challengeMetadata, 'base64').toString('utf8');
            initialMetadata = JSON.parse(decodedMetadata);
            logs.push(`   Decoded metadata: ${JSON.stringify(initialMetadata)}`);
        } catch (e) {
            logs.push(`⚠️ Failed to decode metadata: ${e.message}`);
            initialMetadata = {};
        }

        await delay(2000, 3500);

        // Step 4: Continue challenge
        logs.push("🔄 Step 4: Continuing challenge...");
        
        const contRes = await makeBrowserRequest(
            cookie,
            "https://apis.roblox.com/challenge/v1/continue",
            "POST",
            {
                challengeID: challengeId,
                challengeMetadata: JSON.stringify({
                    userId: initialMetadata.userId,
                    challengeId: challengeId,
                    browserTrackerId: initialMetadata.browserTrackerId || Date.now().toString()
                }),
                challengeType: challengeType
            },
            logs
        );
        
        if (contRes.status !== 200) {
            logs.push(`❌ Step 4 failed: ${contRes.status} - ${JSON.stringify(contRes.data)}`);
            return res.status(500).json({ success: false, error: "Continue failed", logs });
        }

        logs.push(`✅ Step 4: Challenge continued`);
        logs.push(`   New Challenge Type: ${contRes.data?.challengeType}`);

        const continueMetadata = contRes.data ? JSON.parse(contRes.data.challengeMetadata || '{}') : {};
        const userId = continueMetadata.userId;
        const innerChallengeId = continueMetadata.challengeId;
        const actionType = continueMetadata.actionType || "Generic";

        logs.push(`   User ID: ${userId}`);
        logs.push(`   Inner Challenge ID: ${innerChallengeId}`);
        logs.push(`   Action Type: ${actionType}`);

        await delay(2500, 4000);

        // Step 5: Verify password
        logs.push("🔄 Step 5: Verifying password...");
        const verifyRes = await makeBrowserRequest(
            cookie,
            `https://twostepverification.roblox.com/v1/users/${userId}/challenges/password/verify`,
            "POST",
            {
                challengeId: innerChallengeId,
                actionType: actionType,
                code: password
            },
            logs
        );
        
        logs.push(`   Response: ${JSON.stringify(verifyRes.data)}`);

        if (verifyRes.status !== 200) {
            logs.push(`❌ Step 5 failed: ${verifyRes.status}`);
            return res.status(500).json({ success: false, error: "Verify failed", logs });
        }

        const verificationToken = verifyRes.data?.verificationToken;
        if (!verificationToken) {
            logs.push("❌ No verification token");
            return res.status(500).json({ success: false, error: "No verification token", logs });
        }
        logs.push("✅ Step 5: Verified");

        await delay(2000, 3500);

        // Step 6: Complete challenge
        logs.push("🔄 Step 6: Completing challenge...");
        const completeRes = await makeBrowserRequest(
            cookie,
            "https://apis.roblox.com/challenge/v1/continue",
            "POST",
            {
                challengeId: contRes.data?.challengeId,
                challengeType: "twostepverification",
                challengeMetadata: JSON.stringify({
                    rememberDevice: false,
                    actionType: actionType,
                    verificationToken: verificationToken,
                    challengeId: innerChallengeId
                })
            },
            logs
        );

        if (completeRes.status !== 200 || completeRes.data?.challengeType === "blocksession") {
            logs.push(`❌ Step 6 blocked/failed: ${JSON.stringify(completeRes.data)}`);
            return res.status(500).json({ success: false, error: "Challenge blocked", logs });
        }
        logs.push("✅ Step 6: Completed");

        await delay(2500, 4000);

        // Step 7: Final birthdate change
        logs.push("🔄 Step 7: Final birthdate change...");
        
        const finalMetadata = Buffer.from(JSON.stringify({
            rememberDevice: false,
            actionType: actionType,
            verificationToken: verificationToken,
            challengeId: innerChallengeId
        })).toString("base64");
        
        const finalRes = await makeBrowserRequest(
            cookie,
            "https://users.roblox.com/v1/birthdate",
            "POST",
            {
                birthMonth: parseInt(birthMonth),
                birthDay: parseInt(birthDay),
                birthYear: parseInt(birthYear)
            },
            logs
        );

        if (finalRes.status !== 200) {
            logs.push(`❌ Step 7 failed: ${finalRes.status} - ${JSON.stringify(finalRes.data)}`);
            return res.status(500).json({ success: false, error: "Final failed", logs });
        }

        logs.push("✅ Step 7: Birthdate changed successfully!");
        logs.push("🎉 ALL DONE!");

        res.json({
            success: true,
            message: "Birthdate changed!",
            newBirthdate: { month: birthMonth, day: birthDay, year: birthYear },
            logs
        });

    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ success: false, error: error.message, logs: [error.stack] });
    }
});

app.get("/api/health", async (req, res) => {
    const browserReady = browserInstance !== null;
    res.json({ 
        status: "ok", 
        puppeteer: true,
        browserReady
    });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    await closeBrowser();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down...');
    await closeBrowser();
    process.exit(0);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Puppeteer Server on port ${PORT}`);
    console.log(`🎭 Stealth mode enabled`);
});
