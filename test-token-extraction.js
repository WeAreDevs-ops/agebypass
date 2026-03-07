// test-token-extraction.js - Test script to verify token extraction works

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

async function testTokenExtraction(cookie) {
    console.log("🧪 Testing token extraction...\n");
    
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled'
        ]
    });
    
    const page = await browser.newPage();
    
    // Store captured tokens
    const capturedTokens = {
        csrfToken: null,
        boundAuthToken: null,
        machineId: null
    };
    
    // Enable request interception
    await page.setRequestInterception(true);
    
    page.on('request', (request) => {
        const headers = request.headers();
        if (headers['x-bound-auth-token']) {
            capturedTokens.boundAuthToken = headers['x-bound-auth-token'];
            console.log("🔑 CAPTURED x-bound-auth-token from request!");
            console.log(`   Value: ${headers['x-bound-auth-token'].substring(0, 50)}...`);
        }
        if (headers['x-csrf-token']) {
            capturedTokens.csrfToken = headers['x-csrf-token'];
            console.log("🔑 CAPTURED x-csrf-token from request!");
        }
        request.continue();
    });
    
    page.on('response', (response) => {
        const headers = response.headers();
        if (headers['x-csrf-token']) {
            capturedTokens.csrfToken = headers['x-csrf-token'];
            console.log("🔑 CAPTURED x-csrf-token from response!");
        }
        if (headers['roblox-machine-id']) {
            capturedTokens.machineId = headers['roblox-machine-id'];
            console.log("🔑 CAPTURED roblox-machine-id from response!");
        }
    });
    
    try {
        // Parse cookie
        const cookieValue = cookie.startsWith(".ROBLOSECURITY=") ? cookie.substring(15) : cookie;
        
        console.log("1️⃣ Navigating to Roblox...");
        await page.goto('https://www.roblox.com/', { waitUntil: 'networkidle2' });
        
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
        
        console.log("2️⃣ Cookie set, navigating to account page...");
        await page.goto('https://www.roblox.com/my/account#!/info', { 
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        // Wait for page to load
        await new Promise(r => setTimeout(r, 3000));
        
        console.log("3️⃣ Extracting tokens from page context...");
        
        // Try to extract from page context
        const pageTokens = await page.evaluate(() => {
            const result = { csrfToken: null, boundAuthToken: null };
            
            // Check window.Roblox
            if (window.Roblox) {
                result.csrfToken = window.Roblox.CsrfToken;
                result.boundAuthToken = window.Roblox.BoundAuthToken;
            }
            
            // Check meta tags
            const csrfMeta = document.querySelector('meta[name="csrf-token"]');
            if (csrfMeta) result.csrfToken = csrfMeta.content;
            
            // Check localStorage
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.toLowerCase().includes('bound')) {
                    result.boundAuthToken = localStorage.getItem(key);
                }
            }
            
            return result;
        });
        
        if (pageTokens.csrfToken) {
            console.log("✅ Found CSRF token in page context");
            capturedTokens.csrfToken = pageTokens.csrfToken;
        }
        if (pageTokens.boundAuthToken) {
            console.log("✅ Found bound auth token in page context");
            capturedTokens.boundAuthToken = pageTokens.boundAuthToken;
        }
        
        console.log("4️⃣ Triggering API call to capture headers...");
        
        // Trigger a fetch request to capture headers
        await page.evaluate(async () => {
            try {
                await fetch('https://users.roblox.com/v1/birthdate', {
                    method: 'GET',
                    credentials: 'include'
                });
            } catch (e) {}
        });
        
        await new Promise(r => setTimeout(r, 2000));
        
        console.log("\n📊 RESULTS:");
        console.log("===========");
        console.log(`CSRF Token: ${capturedTokens.csrfToken ? '✅ FOUND' : '❌ NOT FOUND'}`);
        if (capturedTokens.csrfToken) {
            console.log(`   Value: ${capturedTokens.csrfToken.substring(0, 30)}...`);
        }
        
        console.log(`Bound Auth Token: ${capturedTokens.boundAuthToken ? '✅ FOUND' : '❌ NOT FOUND'}`);
        if (capturedTokens.boundAuthToken) {
            console.log(`   Value: ${capturedTokens.boundAuthToken.substring(0, 50)}...`);
        }
        
        console.log(`Machine ID: ${capturedTokens.machineId ? '✅ FOUND' : '❌ NOT FOUND'}`);
        if (capturedTokens.machineId) {
            console.log(`   Value: ${capturedTokens.machineId}`);
        }
        
        if (!capturedTokens.boundAuthToken) {
            console.log("\n⚠️  WARNING: Could not capture x-bound-auth-token!");
            console.log("   This token is essential for avoiding 'blocksession' errors.");
            console.log("   Try logging into Roblox manually and checking the Network tab");
            console.log("   for requests that include this header.");
        }
        
    } catch (error) {
        console.error("❌ Error:", error.message);
    } finally {
        await browser.close();
    }
}

// Get cookie from command line
const cookie = process.argv[2];

if (!cookie) {
    console.log("Usage: node test-token-extraction.js '<your .ROBLOSECURITY cookie>'");
    console.log("");
    console.log("Example:");
    console.log("  node test-token-extraction.js '_|WARNING:-DO-NOT-SHARE-THIS...'");
    process.exit(1);
}

testTokenExtraction(cookie);
