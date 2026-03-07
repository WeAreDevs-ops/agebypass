// birthdate-server.js - Node.js Backend for Roblox Birthdate Changer
// With automatic curl-impersonate download for Railway deployment

const express = require("express");
const cors = require("cors");
const { spawn, exec } = require("child_process");
const fs = require("fs");
const https = require("https");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Store session data
const sessions = new Map();

// curl-impersonate path
const CURL_IMPERSONATE_PATH = "/tmp/curl_chrome120";

// Download file from URL with redirect following
function downloadFile(url, dest, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) {
            reject(new Error("Too many redirects"));
            return;
        }

        const file = fs.createWriteStream(dest);
        
        const request = https.get(url, { 
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        }, (response) => {
            // Handle redirects (301, 302, 307, 308)
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                file.close();
                fs.unlink(dest, () => {});
                console.log(`Following redirect (${response.statusCode}) to: ${response.headers.location.substring(0, 100)}...`);
                
                // Handle relative URLs
                let redirectUrl = response.headers.location;
                if (redirectUrl.startsWith('/')) {
                    const urlObj = new URL(url);
                    redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
                }
                
                downloadFile(redirectUrl, dest, redirectCount + 1)
                    .then(resolve)
                    .catch(reject);
                return;
            }
            
            if (response.statusCode !== 200) {
                file.close();
                fs.unlink(dest, () => {});
                reject(new Error(`Download failed: ${response.statusCode}`));
                return;
            }
            
            response.pipe(file);
            file.on("finish", () => {
                file.close();
                resolve();
            });
        });

        request.on("error", (err) => {
            file.close();
            fs.unlink(dest, () => {});
            reject(err);
        });
        
        request.setTimeout(60000, () => {
            request.destroy();
            file.close();
            fs.unlink(dest, () => {});
            reject(new Error("Download timeout"));
        });
    });
}

// Setup curl-impersonate
async function setupCurlImpersonate() {
    if (fs.existsSync(CURL_IMPERSONATE_PATH)) {
        console.log(`✅ curl-impersonate already exists at ${CURL_IMPERSONATE_PATH}`);
        return true;
    }

    console.log("⬇️ Downloading curl-impersonate for Linux x64...");
    
    try {
        const downloadUrl = "https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz";
        const tarPath = "/tmp/curl-impersonate.tar.gz";
        
        console.log(`   From: ${downloadUrl}`);
        
        await downloadFile(downloadUrl, tarPath);
        console.log("📦 Downloaded successfully");
        
        // Extract
        await new Promise((resolve, reject) => {
            exec(`cd /tmp && tar -xzf curl-impersonate.tar.gz && chmod +x curl_chrome120 && rm -f curl-impersonate.tar.gz`, (error) => {
                if (error) reject(error);
                else resolve();
            });
        });
        
        if (fs.existsSync(CURL_IMPERSONATE_PATH)) {
            console.log("✅ curl-impersonate ready");
            return true;
        } else {
            throw new Error("Binary not found after extraction");
        }
        
    } catch (error) {
        console.error("❌ Failed to setup curl-impersonate:", error.message);
        console.log("⚠️ Will use system curl (may be detected by Roblox)");
        return false;
    }
}

// Get or create session
function getSession(cookie) {
    const sessionKey = cookie.substring(0, 50);
    if (!sessions.has(sessionKey)) {
        sessions.set(sessionKey, {
            machineId: null,
            csrfToken: null,
            fingerprint: {
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                secChUa: '"Not A(Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                secChUaMobile: "?0",
                secChUaPlatform: '"Windows"',
            }
        });
    }
    return sessions.get(sessionKey);
}

