// birthdate-server.js - Complete with hardcoded x-bound-auth-token

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

// HARDCODED x-bound-auth-token from browser capture
const HARDCODED_BOUND_TOKEN = "v1|47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=|1772880618|wrVInwAxtniDfS9ag/iIQtRKirBv+wBGAisLMxMtZmrijnaZj70RbdNmw8c3xlrXYKl7Gvp7LUeB6gYrBIjJew==|Ksxn4gTVPEUoY16x+yvAhUCe0W5nK5mp7ETH8gSzxHOl3kOhQRCDnsTc3wo9+TiSCXtKGXNJPCSLJRpaqcziwA==";

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
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json;charset=utf-8",
        "User-Agent": session.fp.ua,
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
        // ADD HARDCODED x-bound-auth-token to ALL requests
        "x-bound-auth-token": HARDCODED_BOUND_TOKEN,
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
        logs.push(`🔑 Using hardcoded x-bound-auth-token`);

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

        // Step 2: Trigger birthdate change
        logs.push("🔄 Step 2: Trigger birthdate change...");
        const changeRes = await curlRequest({ 
            url: "https://users.roblox.com/v1/birthdate",
            method: "POST", 
            headers: buildHeaders(session), 
            body: { 
                birthMonth: parseInt(birthMonth), 
                birthDay: parseInt(birthDay), 
                birthYear: parseInt(birthYear)
            }, 
            cookie 
        });
        
        if (changeRes.status === 200) {
            logs.push("✅ Step 2: Success without challenge!");
            return res.json({ 
                success: true, 
                message: "Birthdate changed!", 
                newBirthdate: { month: birthMonth, day: birthDay, year: birthYear }, 
                logs 
            });
        }

        session.machineId = changeRes.headers["roblox-machine-id"];
        if (session.machineId) logs.push(`✅ Machine ID: ${session.machineId}`);

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

        let initialMetadata;
        try {
            const decodedMetadata = Buffer.from(challengeMetadata, 'base64').toString('utf8');
            initialMetadata = JSON.parse(decodedMetadata);
            logs.push(`   Decoded metadata: ${JSON.stringify(initialMetadata)}`);
        } catch (e) {
            logs.push(`⚠️ Failed to decode metadata: ${e.message}`);
            initialMetadata = {};
        }

        await delay(1500, 2500);

        // Step 3: Continue challenge
        logs.push("🔄 Step 3: Continue challenge...");
        
        const contRes = await curlRequest({ 
            url: "https://apis.roblox.com/challenge/v1/continue", 
            method: "POST", 
            headers: buildHeaders(session), 
            body: { 
                challengeID: challengeId,
                challengeMetadata: JSON.stringify({
                    userId: initialMetadata.userId,
                    challengeId: challengeId,
                    browserTrackerId: initialMetadata.browserTrackerId || "1772875017937003"
                }),
                challengeType: challengeType
            }, 
            cookie 
        });
        
        if (contRes.status !== 200) {
            logs.push(`❌ Step 3 failed: ${contRes.status} - ${JSON.stringify(contRes.data)}`);
            return res.status(500).json({ success: false, error: "Continue failed", logs });
        }

        logs.push(`✅ Step 3: Challenge continued`);
        logs.push(`   New Challenge Type: ${contRes.data.challengeType}`);

        const continueMetadata = JSON.parse(contRes.data.challengeMetadata);
        const userId = continueMetadata.userId;
        const innerChallengeId = continueMetadata.challengeId;
        const actionType = continueMetadata.actionType || "Generic";

        logs.push(`   User ID: ${userId}`);
        logs.push(`   Inner Challenge ID: ${innerChallengeId}`);
        logs.push(`   Action Type: ${actionType}`);

        await delay(2000, 3500);

        // Step 4: Verify password
        logs.push("🔄 Step 4: Verify password...");
        const verifyRes = await curlRequest({ 
            url: `https://twostepverification.roblox.com/v1/users/${userId}/challenges/password/verify`, 
            method: "POST", 
            headers: buildHeaders(session), 
            body: { 
                challengeId: innerChallengeId, 
                actionType: actionType,
                code: password
            }, 
            cookie 
        });
        
        logs.push(`   Response: ${JSON.stringify(verifyRes.data)}`);

        if (verifyRes.status !== 200) {
            logs.push(`❌ Step 4 failed: ${verifyRes.status}`);
            return res.status(500).json({ success: false, error: "Verify failed", logs });
        }

        const verificationToken = verifyRes.data.verificationToken;
        if (!verificationToken) {
            logs.push("❌ No verification token");
            return res.status(500).json({ success: false, error: "No verification token", logs });
        }
        logs.push("✅ Step 4: Verified");

        await delay(1500, 2500);

        // Step 5: Complete challenge
        logs.push("🔄 Step 5: Complete challenge...");
        const completeRes = await curlRequest({ 
            url: "https://apis.roblox.com/challenge/v1/continue", 
            method: "POST", 
            headers: buildHeaders(session), 
            body: { 
                challengeId: contRes.data.challengeId, 
                challengeType: "twostepverification", 
                challengeMetadata: JSON.stringify({ 
                    rememberDevice: false, 
                    actionType: actionType, 
                    verificationToken: verificationToken, 
                    challengeId: innerChallengeId 
                }) 
            }, 
            cookie 
        });

        if (completeRes.status !== 200 || completeRes.data?.challengeType === "blocksession") {
            logs.push(`❌ Step 5 blocked/failed: ${JSON.stringify(completeRes.data)}`);
            return res.status(500).json({ success: false, error: "Challenge blocked", logs });
        }
        logs.push("✅ Step 5: Completed");

        await delay(2000, 3000);

        // Step 6: Final birthdate change
        logs.push("🔄 Step 6: Final birthdate change...");
        
        const finalMetadata = Buffer.from(JSON.stringify({
            rememberDevice: false,
            actionType: actionType,
            verificationToken: verificationToken,
            challengeId: innerChallengeId
        })).toString("base64");
        
        const finalRes = await curlRequest({ 
            url: "https://users.roblox.com/v1/birthdate",
            method: "POST", 
            headers: buildHeaders(session, { 
                "rblx-challenge-id": contRes.data.challengeId, 
                "rblx-challenge-type": "twostepverification",
                "rblx-challenge-metadata": finalMetadata 
            }), 
            body: { 
                birthMonth: parseInt(birthMonth), 
                birthDay: parseInt(birthDay), 
                birthYear: parseInt(birthYear)
            }, 
            cookie 
        });

        if (finalRes.status !== 200) {
            logs.push(`❌ Step 6 failed: ${finalRes.status} - ${JSON.stringify(finalRes.data)}`);
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
        console.log(`🔑 Hardcoded x-bound-auth-token: ${HARDCODED_BOUND_TOKEN.substring(0, 30)}...`);
    });
}

start();
