// diagnose-railway.js - Diagnostic script for Railway deployment

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

async function diagnose() {
    console.log("=== Railway Deployment Diagnostics ===\n");
    
    // Check environment
    console.log("Environment:");
    console.log("  NODE_ENV:", process.env.NODE_ENV);
    console.log("  PUPPETEER_CACHE_DIR:", process.env.PUPPETEER_CACHE_DIR);
    console.log("  PUPPETEER_EXECUTABLE_PATH:", process.env.PUPPETEER_EXECUTABLE_PATH);
    console.log("  HOME:", process.env.HOME);
    console.log("");
    
    // Try to find Chrome
    const fs = require('fs');
    const path = require('path');
    const { execSync } = require('child_process');
    
    console.log("Searching for Chrome...");
    
    const searchPaths = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        '/app/.cache/puppeteer',
        '/root/.cache/puppeteer',
        '/home/user/.cache/puppeteer',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
    ];
    
    for (const p of searchPaths) {
        if (!p) continue;
        console.log(`  Checking: ${p}`);
        
        if (p.includes('*')) {
            const base = p.split('*')[0];
            if (fs.existsSync(base)) {
                console.log(`    Base exists: ${base}`);
                try {
                    const files = fs.readdirSync(base);
                    console.log(`    Contents: ${files.join(', ')}`);
                } catch (e) {}
            }
        } else if (fs.existsSync(p)) {
            const stat = fs.statSync(p);
            console.log(`    EXISTS (${stat.isDirectory() ? 'dir' : 'file'})`);
            
            if (stat.isDirectory()) {
                try {
                    const files = fs.readdirSync(p);
                    console.log(`    Contents: ${files.slice(0, 10).join(', ')}${files.length > 10 ? '...' : ''}`);
                } catch (e) {}
            }
        }
    }
    
    // Try which command
    console.log("\nTrying 'which' command:");
    const bins = ['google-chrome', 'chromium', 'chromium-browser', 'chrome'];
    for (const bin of bins) {
        try {
            const result = execSync(`which ${bin} 2>/dev/null`, { encoding: 'utf8' }).trim();
            console.log(`  ${bin}: ${result}`);
        } catch (e) {
            console.log(`  ${bin}: not found`);
        }
    }
    
    // Try launching browser
    console.log("\nTrying to launch browser...");
    
    try {
        const launchOptions = {
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote'
            ]
        };
        
        // Try with explicit path first
        const cacheDir = process.env.PUPPETEER_CACHE_DIR || '/app/.cache/puppeteer';
        if (fs.existsSync(cacheDir)) {
            try {
                const versions = fs.readdirSync(cacheDir);
                for (const v of versions) {
                    const chromePath = path.join(cacheDir, v, 'chrome-linux', 'chrome');
                    if (fs.existsSync(chromePath)) {
                        console.log(`  Found Chrome at: ${chromePath}`);
                        launchOptions.executablePath = chromePath;
                        break;
                    }
                }
            } catch (e) {}
        }
        
        console.log("  Launch options:", JSON.stringify(launchOptions, null, 2));
        
        const browser = await puppeteer.launch(launchOptions);
        console.log("  ✅ Browser launched successfully!");
        
        const version = await browser.version();
        console.log(`  Version: ${version}`);
        
        // Test navigation
        console.log("\nTesting navigation...");
        const page = await browser.newPage();
        
        await page.goto('https://www.roblox.com/', { 
            waitUntil: 'domcontentloaded',
            timeout: 20000
        });
        
        const url = page.url();
        const title = await page.title();
        console.log(`  ✅ Navigated to: ${url}`);
        console.log(`  Title: ${title}`);
        
        await browser.close();
        console.log("\n✅ All diagnostics passed!");
        
    } catch (error) {
        console.log("  ❌ Browser launch failed:");
        console.log(`     ${error.message}`);
        console.log("\n🔧 Possible fixes:");
        console.log("  1. Ensure nixpacks.toml is properly configured");
        console.log("  2. Check that postinstall script ran successfully");
        console.log("  3. Try redeploying with 'npx puppeteer browsers install chrome'");
    }
}

diagnose().catch(console.error);
