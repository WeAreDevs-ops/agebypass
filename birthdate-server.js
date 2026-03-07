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
        "Accept-Encoding": "gzip, deflate, br",
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
        const args = ["--silent", "--show-error", "--location", "--http1.1", "--request", method, "--url", url];
        
        Object.entries(headers).forEach(([k, v]) => { if (v != null) args.push("--header", `${k}: ${v}`); });
        
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
                const headerEnd = headerBody.indexOf("\r\n\r\n");
                const headers = {};
                headerBody.substring(0, headerEnd).split("\r\n").forEach(line => {
                    if (line.includes(":")) {
                        const [k, ...v] = line.split(":");
                        headers[k.toLowerCase().trim()] = v.join(":").trim();
                    }
                });
                const body = headerBody.substring(headerEnd + 4);
                resolve({ status, headers, body, data: body ? JSON.parse(body) : null });
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
        const csrfRes = await curlRequest({ url: "https://users.roblox.com/v1/description", method: "POST", headers: buildHeaders(session), body: { description: "test" }, cookie });
        session.csrfToken = csrfRes.headers["x-csrf-token"];
        if (!session.csrfToken) return res.status(403).json({ success: false, error: "No CSRF", logs });
        logs.push("✅ Step 1: CSRF obtained");

        await delay(1000, 2000);

        // Step 2: Trigger
        logs.push("🔄 Step 2: Trigger...");
        const changeRes = await curlRequest({ url: "https://users.roblox.com/v1/birthdate", method: "POST", headers: buildHeaders(session), body: { birthMonth: parseInt(birthMonth), birthDay: parseInt(birthDay), birthYear: parseInt(birthYear), password }, cookie });
        
        if (changeRes.status === 200) {
            logs.push("✅ Step 2: Success!");
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
            return res.status(500).json({ success: false, error: "No challenge", logs });
        }

        logs.push(`✅ Step 2: Challenge ${challengeType}`);

        await delay(1500, 2500);

        // Step 3: Continue
        logs.push("🔄 Step 3: Continue...");
        const contRes = await curlRequest({ url: "https://apis.roblox.com/challenge/v1/continue", method: "POST", headers: buildHeaders(session), body: { challengeId, challengeType, challengeMetadata }, cookie });
        if (contRes.status !== 200) {
            logs.push(`❌ Step 3 failed: ${contRes.status}`);
            return res.status(500).json({ success: false, error: "Continue failed", logs });
        }

        const contData = contRes.data;
        const metadata = JSON.parse(contData.challengeMetadata);
        logs.push("✅ Step 3: Continued");

        await delay(2000, 3500);

        // Step 4: Verify
        logs.push("🔄 Step 4: Verify...");
        const verifyRes = await curlRequest({ url: `https://twostepverification.roblox.com/v1/users/${metadata.userId}/challenges/password/verify`, method: "POST", headers: buildHeaders(session), body: { challengeId: metadata.challengeId, actionType: 7, code: password }, cookie });
        
        if (verifyRes.status !== 200) {
            logs.push(`❌ Step 4 failed: ${verifyRes.status}`);
            return res.status(500).json({ success: false, error: "Verify failed", logs });
        }

        const verificationToken = verifyRes.data.verificationToken;
        logs.push("✅ Step 4: Verified");

        await delay(1500, 2500);

        // Step 5: Complete
        logs.push("🔄 Step 5: Complete...");
        const completeRes = await curlRequest({ url: "https://apis.roblox.com/challenge/v1/continue", method: "POST", headers: buildHeaders(session), body: { challengeId: contData.challengeId, challengeType: "twostepverification", challengeMetadata: JSON.stringify({ rememberDevice: false, actionType: metadata.actionType || "Generic", verificationToken, challengeId: metadata.challengeId }) }, cookie });

        if (completeRes.status !== 200 || completeRes.data?.challengeType === "blocksession") {
            logs.push(`❌ Step 5 blocked/failed`);
            return res.status(500).json({ success: false, error: "Challenge blocked", logs });
        }
        logs.push("✅ Step 5: Completed");

        await delay(2000, 3000);

        // Step 6: Final
        logs.push("🔄 Step 6: Final...");
        const finalMetadata = Buffer.from(JSON.stringify({ rememberDevice: false, actionType: "Generic", verificationToken, challengeId: metadata.challengeId })).toString("base64");
        
        const finalRes = await curlRequest({ url: "https://users.roblox.com/v1/birthdate", method: "POST", headers: buildHeaders(session, { "rblx-challenge-id": contData.challengeId, "rblx-challenge-type": "twostepverification", "rblx-challenge-metadata": finalMetadata }), body: { birthMonth: parseInt(birthMonth), birthDay: parseInt(birthDay), birthYear: parseInt(birthYear), password }, cookie });

        if (finalRes.status !== 200) {
            logs.push(`❌ Step 6 failed: ${finalRes.status}`);
            return res.status(500).json({ success: false, error: "Final failed", logs });
        }

        logs.push("✅ Step 6: Success!");
        logs.push("🎉 ALL DONE!");

        res.json({ success: true, message: "Birthdate changed!", newBirthdate: { month: birthMonth, day: birthDay, year: birthYear }, logs });

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
