// verify-token-generation.js - Verify that x-bound-auth-token is auto-generated

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

async function verifyTokenGeneration(cookie) {
    console.log("🔍 Verifying x-bound-auth-token auto-generation\n");
    console.log("How it works:");
    console.log("1. Puppeteer visits Roblox.com (loads their JS)");
    console.log("2. Roblox's JS generates x-bound-auth-token in memory");
    console.log("3. JS intercepts fetch/XHR and adds token to headers");
    console.log("4. We capture the token from outgoing requests\n");
    
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1920,1080',
        ]
    });
    
    const page = await browser.newPage();
    
    // Track all requests and their headers
    const requestLog = [];
    let tokenFound = false;
    
    // Method 1: Use CDP to intercept ALL requests (most reliable)
    const cdpSession = await page.target().createCDPSession();
    await cdpSession.send('Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }]
    });
    
    cdpSession.on('Fetch.requestPaused', async (params) => {
        const { requestId, request } = params;
        const headers = request.headers || {};
        
        // Log all requests to roblox.com
        if (request.url.includes('roblox.com')) {
            requestLog.push({
                url: request.url,
                hasBoundToken: !!headers['x-bound-auth-token'],
                hasCsrfToken: !!headers['x-csrf-token'],
                boundTokenPreview: headers['x-bound-auth-token'] ? 
                    headers['x-bound-auth-token'].substring(0, 50) + '...' : null
            });
            
            if (headers['x-bound-auth-token']) {
                tokenFound = true;
                console.log("✅ TOKEN FOUND in request to:", request.url.split('?')[0]);
                console.log("   Token preview:", headers['x-bound-auth-token'].substring(0, 60) + "...");
            }
        }
        
        await cdpSession.send('Fetch.continueRequest', { requestId });
    });
    
    try {
        const cookieValue = cookie.startsWith(".ROBLOSECURITY=") ? cookie.substring(15) : cookie;
        
        console.log("Step 1: Loading Roblox homepage...");
        await page.goto('https://www.roblox.com/', { waitUntil: 'networkidle2' });
        
        console.log("Step 2: Setting auth cookie...");
        await page.setCookie({
            name: '.ROBLOSECURITY',
            value: cookieValue,
            domain: '.roblox.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'Lax'
        });
        
        console.log("Step 3: Navigating to account page...");
        await page.goto('https://www.roblox.com/my/account#!/info', { 
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        console.log("Step 4: Waiting for JS to initialize (3s)...");
        await new Promise(r => setTimeout(r, 3000));
        
        console.log("Step 5: Triggering fetch request...");
        await page.evaluate(async () => {
            try {
                await fetch('https://users.roblox.com/v1/birthdate', {
                    method: 'GET',
                    credentials: 'include'
                });
            } catch (e) {}
        });
        
        await new Promise(r => setTimeout(r, 2000));
        
        // Summary
        console.log("\n" + "=".repeat(60));
        console.log("SUMMARY");
        console.log("=".repeat(60));
        
        if (tokenFound) {
            console.log("✅ SUCCESS! x-bound-auth-token is auto-generated!");
            console.log("   Roblox's JS successfully created and attached the token.");
        } else {
            console.log("❌ TOKEN NOT CAPTURED");
            console.log("   Possible reasons:");
            console.log("   - Cookie might be invalid/expired");
            console.log("   - Roblox changed their token generation logic");
            console.log("   - Token might be added differently");
            
            console.log("\n📋 All captured requests:");
            requestLog.forEach((req, i) => {
                console.log(`   ${i + 1}. ${req.url.split('/').pop()}`);
                console.log(`      Bound Token: ${req.hasBoundToken ? 'YES' : 'NO'}`);
                console.log(`      CSRF Token: ${req.hasCsrfToken ? 'YES' : 'NO'}`);
            });
        }
        
        console.log("\n💡 If token was found, the Puppeteer solution should work!");
        
    } catch (error) {
        console.error("❌ Error:", error.message);
    } finally {
        await cdpSession.detach();
        await browser.close();
    }
}

const cookie = process.argv[2];

if (!cookie) {
    console.log("Usage: node verify-token-generation.js '<your .ROBLOSECURITY cookie>'");
    process.exit(1);
}

verifyTokenGeneration(cookie);
