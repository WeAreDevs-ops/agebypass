// birthdate-server.js - Node.js Backend for Roblox Birthdate Changer
// Install dependencies: npm install express cors
// Run: node birthdate-server.js

const express = require("express");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public")); // Serve index.html from public folder

// Store session data including machine ID and fingerprint
const sessions = new Map();

// Generate a consistent fingerprint for a session
function createFingerprint() {
    const chromeVersion = "120"; // Use a realistic Chrome version
    return {
        userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`,
        secChUa: `"Not A(Brand";v="8", "Chromium";v="${chromeVersion}", "Google Chrome";v="${chromeVersion}"`,
        secChUaMobile: "?0",
        secChUaPlatform: '"Windows"',
        secChUaFullVersion: `"${chromeVersion}.0.0.0"`,
        acceptLanguage: "en-US,en;q=0.9",
    };
}

// Get or create session
function getSession(cookie) {
    const sessionKey = cookie.substring(0, 50); // Use first 50 chars as key
    if (!sessions.has(sessionKey)) {
        sessions.set(sessionKey, {
            fingerprint: createFingerprint(),
            machineId: null, // Will be set from first response
            csrfToken: null,
        });
    }
    return sessions.get(sessionKey);
}

// Build headers with consistent fingerprint and machine ID
function buildHeaders(cookie, session, extraHeaders = {}) {
    const fp = session.fingerprint;
    
    const headers = {
        "Content-Type": "application/json",
        "User-Agent": fp.userAgent,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": fp.acceptLanguage,
        "Accept-Encoding": "gzip, deflate, br",
        "Origin": "https://www.roblox.com",
        // CORRECTED: Use the account settings page as Referer since birthdate change is in settings
        "Referer": "https://www.roblox.com/my/account#!/info",
        "sec-ch-ua": fp.secChUa,
        "sec-ch-ua-mobile": fp.secChUaMobile,
        "sec-ch-ua-platform": fp.secChUaPlatform,
        "sec-ch-ua-full-version": fp.secChUaFullVersion,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "Connection": "keep-alive",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    };

    // Add cookie
    const roblosecurity = cookie.startsWith(".ROBLOSECURITY=")
        ? cookie
        : `.ROBLOSECURITY=${cookie}`;
    headers["Cookie"] = roblosecurity;

    // Add CSRF token if available
    if (session.csrfToken) {
        headers["x-csrf-token"] = session.csrfToken;
    }

    // CRITICAL: Add machine ID if available (captured in Step 2, reused everywhere)
    if (session.machineId) {
        headers["roblox-machine-id"] = session.machineId;
    }

    // Merge extra headers (like challenge headers)
    Object.assign(headers, extraHeaders);

    return headers;
}

// Make request with automatic machine ID capture
async function robloxRequest(url, options, cookie, session) {
    console.log(`\n[Request] ${options.method || "GET"} ${url}`);
    
    const headers = buildHeaders(cookie, session, options.headers);
    console.log(`[Request Headers]`, JSON.stringify(headers, null, 2));
    
    const response = await fetch(url, {
        ...options,
        headers,
    });

    // Capture response headers
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
    });
    
    console.log(`[Response Status] ${response.status}`);
    console.log(`[Response Headers]`, JSON.stringify(responseHeaders, null, 2));
    
    // CRITICAL: Capture machine ID from response if present
    const newMachineId = responseHeaders["roblox-machine-id"];
    if (newMachineId) {
        console.log(`[Machine ID from Response] ${newMachineId}`);
        // IMPORTANT: Only set if not already set - we must use the first one received (Step 2)
        if (!session.machineId) {
            session.machineId = newMachineId;
            console.log(`[Session Machine ID LOCKED] ${newMachineId}`);
        } else if (session.machineId !== newMachineId) {
            // If Roblox sends a different one, log it but DON'T change it
            console.log(`[WARNING] Roblox sent different machine ID: ${newMachineId}`);
            console.log(`[MAINTAINING] Original machine ID: ${session.machineId}`);
        }
    }
    
    // Capture CSRF token if present
    const csrfToken = responseHeaders["x-csrf-token"];
    if (csrfToken && !session.csrfToken) {
        session.csrfToken = csrfToken;
        console.log(`[CSRF Token Captured]`);
    }

    return response;
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
        logs.push(`   Fingerprint UA: ${session.fingerprint.userAgent}`);
        logs.push(`   Referer: https://www.roblox.com/my/account#!/info`);

        // STEP 1: Get CSRF Token
        logs.push("🔄 Step 1: Getting CSRF token...");
        
        const csrfResponse = await robloxRequest(
            "https://users.roblox.com/v1/description",
            {
                method: "POST",
                headers: {},
                body: JSON.stringify({ description: "test" }),
            },
            cookie,
            session
        );

        if (!session.csrfToken) {
            return res.status(403).json({
                success: false,
                error: "Failed to get CSRF token. Invalid cookie?",
                logs,
            });
        }

        logs.push("✅ Step 1: CSRF token obtained");
        logs.push(`   Machine ID: ${session.machineId || "Not yet received"}`);

        await delay(1000, 2000);

        // STEP 2: Trigger Challenge (CAPTURE MACHINE ID HERE!)
        logs.push("🔄 Step 2: Sending birthdate change request...");

        const changeResponse = await robloxRequest(
            "https://users.roblox.com/v1/birthdate",
            {
                method: "POST",
                headers: {},
                body: JSON.stringify({
                    birthMonth: parseInt(birthMonth),
                    birthDay: parseInt(birthDay),
                    birthYear: parseInt(birthYear),
                    password: password,
                }),
            },
            cookie,
            session
        );

        // CRITICAL CHECK: Did we get the machine ID?
        if (!session.machineId) {
            logs.push("❌ CRITICAL: No machine ID received in Step 2!");
            logs.push("   This will cause 'AutomatedTampering' detection.");
            // Continue anyway to see the error
        } else {
            logs.push(`✅ Machine ID LOCKED: ${session.machineId}`);
        }

        // If 200, success without challenge
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
            const errorText = await changeResponse.text();
            logs.push(`❌ Step 2 failed: ${changeResponse.status} - ${errorText}`);
            return res.status(500).json({
                success: false,
                error: `Unexpected response: ${changeResponse.status}`,
                logs,
            });
        }

        // Extract challenge headers
        const challengeId = changeResponse.headers.get("rblx-challenge-id");
        const challengeType = changeResponse.headers.get("rblx-challenge-type");
        const challengeMetadata = changeResponse.headers.get("rblx-challenge-metadata");

        if (!challengeId || !challengeType || !challengeMetadata) {
            const errorText = await changeResponse.text();
            logs.push(`❌ Challenge headers missing: ${errorText}`);
            return res.status(500).json({
                success: false,
                error: "Challenge headers not found",
                logs,
            });
        }

        logs.push("✅ Step 2: Challenge triggered");
        logs.push(`   Challenge ID: ${challengeId}`);
        logs.push(`   Challenge Type: ${challengeType}`);
        logs.push(`   Using Machine ID: ${session.machineId}`);

        await delay(1500, 2500);

        // STEP 3: Continue Challenge (USE SAME MACHINE ID!)
        logs.push("🔄 Step 3: Continuing challenge...");

        const continueResponse = await robloxRequest(
            "https://apis.roblox.com/challenge/v1/continue",
            {
                method: "POST",
                headers: {},
                body: JSON.stringify({
                    challengeId,
                    challengeType,
                    challengeMetadata,
                }),
            },
            cookie,
            session
        );

        if (continueResponse.status !== 200) {
            const errorText = await continueResponse.text();
            logs.push(`❌ Step 3 failed: ${continueResponse.status} - ${errorText}`);
            return res.status(500).json({
                success: false,
                error: `Challenge continue failed: ${continueResponse.status}`,
                logs,
            });
        }

        const continueData = await continueResponse.json();
        logs.push("✅ Step 3: Challenge continued");
        logs.push(`   New Challenge ID: ${continueData.challengeId}`);
        logs.push(`   New Challenge Type: ${continueData.challengeType}`);

        // Parse metadata
        const metadata = JSON.parse(continueData.challengeMetadata);
        const userId = metadata.userId;
        const innerChallengeId = metadata.challengeId;

        logs.push(`   User ID: ${userId}`);
        logs.push(`   Inner Challenge ID: ${innerChallengeId}`);
        logs.push(`   Using Machine ID: ${session.machineId}`);

        await delay(2000, 3500);

        // STEP 4: Verify Password (USE SAME MACHINE ID!)
        logs.push("🔄 Step 4: Verifying password...");

        const verifyBody = {
            challengeId: innerChallengeId,
            actionType: 7, // Password verification
            code: password,
        };
        logs.push(`   Request Body: ${JSON.stringify(verifyBody)}`);

        const verifyResponse = await robloxRequest(
            `https://twostepverification.roblox.com/v1/users/${userId}/challenges/password/verify`,
            {
                method: "POST",
                headers: {},
                body: JSON.stringify(verifyBody),
            },
            cookie,
            session
        );

        const verifyText = await verifyResponse.text();
        logs.push(`   Response: ${verifyText}`);

        if (verifyResponse.status !== 200) {
            logs.push(`❌ Step 4 failed: ${verifyResponse.status}`);
            return res.status(500).json({
                success: false,
                error: `Password verification failed: ${verifyText}`,
                logs,
            });
        }

        const verifyData = JSON.parse(verifyText);
        const verificationToken = verifyData.verificationToken;

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
        logs.push(`   Using Machine ID: ${session.machineId}`);

        await delay(1500, 2500);

        // STEP 5: Complete Challenge (USE SAME MACHINE ID!)
        logs.push("🔄 Step 5: Completing challenge...");

        const step5Metadata = {
            rememberDevice: false,
            actionType: metadata.actionType || "Generic",
            verificationToken: verificationToken,
            challengeId: innerChallengeId,
        };
        logs.push(`   Metadata: ${JSON.stringify(step5Metadata)}`);

        const completeResponse = await robloxRequest(
            "https://apis.roblox.com/challenge/v1/continue",
            {
                method: "POST",
                headers: {},
                body: JSON.stringify({
                    challengeId: continueData.challengeId,
                    challengeType: "twostepverification",
                    challengeMetadata: JSON.stringify(step5Metadata),
                }),
            },
            cookie,
            session
        );

        const completeText = await completeResponse.text();
        logs.push(`   Response: ${completeText}`);

        if (completeResponse.status !== 200) {
            logs.push(`❌ Step 5 failed: ${completeResponse.status}`);
            // Check if we got blocked
            if (completeText.includes("blocksession") || completeText.includes("AutomatedTampering")) {
                logs.push("🚫 SESSION BLOCKED - Fingerprint mismatch detected!");
                logs.push("   Possible causes:");
                logs.push("   - Machine ID changed during flow");
                logs.push("   - Headers inconsistent between requests");
                logs.push("   - Referer/Origin mismatch");
            }
            return res.status(500).json({
                success: false,
                error: `Challenge completion failed: ${completeResponse.status}`,
                logs,
            });
        }

        // Check if we got a blocksession response even with 200 status
        if (completeText.includes("blocksession") || completeText.includes("Denied")) {
            logs.push("🚫 Step 5 returned blocksession!");
            logs.push(`   Response: ${completeText}`);
            return res.status(500).json({
                success: false,
                error: "Challenge blocked - fingerprint mismatch",
                logs,
            });
        }

        logs.push("✅ Step 5: Challenge completed");
        logs.push(`   Using Machine ID: ${session.machineId}`);

        await delay(2000, 3000);

        // STEP 6: Final Birthdate Change (USE SAME MACHINE ID!)
        logs.push("🔄 Step 6: Final birthdate change...");

        // Build challenge metadata for final request (base64 encoded)
        const finalMetadata = {
            rememberDevice: false,
            actionType: "Generic",
            verificationToken: verificationToken,
            challengeId: innerChallengeId,
        };
        const finalMetadataBase64 = Buffer.from(JSON.stringify(finalMetadata)).toString("base64");
        
        logs.push(`   Challenge Metadata (base64): ${finalMetadataBase64}`);
        logs.push(`   Using Machine ID: ${session.machineId}`);

        // Build headers with challenge info
        const finalHeaders = {
            "rblx-challenge-id": continueData.challengeId,
            "rblx-challenge-type": "twostepverification",
            "rblx-challenge-metadata": finalMetadataBase64,
        };

        // Try POST first (Step 2 used POST, so Step 6 should too)
        const finalResponse = await robloxRequest(
            "https://users.roblox.com/v1/birthdate",
            {
                method: "POST",
                headers: finalHeaders,
                body: JSON.stringify({
                    birthMonth: parseInt(birthMonth),
                    birthDay: parseInt(birthDay),
                    birthYear: parseInt(birthYear),
                    password: password,
                }),
            },
            cookie,
            session
        );

        const finalText = await finalResponse.text();
        logs.push(`   Response: ${finalText}`);

        if (finalResponse.status !== 200) {
            logs.push(`❌ Step 6 failed: ${finalResponse.status}`);
            
            // If 403 with challenge, maybe we need to retry with the new challenge
            if (finalResponse.status === 403 && finalText.includes("challenge")) {
                logs.push("   Received new challenge in Step 6 - may need additional verification");
            }
            
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
    res.json({ status: "ok", message: "Server running" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
    console.log(`📁 Place index.html in a 'public' folder`);
});
