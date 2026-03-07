// birthdate-server.js - Node.js Backend for Roblox Birthdate Changer
// Using curl-impersonate to bypass TLS fingerprinting (JA3 detection)
// Install dependencies: npm install express cors cuimp

const express = require("express");
const cors = require("cors");
const { request: cuimpRequest, createCuimpHttp } = require("cuimp");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Store session data including machine ID and fingerprint
const sessions = new Map();

// Create a cuimp HTTP client that impersonates Chrome
// This is CRITICAL - it gives us Chrome's JA3 TLS fingerprint
function createChromeClient(cookie, machineId = null, csrfToken = null) {
    const client = createCuimpHttp({
        descriptor: { browser: "chrome", version: "120" }, // Match your User-Agent version
    });

    // Set default headers that will be consistent across all requests
    client.defaults.headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Origin": "https://www.roblox.com",
        "Referer": "https://www.roblox.com/my/account#!/info", // Correct referer for settings page
        "sec-ch-ua": '"Not A(Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    };

    // Add cookie
    const roblosecurity = cookie.startsWith(".ROBLOSECURITY=")
        ? cookie
        : `.ROBLOSECURITY=${cookie}`;
    client.defaults.headers["Cookie"] = roblosecurity;

    // Add machine ID if available
    if (machineId) {
        client.defaults.headers["roblox-machine-id"] = machineId;
    }

    // Add CSRF token if available
    if (csrfToken) {
        client.defaults.headers["x-csrf-token"] = csrfToken;
    }

    return client;
}

// Get or create session
function getSession(cookie) {
    const sessionKey = cookie.substring(0, 50);
    if (!sessions.has(sessionKey)) {
        sessions.set(sessionKey, {
            machineId: null,
            csrfToken: null,
            client: null, // Will store cuimp client
        });
    }
    return sessions.get(sessionKey);
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
        logs.push(`   Using curl-impersonate (Chrome 120) for TLS fingerprinting`);

        // STEP 1: Get CSRF Token
        logs.push("🔄 Step 1: Getting CSRF token...");
        
        // Create client for initial request (no machine ID yet)
        let client = createChromeClient(cookie);
        
        const csrfResponse = await client.post("https://users.roblox.com/v1/description", {
            description: "test",
        });

        // Capture CSRF token from response headers
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

        // Update client with CSRF token
        client = createChromeClient(cookie, null, csrfToken);
        session.client = client;

        const changeResponse = await client.post("https://users.roblox.com/v1/birthdate", {
            birthMonth: parseInt(birthMonth),
            birthDay: parseInt(birthDay),
            birthYear: parseInt(birthYear),
            password: password,
        });

        // Capture machine ID from response headers
        const machineId = changeResponse.headers["roblox-machine-id"];
        if (machineId) {
            session.machineId = machineId;
            logs.push(`✅ Machine ID LOCKED: ${machineId}`);
        } else {
            logs.push("⚠️ Warning: No machine ID in Step 2 response");
        }

        // Check status
        if (changeResponse.status === 200) {
            logs.push("✅ Step 2: Birthdate changed without challenge!");
            return res.json({
                success: true,
                message: "Birthdate changed successfully!",
                newBirthdate: { month: birthMonth, day: birthDay, year: birthYear },
                logs,
            });
        }

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

        // STEP 3: Continue Challenge (USE SAME MACHINE ID!)
        logs.push("🔄 Step 3: Continuing challenge...");

        // Create new client with machine ID and CSRF token
        client = createChromeClient(cookie, session.machineId, session.csrfToken);
        
        const continueResponse = await client.post("https://apis.roblox.com/challenge/v1/continue", {
            challengeId,
            challengeType,
            challengeMetadata,
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

        // STEP 4: Verify Password (USE SAME MACHINE ID!)
        logs.push("🔄 Step 4: Verifying password...");

        const verifyBody = {
            challengeId: innerChallengeId,
            actionType: 7,
            code: password,
        };
        logs.push(`   Request Body: ${JSON.stringify(verifyBody)}`);

        // Use same client (has machine ID and CSRF)
        const verifyResponse = await client.post(
            `https://twostepverification.roblox.com/v1/users/${userId}/challenges/password/verify`,
            verifyBody
        );

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

        // STEP 5: Complete Challenge (USE SAME MACHINE ID!)
        logs.push("🔄 Step 5: Completing challenge...");

        const step5Metadata = {
            rememberDevice: false,
            actionType: metadata.actionType || "Generic",
            verificationToken: verificationToken,
            challengeId: innerChallengeId,
        };
        logs.push(`   Metadata: ${JSON.stringify(step5Metadata)}`);

        const completeResponse = await client.post("https://apis.roblox.com/challenge/v1/continue", {
            challengeId: continueData.challengeId,
            challengeType: "twostepverification",
            challengeMetadata: JSON.stringify(step5Metadata),
        });

        logs.push(`   Response: ${JSON.stringify(completeResponse.data)}`);

        if (completeResponse.status !== 200) {
            logs.push(`❌ Step 5 failed: ${completeResponse.status}`);
            if (completeResponse.data?.challengeType === "blocksession" || 
                JSON.stringify(completeResponse.data).includes("AutomatedTampering")) {
                logs.push("🚫 SESSION BLOCKED - Possible TLS fingerprint or header mismatch");
            }
            return res.status(500).json({
                success: false,
                error: `Challenge completion failed: ${completeResponse.status}`,
                logs,
            });
        }

        // Check for blocksession even with 200 status
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

        // Add challenge headers to the client
        client.defaults.headers["rblx-challenge-id"] = continueData.challengeId;
        client.defaults.headers["rblx-challenge-type"] = "twostepverification";
        client.defaults.headers["rblx-challenge-metadata"] = finalMetadataBase64;

        const finalResponse = await client.post("https://users.roblox.com/v1/birthdate", {
            birthMonth: parseInt(birthMonth),
            birthDay: parseInt(birthDay),
            birthYear: parseInt(birthYear),
            password: password,
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
    res.json({ status: "ok", message: "Server running" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
    console.log(`📁 Using curl-impersonate for Chrome 120 TLS fingerprint`);
});