// Execute curl request
function curlRequest(options) {
    return new Promise((resolve, reject) => {
        const { url, method = "GET", headers = {}, body = null, cookie = null } = options;

        const curlPath = fs.existsSync(CURL_IMPERSONATE_PATH) 
            ? CURL_IMPERSONATE_PATH 
            : "curl";

        const args = [
            "--silent", "--show-error", "--location", "--http1.1",
            "--request", method, "--url", url,
        ];

        Object.entries(headers).forEach(([key, value]) => {
            if (value != null) args.push("--header", `${key}: ${value}`);
        });

        if (cookie) {
            const roblosecurity = cookie.startsWith(".ROBLOSECURITY=") ? cookie : `.ROBLOSECURITY=${cookie}`;
            args.push("--cookie", roblosecurity);
        }

        if (body) args.push("--data", JSON.stringify(body));
        args.push("--dump-header", "-", "--write-out", "\nHTTP_CODE:%{http_code}");

        const proc = spawn(curlPath, args, { env: process.env });
        let stdout = "", stderr = "";

        proc.stdout.on("data", (data) => { stdout += data.toString(); });
        proc.stderr.on("data", (data) => { stderr += data.toString(); });
        proc.on("error", (err) => reject(err));
        
        proc.on("close", (code) => {
            if (code !== 0) return reject(new Error(`curl failed: ${stderr}`));
            
            try {
                const parts = stdout.split("HTTP_CODE:");
                const headersAndBody = parts[0];
                const httpCode = parseInt(parts[1]?.trim() || "0");
                const headerEnd = headersAndBody.indexOf("\r\n\r\n");
                const headerSection = headersAndBody.substring(0, headerEnd);
                const body = headersAndBody.substring(headerEnd + 4);

                const responseHeaders = {};
                headerSection.split("\r\n").forEach(line => {
                    if (line.includes(":")) {
                        const [key, ...val] = line.split(":");
                        responseHeaders[key.toLowerCase().trim()] = val.join(":").trim();
                    }
                });

                resolve({ status: httpCode, headers: responseHeaders, body, data: body ? JSON.parse(body) : null });
            } catch (e) {
                reject(new Error(`Parse error: ${e.message}`));
            }
        });
    });
}

// Build headers
function buildHeaders(session, extra = {}) {
    const fp = session.fingerprint;
    const h = {
        "Content-Type": "application/json",
        "User-Agent": fp.userAgent,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Origin": "https://www.roblox.com",
        "Referer": "https://www.roblox.com/my/account#!/info",
        "sec-ch-ua": fp.secChUa,
        "sec-ch-ua-mobile": fp.secChUaMobile,
        "sec-ch-ua-platform": fp.secChUaPlatform,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    };
    if (session.csrfToken) h["x-csrf-token"] = session.csrfToken;
    if (session.machineId) h["roblox-machine-id"] = session.machineId;
    return Object.assign(h, extra);
}

function delay(min, max) {
    return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));
}

