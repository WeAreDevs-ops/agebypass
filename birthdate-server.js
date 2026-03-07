// birthdate-server.js - Updated with reauthentication flow

const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const sessions = new Map();
const CURL_BINARY = path.join(__dirname, "bin", "curl-impersonate-chrome");

function checkBinary() {
    if (!fs.existsSync(CURL_BINARY)) {
        console.log("⚠️  curl-impersonate not found, using system curl");
        return false;
    }
    fs.chmodSync(CURL_BINARY, 0o755);
    console.log("✅ curl-impersonate ready");
    return true;
}

function getSession(cookie) {
    const key = cookie.substring(0, 50);
    if (!sessions.has(key)) {
        sessions.set(key, {
            machineId: null,
            csrfToken: null,
            reauthToken: null,  // NEW: Store reauth token
            fp: {
                ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                secChUa: '"Not A(Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            }
        });
    }
    return sessions.get(key);
}

function buildHeaders(session, extra = {}) {
    const h = {
        "Content-Type": "application/json",
        "User-Agent": session.fp.ua,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://www.roblox.com",
        "Referer": "https://www.roblox.com/my/account#!/info",
        "sec-ch-ua": session.fp.secChUa,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
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

function curlRequest(opts) {
    return new Promise((resolve, reject) => {
        const { url, method = "GET", headers = {}, body = null, cookie = null } = opts;
        
        const curlPath = fs.existsSync(CURL_BINARY) ? CURL_BINARY : "curl";
        
        const args = [
            "--silent", 
            "--show-error", 
            "--location", 
            "--http1.1",
            "--compressed",
            "--request", method, 
            "--url", url
        ];
        
        Object.entries(headers).forEach(([k, v]) => { 
            if (v != null) args.push("--header", `${k}: ${v}`); 
        });
        
        if (cookie) {
            const robloxCookie = cookie.startsWith(".ROBLOSECURITY=") ? cookie : `.ROBLOSECURITY=${cookie}`;
            args.push("--cookie", robloxCookie);
        }
        
        if (body) args.push("--data", JSON.stringify(body));
        
        args.push("--dump-header", "-", "--write-out", "\nHTTP_CODE:%{http_code}");
        
        const proc = spawn(curlPath, args, { env: process.env });
        let stdout = "", stderr = "";
        
        proc.stdout.on("data", d => stdout += d.toString());
        proc.stderr.on("data", d => stderr += d.toString());
        proc.on("error", reject);
        
        proc.on("close", code => {
            if (code !== 0) return reject(new Error(`curl failed: ${stderr}`));
            
            try {
                const parts = stdout.split("HTTP_CODE:");
                const headerBody = parts[0];
                const status = parseInt(parts[1]?.trim() || "0");
                
                let headerEnd = headerBody.indexOf("\r\n\r\n");
                if (headerEnd === -1) {
                    headerEnd = headerBody.indexOf("\n\n");
                }
                if (headerEnd === -1) {
                    throw new Error("Cannot find end of headers");
                }
                
                const headerSection = headerBody.substring(0, headerEnd);
                const body = headerBody.substring(headerEnd + 4);
                
                const responseHeaders = {};
                headerSection.split(/\r?\n/).forEach(line => {
                    if (line.includes(":")) {
                        const [k, ...v] = line.split(":");
                        responseHeaders[k.toLowerCase().trim()] = v.join(":").trim();
                    }
                });
                
                let data = null;
                if (body && body.trim()) {
                    try {
                        data = JSON.parse(body);
                    } catch (e) {
                        console.log("Body parse error, raw:", body.substring(0, 200));
                        throw e;
                    }
                }
                
                resolve({ status, headers: responseHeaders, body, data });
            } catch (e) {
                reject(new Error(`Parse error: ${e.message}`));
            }
        });
    });
}

function delay(min, max) {
    return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));
}

app.post("/api/change-birthdate", async (req, res) => {
    try {
        const { cookie, password, birthMonth, birthDay, birthYear } = req.body;
        if (!cookie || !password || !birthMonth || !birthDay || !birthYear) {
            return res.status(400).json({ success: false, error: "Missing fields" });
        }

        const logs = [];
        const session = getSession(cookie);
        
        logs.push(`🔐 Using: ${fs.existsSync(CURL_BINARY) ? "curl-impersonate" : "system curl"}`);

        // Step 1: CSRF
        logs.push("🔄 Step 1: CSRF...");
        const csrfRes = await curlRequest({ 
            url: "https://users.roblox.com/v1/description", 
            method: "POST", 
            headers: buildHeaders(session), 
            body: { description: "test" }, 
            cookie 
        });
        session.csrfToken = csrfRes.headers["x-csrf-token"];
        if (!session.csrfToken) return res.status(403).json({ success: false, error: "No CSRF", logs });
        logs.push("✅ Step 1: CSRF obtained");

        await delay(1000, 2000);

        // Step 2: Trigger birthdate change (returns 403 with challenge)
        logs.push("🔄 Step 2: Trigger birthdate change...");
        const changeRes = await curlRequest({ 
            url: "https://users.roblox.com/v1/birthdate",
            method: "POST", 
            headers: buildHeaders(session), 
            body: { 
                birthMonth: parseInt(birthMonth), 
                birthDay: parseInt(birthDay), 
                birthYear: parseInt(birthYear), 
                password 
            }, 
            cookie 
        });
        
        // If 200, success without challenge
        if (changeRes.status === 200) {
            logs.push("✅ Step 2: Success without challenge!");
            return res.json({ 
                success: true, 
                message: "Birthdate changed!", 
                newBirthdate: { month: birthMonth, day: birthDay, year: birthYear }, 
                logs 
            });
        }

        // Capture machine ID from response
        session.machineId = changeRes.headers["roblox-machine-id"];
        if (session.machineId) logs.push(`✅ Machine ID: ${session.machineId}`);

        // Check if we got a challenge
        if (changeRes.status !== 403) {
            logs.push(`❌ Step 2 failed: ${changeRes.status} - ${JSON.stringify(changeRes.data)}`);
            return res.status(500).json({ 
                success: false, 
                error: `Status ${changeRes.status}`, 
                logs 
            });
        }

        const challengeId = changeRes.headers["rblx-challenge-id"];
        const challengeType = changeRes.headers["rblx-challenge-type"];
        const challengeMetadata = changeRes.headers["rblx-challenge-metadata"];

        if (!challengeId || !challengeType || !challengeMetadata) {
            logs.push("❌ No challenge headers");
            return res.status(500).json({ success: false, error: "No challenge", logs });
        }

        logs.push(`✅ Step 2: Challenge triggered`);
        logs.push(`   Challenge ID: ${challengeId}`);
        logs.push(`   Challenge Type: ${challengeType}`);

        await delay(1500, 2500);

        // NEW STEP 3: Generate reauthentication token
        logs.push("🔄 Step 3: Generate reauthentication token...");
        const reauthRes = await curlRequest({ 
            url: "https://apis.roblox.com/reauthentication-service/v1/token/generate",  // NEW API
            method: "POST", 
            headers: buildHeaders(session), 
            body: { password: password }, 
            cookie 
        });
        
        if (reauthRes.status !== 200) {
            logs.push(`❌ Step 3 failed: ${reauthRes.status} - ${JSON.stringify(reauthRes.data)}`);
            return res.status(500).json({ 
                success: false, 
                error: "Reauthentication failed", 
                logs 
            });
        }
        
        session.reauthToken = reauthRes.data.token;
        logs.push(`✅ Step 3: Reauth token obtained`);
        logs.push(`   Token: ${session.reauthToken.substring(0, 20)}...`);

        await delay(1000, 2000);

        // Step 4: Continue challenge with reauthentication token
        logs.push("🔄 Step 4: Continue challenge with reauth token...");
        const contRes = await curlRequest({ 
            url: "https://apis.roblox.com/challenge/v1/continue", 
            method: "POST", 
            headers: buildHeaders(session), 
            body: { 
                challengeId: challengeId, 
                challengeType: "reauthentication",  // CHANGED from "twostepverification"
                challengeMetadata: JSON.stringify({
                    reauthenticationToken: session.reauthToken  // NEW: Use reauth token
                })
            }, 
            cookie 
        });
        
        if (contRes.status !== 200) {
            logs.push(`❌ Step 4 failed: ${contRes.status} - ${JSON.stringify(contRes.data)}`);
            return res.status(500).json({ success: false, error: "Continue failed", logs });
        }

        logs.push(`✅ Step 4: Challenge continued`);

        await delay(2000, 3500);

        // Step 5: Final birthdate change with challenge headers
        logs.push("🔄 Step 5: Final birthdate change...");
        
        // Build challenge metadata for final request
        const finalMetadata = Buffer.from(JSON.stringify({
            reauthenticationToken: session.reauthToken
        })).toString("base64");
        
        const finalRes = await curlRequest({ 
            url: "https://users.roblox.com/v1/birthdate",
            method: "POST", 
            headers: buildHeaders(session, { 
                "rblx-challenge-id": challengeId, 
                "rblx-challenge-type": "reauthentication",  // CHANGED
                "rblx-challenge-metadata": finalMetadata 
            }), 
            body: { 
                birthMonth: parseInt(birthMonth), 
                birthDay: parseInt(birthDay), 
                birthYear: parseInt(birthYear), 
                password 
            }, 
            cookie 
        });

        if (finalRes.status !== 200) {
            logs.push(`❌ Step 5 failed: ${finalRes.status} - ${JSON.stringify(finalRes.data)}`);
            return res.status(500).json({ success: false, error: "Final failed", logs });
        }

        logs.push("✅ Step 5: Birthdate changed successfully!");
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

app.get("/api/health", (req, res) => {
    res.json({ status: "ok", curlImpersonate: fs.existsSync(CURL_BINARY) });
});

function start() {
    const hasBinary = checkBinary();
    const PORT = process.env.PORT || 8080;
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 Server on port ${PORT}`);
        console.log(`🔒 curl-impersonate: ${hasBinary ? "✅" : "❌ (using system curl)"}`);
    });
}

start();
