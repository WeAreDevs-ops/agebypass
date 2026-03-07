// birthdate-server.js - Node.js Backend for Roblox Birthdate Changer
// Using curl-impersonate via child_process for Chrome TLS fingerprint
// Install dependencies: npm install express cors

const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Store session data
const sessions = new Map();

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

// Execute curl-impersonate request
function curlRequest(options) {
    return new Promise((resolve, reject) => {
        const {
            url,
            method = "GET",
            headers = {},
            body = null,
            cookie = null,
        } = options;

        // Build curl-impersonate command
        const args = [
            "--silent",
            "--show-error",
            "--location",
            "--http1.1",
            "--request", method,
            "--url", url,
        ];

        // Add headers
        Object.entries(headers).forEach(([key, value]) => {
            if (value !== null && value !== undefined) {
                args.push("--header", `${key}: ${value}`);
            }
        });

        // Add cookie
        if (cookie) {
            const roblosecurity = cookie.startsWith(".ROBLOSECURITY=")
                ? cookie
                : `.ROBLOSECURITY=${cookie}`;
            args.push("--cookie", roblosecurity);
        }

        // Add body for POST/PATCH
        if (body) {
            args.push("--data", JSON.stringify(body));
        }

        // Include response headers in output
        args.push("--dump-header", "-");
        args.push("--write-out", "\nHTTP_CODE:%{http_code}");

        // Spawn curl-impersonate process
        const curlPath = process.env.CURL_IMPERSONATE || "curl_chrome120";
        const proc = spawn(curlPath, args, {
            env: { ...process.env },
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (data) => {
            stdout += data.toString();
        });

        proc.stderr.on("data", (data) => {
            stderr += data.toString();
        });

        proc.on("close", (code) => {
            if (code !== 0) {
                return reject(new Error(`curl exited with code ${code}: ${stderr}`));
            }

            // Parse response
            const parts = stdout.split("HTTP_CODE:");
            const headersAndBody = parts[0];
            const httpCode = parseInt(parts[1]?.trim() || "0");

            // Split headers and body
            const headerEnd = headersAndBody.indexOf("\r\n\r\n");
            const headerSection = headersAndBody.substring(0, headerEnd);
            const body = headersAndBody.substring(headerEnd + 4);

            // Parse headers
            const responseHeaders = {};
            headerSection.split("\r\n").forEach(line => {
                if (line.includes(":")) {
                    const [key, ...valueParts] = line.split(":");
                    responseHeaders[key.toLowerCase().trim()] = valueParts.join(":").trim();
                }
            });

            resolve({
                status: httpCode,
                headers: responseHeaders,
                body: body,
                data: body ? JSON.parse(body) : null,
            });
        });
    });
}

// Build headers with consistent fingerprint
function buildHeaders(session, extraHeaders = {}) {
    const fp = session.fingerprint;

    const headers = {
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

    // Add CSRF token if available
    if (session.csrfToken) {
        headers["x-csrf-token"] = session.csrfToken;
    }

    // Add machine ID if available
    if (session.machineId) {
        headers["roblox-machine-id"] = session.machineId;
    }

    // Merge extra headers
    Object.assign(headers, extraHeaders);

    return headers;
}

// Delay helper
function delay(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Main endpoint
app.post("/api/change-birthdate", async (req, res) => {
    try {
        const { cookie, password, birthMonth, birthDay, birthYear } = req.body;

        if (!cookie || !password || !birthMonth || !birthDay || !birthYear) {
            return res.status(400).json({
                success: false,
                error: "Missing required fields",
            });
        }

        const logs = [];
        const session = getSession(cookie);
        
        logs.push(`🔐 Session initialized`);
        logs.push(`   Using curl-impersonate (Chrome 120 TLS fingerprint)`);

        // STEP 1: Get CSRF Token
        logs.push("🔄 Step 1: Getting CSRF token...");
        
        const csrfResponse = await curlRequest({
            url: "https://users.roblox.com/v1/description",
            method: "POST",
            headers: buildHeaders(session),
            body: { description: "test" },
            cookie: cookie,
        });

        const csrfToken = csrfResponse.headers["x-csrf-token"];
        if (!csrfToken) {
            return res.status(403).json({
                success: false,
                error: "Failed to get CSRF token. Invalid cookie?",
                logs,
            });
        }

        session.csrfToken = csrfToken;
        logs.push("✅ Step 1: CSRF token obtained");

        await delay(1000, 2000);

        // STEP 2: Trigger Challenge (CAPTURE MACHINE ID HERE!)
        logs.push("🔄 Step 2: Sending birthdate change request...");

        const changeResponse = await curlRequest({
            url: "https://users.roblox.com/v1/birthdate",
            method: "POST",
            headers: buildHeaders(session),
            body: {
                birthMonth: parseInt(birthMonth),
                birthDay: parseInt(birthDay),
                birthYear: parseInt(birthYear),
                password: password,
            },
            cookie: cookie,
        });

        // Capture machine ID from response
        const machineId = changeResponse.headers["roblox-machine-id"];
        if (machineId) {
            session.machineId = machineId;
            logs.push(`✅ Machine ID LOCKED: ${machineId}`);
        } else {
            logs.push("⚠️ Warning: No machine ID in Step 2 response");
        }

        // Check if success (no challenge needed)
        if (changeResponse.status === 200) {
            logs.push("✅ Step 2: Birthdate changed without challenge!");
            return res.json({
                success: true,
                message: "Birthdate changed successfully!",
                newBirthdate: { month: birthMonth, day: birthDay, year: birthYear },
                logs,
            });
        }

        // If not 403, it's an error
        if (changeResponse.status !== 403) {
            logs.push(`❌ Step 2 failed: ${changeResponse.status} - ${JSON.stringify(changeResponse.data)}`);
            return res.status(500).json({
                success: false,
                error: `Unexpected response: ${changeResponse.status}`,
                logs,
            });
        }

        // Extract challenge headers
        const challengeId = changeResponse.headers["rblx-challenge-id"];
        const challengeType = changeResponse.headers["rblx-challenge-type"];
        const challengeMetadata = changeResponse.headers["rblx-challenge-metadata"];

        if (!challengeId || !challengeType || !challengeMetadata) {
            logs.push(`❌ Challenge headers missing`);
            return res.status(500).json({
                success: false,
                error: "Challenge headers not found",
                logs,
            });
        }

        logs.push("✅ Step 2: Challenge triggered");
        logs.push(`   Challenge ID: ${challengeId}`);
        logs.push(`   Challenge Type: ${challengeType}`);

        await delay(1500, 2500);

        // STEP 3: Continue Challenge
        logs.push("🔄 Step 3: Continuing challenge...");

        const continueResponse = await curlRequest({
            url: "https://apis.roblox.com/challenge/v1/continue",
            method: "POST",
            headers: buildHeaders(session),
            body: {
                challengeId,
                challengeType,
                challengeMetadata,
            },
            cookie: cookie,
        });

        if (continueResponse.status !== 200) {
            logs.push(`❌ Step 3 failed: ${continueResponse.status} - ${JSON.stringify(continueResponse.data)}`);
            return res.status(500).json({
                success: false,
                error: `Challenge continue failed: ${continueResponse.status}`,
                logs,
            });
        }

        const continueData = continueResponse.data;
        logs.push("✅ Step 3: Challenge continued");
        logs.push(`   New Challenge ID: ${continueData.challengeId}`);
        logs.push(`   New Challenge Type: ${continueData.challengeType}`);

        // Parse metadata
        const metadata = JSON.parse(continueData.challengeMetadata);
        const userId = metadata.userId;
        const innerChallengeId = metadata.challengeId;

        logs.push(`   User ID: ${userId}`);
        logs.push(`   Inner Challenge ID: ${innerChallengeId}`);

        await delay(2000, 3500);

        // STEP 4: Verify Password
        logs.push("🔄 Step 4: Verifying password...");

        const verifyBody = {
            challengeId: innerChallengeId,
            actionType: 7,
            code: password,
        };
        logs.push(`   Request Body: ${JSON.stringify(verifyBody)}`);

        const verifyResponse = await curlRequest({
            url: `https://twostepverification.roblox.com/v1/users/${userId}/challenges/password/verify`,
            method: "POST",
            headers: buildHeaders(session),
            body: verifyBody,
            cookie: cookie,
        });

        logs.push(`   Response: ${JSON.stringify(verifyResponse.data)}`);

        if (verifyResponse.status !== 200) {
            logs.push(`❌ Step 4 failed: ${verifyResponse.status}`);
            return res.status(500).json({
                success: false,
                error: `Password verification failed: ${verifyResponse.status}`,
                logs,
            });
        }

        const verificationToken = verifyResponse.data.verificationToken;
        if (!verificationToken) {
            logs.push("❌ No verification token received");
            return res.status(500).json({
                success: false,
                error: "No verification token",
                logs,
            });
        }

        logs.push("✅ Step 4: Password verified");
        logs.push(`   Token: ${verificationToken.substring(0, 20)}...`);

        await delay(1500, 2500);

        // STEP 5: Complete Challenge
        logs.push("🔄 Step 5: Completing challenge...");

        const step5Metadata = {
            rememberDevice: false,
            actionType: metadata.actionType || "Generic",
            verificationToken: verificationToken,
            challengeId: innerChallengeId,
        };
        logs.push(`   Metadata: ${JSON.stringify(step5Metadata)}`);

        const completeResponse = await curlRequest({
            url: "https://apis.roblox.com/challenge/v1/continue",
            method: "POST",
            headers: buildHeaders(session),
            body: {
                challengeId: continueData.challengeId,
                challengeType: "twostepverification",
                challengeMetadata: JSON.stringify(step5Metadata),
            },
            cookie: cookie,
        });

        logs.push(`   Response: ${JSON.stringify(completeResponse.data)}`);

        if (completeResponse.status !== 200) {
            logs.push(`❌ Step 5 failed: ${completeResponse.status}`);
            return res.status(500).json({
                success: false,
                error: `Challenge completion failed: ${completeResponse.status}`,
                logs,
            });
        }

        // Check for blocksession
        if (completeResponse.data?.challengeType === "blocksession" ||
            JSON.stringify(completeResponse.data).includes("Denied")) {
            logs.push("🚫 Step 5 returned blocksession!");
            return res.status(500).json({
                success: false,
                error: "Challenge blocked by Roblox",
                logs,
            });
        }

        logs.push("✅ Step 5: Challenge completed");

        await delay(2000, 3000);

        // STEP 6: Final Birthdate Change
        logs.push("🔄 Step 6: Final birthdate change...");

        const finalMetadata = {
            rememberDevice: false,
            actionType: "Generic",
            verificationToken: verificationToken,
            challengeId: innerChallengeId,
        };
        const finalMetadataBase64 = Buffer.from(JSON.stringify(finalMetadata)).toString("base64");
        
        logs.push(`   Challenge Metadata (base64): ${finalMetadataBase64}`);

        // Add challenge headers
        const finalHeaders = buildHeaders(session, {
            "rblx-challenge-id": continueData.challengeId,
            "rblx-challenge-type": "twostepverification",
            "rblx-challenge-metadata": finalMetadataBase64,
        });

        const finalResponse = await curlRequest({
            url: "https://users.roblox.com/v1/birthdate",
            method: "POST",
            headers: finalHeaders,
            body: {
                birthMonth: parseInt(birthMonth),
                birthDay: parseInt(birthDay),
                birthYear: parseInt(birthYear),
                password: password,
            },
            cookie: cookie,
        });

        logs.push(`   Response: ${JSON.stringify(finalResponse.data)}`);

        if (finalResponse.status !== 200) {
            logs.push(`❌ Step 6 failed: ${finalResponse.status}`);
            return res.status(500).json({
                success: false,
                error: `Final request failed: ${finalResponse.status}`,
                logs,
            });
        }

        logs.push("✅ Step 6: Birthdate changed successfully!");
        logs.push("🎉 ALL STEPS COMPLETED!");

        return res.json({
            success: true,
            message: "Birthdate changed successfully!",
            newBirthdate: { month: birthMonth, day: birthDay, year: birthYear },
            logs,
        });

    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({
            success: false,
            error: error.message,
            logs: [error.stack],
        });
    }
});

// Health check
app.get("/api/health", (req, res) => {
    res.json({ status: "ok", message: "Server running with curl-impersonate" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
    console.log(`🔒 Using curl-impersonate for Chrome 120 TLS fingerprint`);
    console.log(`📁 Place index.html in a 'public' folder`);
    console.log(`⚠️  Make sure curl_chrome120 is in your PATH`);
});