// Main endpoint
app.post("/api/change-birthdate", async (req, res) => {
    try {
        const { cookie, password, birthMonth, birthDay, birthYear } = req.body;
        if (!cookie || !password || !birthMonth || !birthDay || !birthYear) {
            return res.status(400).json({ success: false, error: "Missing fields" });
        }

        const logs = [], session = getSession(cookie);
        logs.push(`🔐 Session: ${fs.existsSync(CURL_IMPERSONATE_PATH) ? "curl-impersonate" : "system curl"}`);

        // Step 1: CSRF
        logs.push("🔄 Step 1: Getting CSRF...");
        const csrfRes = await curlRequest({ url: "https://users.roblox.com/v1/description", method: "POST", headers: buildHeaders(session), body: { description: "test" }, cookie });
        session.csrfToken = csrfRes.headers["x-csrf-token"];
        if (!session.csrfToken) return res.status(403).json({ success: false, error: "No CSRF", logs });
        logs.push("✅ Step 1: CSRF obtained");

        await delay(1000, 2000);

        // Step 2: Trigger
        logs.push("🔄 Step 2: Triggering challenge...");
        const changeRes = await curlRequest({ url: "https://users.roblox.com/v1/birthdate", method: "POST", headers: buildHeaders(session), body: { birthMonth: parseInt(birthMonth), birthDay: parseInt(birthDay), birthYear: parseInt(birthYear), password }, cookie });
        
        if (changeRes.status === 200) {
            logs.push("✅ Step 2: Success without challenge!");
            return res.json({ success: true, message: "Birthdate changed!", newBirthdate: { month: birthMonth, day: birthDay, year: birthYear }, logs });
        }

        session.machineId = changeRes.headers["roblox-machine-id"];
        if (session.machineId) logs.push(`✅ Machine ID: ${session.machineId}`);

        if (changeRes.status !== 403) {
            logs.push(`❌ Step 2 failed: ${changeRes.status}`);
            return res.status(500).json({ success: false, error: `Status ${changeRes.status}`, logs });
        }

        const challengeId = changeRes.headers["rblx-challenge-id"];
        const challengeType = changeRes.headers["rblx-challenge-type"];
        const challengeMetadata = changeRes.headers["rblx-challenge-metadata"];

        if (!challengeId || !challengeType || !challengeMetadata) {
            logs.push("❌ No challenge headers");
            return res.status(500).json({ success: false, error: "No challenge headers", logs });
        }

        logs.push(`✅ Step 2: Challenge ${challengeType}`);

        await delay(1500, 2500);

        // Step 3: Continue
        logs.push("🔄 Step 3: Continuing...");
        const contRes = await curlRequest({ url: "https://apis.roblox.com/challenge/v1/continue", method: "POST", headers: buildHeaders(session), body: { challengeId, challengeType, challengeMetadata }, cookie });
        if (contRes.status !== 200) {
            logs.push(`❌ Step 3 failed: ${contRes.status}`);
            return res.status(500).json({ success: false, error: "Continue failed", logs });
        }

        const contData = contRes.data;
        const metadata = JSON.parse(contData.challengeMetadata);
        logs.push("✅ Step 3: Continued");

        await delay(2000, 3500);

        // Step 4: Verify password
        logs.push("🔄 Step 4: Verifying password...");
        const verifyRes = await curlRequest({ 
            url: `https://twostepverification.roblox.com/v1/users/${metadata.userId}/challenges/password/verify`, 
            method: "POST", 
            headers: buildHeaders(session), 
            body: { challengeId: metadata.challengeId, actionType: 7, code: password }, 
            cookie 
        });

        if (verifyRes.status !== 200) {
            logs.push(`❌ Step 4 failed: ${verifyRes.status}`);
            return res.status(500).json({ success: false, error: "Password verify failed", logs });
        }

        const verificationToken = verifyRes.data.verificationToken;
        logs.push("✅ Step 4: Verified");

        await delay(1500, 2500);

        // Step 5: Complete
        logs.push("🔄 Step 5: Completing...");
        const completeRes = await curlRequest({ 
            url: "https://apis.roblox.com/challenge/v1/continue", 
            method: "POST", 
            headers: buildHeaders(session), 
            body: { 
                challengeId: contData.challengeId, 
                challengeType: "twostepverification", 
                challengeMetadata: JSON.stringify({ rememberDevice: false, actionType: metadata.actionType || "Generic", verificationToken, challengeId: metadata.challengeId }) 
            }, 
            cookie 
        });

        if (completeRes.status !== 200 || completeRes.data?.challengeType === "blocksession") {
            logs.push(`❌ Step 5 failed/blocked`);
            return res.status(500).json({ success: false, error: "Challenge blocked", logs });
        }
        logs.push("✅ Step 5: Completed");

        await delay(2000, 3000);

        // Step 6: Final
        logs.push("🔄 Step 6: Final request...");
        const finalMetadata = Buffer.from(JSON.stringify({ rememberDevice: false, actionType: "Generic", verificationToken, challengeId: metadata.challengeId })).toString("base64");
        
        const finalRes = await curlRequest({ 
            url: "https://users.roblox.com/v1/birthdate", 
            method: "POST", 
            headers: buildHeaders(session, { "rblx-challenge-id": contData.challengeId, "rblx-challenge-type": "twostepverification", "rblx-challenge-metadata": finalMetadata }), 
            body: { birthMonth: parseInt(birthMonth), birthDay: parseInt(birthDay), birthYear: parseInt(birthYear), password }, 
            cookie 
        });

        if (finalRes.status !== 200) {
            logs.push(`❌ Step 6 failed: ${finalRes.status}`);
            return res.status(500).json({ success: false, error: "Final failed", logs });
        }

        logs.push("✅ Step 6: Success!");
        logs.push("🎉 ALL COMPLETE!");

        res.json({ success: true, message: "Birthdate changed!", newBirthdate: { month: birthMonth, day: birthDay, year: birthYear }, logs });

    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ success: false, error: error.message, logs: [error.stack] });
    }
});

app.get("/api/health", (req, res) => {
    res.json({ status: "ok", curlImpersonate: fs.existsSync(CURL_IMPERSONATE_PATH) });
});

// Start
async function start() {
    await setupCurlImpersonate();
    const PORT = process.env.PORT || 8080;
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`🔒 Using: ${fs.existsSync(CURL_IMPERSONATE_PATH) ? "curl-impersonate ✅" : "system curl ⚠️"}`);
    });
}

start();
