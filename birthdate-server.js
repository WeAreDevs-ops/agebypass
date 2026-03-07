// birthdate-server-optimized.js - Optimized for automatic x-bound-auth-token generation
// Roblox's JS generates the token automatically - we just need to capture it from requests

const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Browser singleton
let browser = null;

async function getBrowser() {
    if (!browser) {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1920,1080',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
            defaultViewport: { width: 1920, height: 1080 }
        });
    }
    return browser;
}

function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function randomDelay(min, max) {
    return delay(Math.floor(Math.random() * (max - min + 1)) + min);
}

// Main function: Visit Roblox, let JS generate token, capture it from requests
async function getRobloxSession(cookie) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    
    const session = {
        csrfToken: null,
        boundAuthToken: null,
        machineId: null,
        cookieValid: false,
        userId: null
    };
    
    // CRITICAL: Set up request interception BEFORE any navigation
    const cdpSession = await page.target().createCDPSession();
    await cdpSession.send('Fetch.enable', {
        patterns: [{ urlPattern: '*roblox.com*', requestStage: 'Request' }]
    });
    
    // Capture ALL request headers including x-bound-auth-token
    cdpSession.on('Fetch.requestPaused', async (params) => {
        const { requestId, request } = params;
        
        // Extract headers
        const headers = request.headers || {};
        
        if (headers['x-bound-auth-token']) {
            session.boundAuthToken = headers['x-bound-auth-token'];
            console.log('🔑 Captured x-bound-auth-token:', session.boundAuthToken.substring(0, 40) + '...');
        }
        
        if (headers['x-csrf-token']) {
            session.csrfToken = headers['x-csrf-token'];
        }
        
        if (headers['roblox-machine-id']) {
            session.machineId = headers['roblox-machine-id'];
        }
        
        // Continue the request (don't block)
        await cdpSession.send('Fetch.continueRequest', { requestId });
    });
    
    // Also capture from responses
    page.on('response', async (response) => {
        const headers = response.headers();
        if (headers['x-csrf-token']) session.csrfToken = headers['x-csrf-token'];
        if (headers['roblox-machine-id']) session.machineId = headers['roblox-machine-id'];
        
        // Try to get user ID from any response
        try {
            if (response.url().includes('/v1/users/') || response.url().includes('/v1/birthdate')) {
                const body = await response.text().catch(() => null);
                if (body) {
                    const match = body.match(/"userId":\s*(\d+)/);
                    if (match) session.userId = match[1];
                }
            }
        } catch (e) {}
    });
    
    try {
        const cookieValue = cookie.startsWith(".ROBLOSECURITY=") ? cookie.substring(15) : cookie;
        
        // Step 1: Navigate to Roblox homepage (loads their JS framework)
        console.log('🌐 Step 1: Loading Roblox homepage...');
        await page.goto('https://www.roblox.com/', { 
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        // Step 2: Set the auth cookie
        console.log('🍪 Step 2: Setting auth cookie...');
        await page.setCookie({
            name: '.ROBLOSECURITY',
            value: cookieValue,
            domain: '.roblox.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'Lax'
        });
        
        // Step 3: Navigate to account page (triggers token generation)
        console.log('👤 Step 3: Navigating to account settings...');
        await page.goto('https://www.roblox.com/my/account#!/info', { 
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        // Wait for Roblox's JS to initialize and generate tokens
        console.log('⏳ Step 4: Waiting for Roblox JS to initialize...');
        await randomDelay(3000, 5000);
        
        // Step 5: Trigger an API call to force token attachment
        // This is key - Roblox's JS wraps fetch/XHR and adds the token
        console.log('🔄 Step 5: Triggering API call to capture token...');
        
        await page.evaluate(async () => {
            // This will be intercepted by Roblox's JS which adds x-bound-auth-token
            try {
                await fetch('https://users.roblox.com/v1/birthdate', {
                    method: 'GET',
                    credentials: 'include'
                });
            } catch (e) {}
        });
        
        // Wait for the request to be made and token to be captured
        await randomDelay(2000, 3000);
        
        // Step 6: If still no token, try clicking on the birthdate field
        // This definitely triggers token generation
        if (!session.boundAuthToken) {
            console.log('🖱️ Step 6: Clicking birthdate field to trigger token...');
            
            // Try multiple selectors for the birthdate edit button
            const selectors = [
                '[data-testid="birthdate-edit-button"]',
                '.birthdate-edit-button',
                'button[ng-click*="birthdate"]',
                '.account-info-section .btn-edit',
                '.account-info-section button'
            ];
            
            for (const selector of selectors) {
                try {
                    const btn = await page.$(selector);
                    if (btn) {
                        await btn.click();
                        console.log('   Clicked:', selector);
                        break;
                    }
                } catch (e) {}
            }
            
            await randomDelay(2000, 3000);
        }
        
        // Step 7: Try another API call after clicking
        if (!session.boundAuthToken) {
            console.log('🔄 Step 7: Second API call attempt...');
            await page.evaluate(async () => {
                try {
                    await fetch('https://auth.roblox.com/v2/logout', {
                        method: 'POST',
                        credentials: 'include',
                        body: JSON.stringify({})
                    });
                } catch (e) {}
            });
            await randomDelay(2000, 3000);
        }
        
        // Check if we're logged in
        const currentUrl = page.url();
        session.cookieValid = !currentUrl.includes('/login');
        
        console.log('\n📊 Session Status:');
        console.log('   Cookie Valid:', session.cookieValid);
        console.log('   CSRF Token:', session.csrfToken ? '✅' : '❌');
        console.log('   Bound Auth Token:', session.boundAuthToken ? '✅' : '❌');
        console.log('   Machine ID:', session.machineId ? '✅' : '❌');
        
        return session;
        
    } finally {
        await cdpSession.detach();
        await page.close();
    }
}

// Make API request using captured tokens
async function makeApiRequest(cookie, url, method, body, session, logs) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    
    try {
        const cookieValue = cookie.startsWith(".ROBLOSECURITY=") ? cookie.substring(15) : cookie;
        
        // Set cookie first
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
        
        // Make the request with captured tokens
        const result = await page.evaluate(async (url, method, body, tokens) => {
            try {
                const headers = {
                    'Content-Type': 'application/json;charset=utf-8',
                    'Accept': 'application/json, text/plain, */*',
                    'Origin': 'https://www.roblox.com',
                    'Referer': 'https://www.roblox.com/my/account#!/info',
                    'X-Requested-With': 'XMLHttpRequest'
                };
                
                if (tokens.csrfToken) headers['x-csrf-token'] = tokens.csrfToken;
                if (tokens.boundAuthToken) headers['x-bound-auth-token'] = tokens.boundAuthToken;
                if (tokens.machineId) headers['roblox-machine-id'] = tokens.machineId;
                
                const response = await fetch(url, {
                    method,
                    credentials: 'include',
                    headers,
                    body: body ? JSON.stringify(body) : undefined
                });
                
                const responseHeaders = {};
                response.headers.forEach((v, k) => responseHeaders[k] = v);
                
                return {
                    status: response.status,
                    headers: responseHeaders,
                    body: await response.text()
                };
            } catch (error) {
                return { error: error.message };
            }
        }, url, method, body, session);
        
        if (result.error) throw new Error(result.error);
        
        // Parse body
        let data = null;
        try {
            data = JSON.parse(result.body);
        } catch (e) {}
        
        // Update tokens from response
        if (result.headers['x-csrf-token']) session.csrfToken = result.headers['x-csrf-token'];
        if (result.headers['roblox-machine-id']) session.machineId = result.headers['roblox-machine-id'];
        
        return { ...result, data };
        
    } finally {
        await page.close();
    }
}

// Main API endpoint
app.post("/api/change-birthdate", async (req, res) => {
    const logs = [];
    
    try {
        const { cookie, password, birthMonth, birthDay, birthYear } = req.body;
        if (!cookie || !password || !birthMonth || !birthDay || !birthYear) {
            return res.status(400).json({ success: false, error: "Missing fields" });
        }

        logs.push("🎭 Starting optimized Puppeteer automation...");
        logs.push("🔑 Token will be auto-generated by Roblox's JS");

        // Step 1: Get session with auto-generated token
        logs.push("🔄 Step 1: Establishing session...");
        const session = await getRobloxSession(cookie);
        
        if (!session.cookieValid) {
            logs.push("❌ Invalid cookie - not logged in");
            return res.status(401).json({ success: false, error: "Invalid cookie", logs });
        }
        
        if (!session.boundAuthToken) {
            logs.push("⚠️ Warning: Could not capture x-bound-auth-token");
            logs.push("   This may cause 'blocksession' errors");
        } else {
            logs.push("✅ Step 1: Session established with auto-generated token");
        }
        
        await randomDelay(1000, 2000);

        // Step 2: Trigger birthdate change
        logs.push("🔄 Step 2: Triggering birthdate change...");
        
        const changeRes = await makeApiRequest(
            cookie,
            "https://users.roblox.com/v1/birthdate",
            "POST",
            {
                birthMonth: parseInt(birthMonth),
                birthDay: parseInt(birthDay),
                birthYear: parseInt(birthYear)
            },
            session,
            logs
        );
        
        if (changeRes.status === 200) {
            logs.push("✅ Step 2: Success without challenge!");
            return res.json({
                success: true,
                message: "Birthdate changed!",
                newBirthdate: { month: birthMonth, day: birthDay, year: birthYear },
                logs
            });
        }

        if (changeRes.status !== 403) {
            logs.push(`❌ Step 2 failed: ${changeRes.status} - ${changeRes.body}`);
            return res.status(500).json({ success: false, error: `Status ${changeRes.status}`, logs });
        }

        // Handle challenge flow
        const challengeId = changeRes.headers['rblx-challenge-id'];
        const challengeType = changeRes.headers['rblx-challenge-type'];
        const challengeMetadata = changeRes.headers['rblx-challenge-metadata'];

        if (!challengeId || !challengeType) {
            logs.push("❌ No challenge headers received");
            return res.status(500).json({ success: false, error: "No challenge", logs });
        }

        logs.push(`✅ Step 2: Challenge triggered (${challengeType})`);
        logs.push(`   Challenge ID: ${challengeId}`);

        let initialMetadata = {};
        try {
            initialMetadata = JSON.parse(Buffer.from(challengeMetadata, 'base64').toString());
        } catch (e) {}

        await randomDelay(1500, 2500);

        // Step 3: Continue challenge
        logs.push("🔄 Step 3: Continuing challenge...");
        
        const contRes = await makeApiRequest(
            cookie,
            "https://apis.roblox.com/challenge/v1/continue",
            "POST",
            {
                challengeID: challengeId,
                challengeType: challengeType,
                challengeMetadata: JSON.stringify({
                    userId: initialMetadata.userId,
                    challengeId: challengeId,
                    browserTrackerId: initialMetadata.browserTrackerId || Date.now().toString()
                })
            },
            session,
            logs
        );
        
        if (contRes.status !== 200) {
            logs.push(`❌ Step 3 failed: ${contRes.status} - ${contRes.body}`);
            return res.status(500).json({ success: false, error: "Continue failed", logs });
        }

        logs.push(`✅ Step 3: Challenge continued`);
        
        const contData = contRes.data || {};
        logs.push(`   New type: ${contData.challengeType}`);

        let contMetadata = {};
        try {
            contMetadata = JSON.parse(contData.challengeMetadata || '{}');
        } catch (e) {}

        await randomDelay(2000, 3500);

        // Step 4: Verify password
        logs.push("🔄 Step 4: Verifying password...");
        
        const verifyRes = await makeApiRequest(
            cookie,
            `https://twostepverification.roblox.com/v1/users/${contMetadata.userId}/challenges/password/verify`,
            "POST",
            {
                challengeId: contMetadata.challengeId,
                actionType: contMetadata.actionType || "Generic",
                code: password
            },
            session,
            logs
        );
        
        logs.push(`   Response: ${verifyRes.body}`);

        if (verifyRes.status !== 200) {
            logs.push(`❌ Step 4 failed: ${verifyRes.status}`);
            return res.status(500).json({ success: false, error: "Verify failed", logs });
        }

        const verificationToken = verifyRes.data?.verificationToken;
        if (!verificationToken) {
            logs.push("❌ No verification token");
            return res.status(500).json({ success: false, error: "No token", logs });
        }
        
        logs.push("✅ Step 4: Verified");
        await randomDelay(1500, 2500);

        // Step 5: Complete challenge
        logs.push("🔄 Step 5: Completing challenge...");
        
        const completeRes = await makeApiRequest(
            cookie,
            "https://apis.roblox.com/challenge/v1/continue",
            "POST",
            {
                challengeId: contData.challengeId,
                challengeType: "twostepverification",
                challengeMetadata: JSON.stringify({
                    rememberDevice: false,
                    actionType: contMetadata.actionType || "Generic",
                    verificationToken: verificationToken,
                    challengeId: contMetadata.challengeId
                })
            },
            session,
            logs
        );

        if (completeRes.data?.challengeType === "blocksession") {
            logs.push(`❌ Step 5 blocked: ${completeRes.body}`);
            return res.status(500).json({ success: false, error: "Challenge blocked - likely detection", logs });
        }
        
        if (completeRes.status !== 200) {
            logs.push(`❌ Step 5 failed: ${completeRes.status} - ${completeRes.body}`);
            return res.status(500).json({ success: false, error: "Complete failed", logs });
        }
        
        logs.push("✅ Step 5: Completed");
        await randomDelay(2000, 3000);

        // Step 6: Final birthdate change
        logs.push("🔄 Step 6: Final birthdate change...");
        
        const finalMetadata = Buffer.from(JSON.stringify({
            rememberDevice: false,
            actionType: contMetadata.actionType || "Generic",
            verificationToken: verificationToken,
            challengeId: contMetadata.challengeId
        })).toString("base64");
        
        // Add challenge headers to session temporarily
        const finalSession = {
            ...session,
            challengeHeaders: {
                'rblx-challenge-id': contData.challengeId,
                'rblx-challenge-type': 'twostepverification',
                'rblx-challenge-metadata': finalMetadata
            }
        };
        
        const finalRes = await makeApiRequest(
            cookie,
            "https://users.roblox.com/v1/birthdate",
            "POST",
            {
                birthMonth: parseInt(birthMonth),
                birthDay: parseInt(birthDay),
                birthYear: parseInt(birthYear)
            },
            finalSession,
            logs
        );

        if (finalRes.status !== 200) {
            logs.push(`❌ Step 6 failed: ${finalRes.status} - ${finalRes.body}`);
            return res.status(500).json({ success: false, error: "Final failed", logs });
        }

        logs.push("✅ Step 6: Birthdate changed successfully!");
        logs.push("🎉 ALL DONE!");

        res.json({
            success: true,
            message: "Birthdate changed!",
            newBirthdate: { month: birthMonth, day: birthDay, year: birthYear },
            logs
        });

    } catch (error) {
        console.error("Error:", error);
        logs.push(`❌ Error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message, logs });
    }
});

app.get("/api/health", async (req, res) => {
    res.json({ 
        status: "ok", 
        puppeteer: true,
        browserReady: browser !== null
    });
});

// Cleanup
process.on('SIGINT', async () => {
    if (browser) await browser.close();
    process.exit(0);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Optimized Puppeteer Server on port ${PORT}`);
    console.log(`🔑 Auto-generates x-bound-auth-token via Roblox JS`);
});
