// birthdate-server.js - Node.js Backend for Roblox Birthdate Changer
// Install dependencies: npm install express cors
// Run: node birthdate-server.js

const express = require("express");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public")); // Serve index.html from public folder

// Generate consistent fingerprint values that persist across the session
function generateFingerprint() {
    // Generate a consistent 16-character hex string for machine ID
    return Array.from({length: 16}, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// Store fingerprints per request session
const sessionFingerprints = new Map();

// Get or create fingerprint for a request
function getFingerprint(cookie) {
    if (!sessionFingerprints.has(cookie)) {
        sessionFingerprints.set(cookie, {
            machineId: generateFingerprint(),
            secChUa: '"Not A(Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            secChUaPlatform: '"Windows"',
            secChUaMobile: "?0",
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        });
    }
    return sessionFingerprints.get(cookie);
}

// Build headers with consistent fingerprint
function buildHeaders(cookie, csrfToken = null, machineId = null, fingerprint = null) {
    const fp = fingerprint || getFingerprint(cookie);
    
    const headers = {
        "Content-Type": "application/json",
        "User-Agent": fp.userAgent,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Origin": "https://www.roblox.com",
        "Referer": "https://www.roblox.com/",
        "sec-ch-ua": fp.secChUa,
        "sec-ch-ua-mobile": fp.secChUaMobile,
        "sec-ch-ua-platform": fp.secChUaPlatform,
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

    // Add CSRF token if provided
    if (csrfToken) {
        headers["x-csrf-token"] = csrfToken;
    }

    // Add machine ID if provided (from previous response)
    if (machineId) {
        headers["roblox-machine-id"] = machineId;
    }

    return headers;
}

// All requests go direct with consistent fingerprinting
async function robloxRequest(url, options = {}, cookie = null, machineId = null) {
    console.log(`[Roblox Request] ${options.method || "GET"} ${url}`);
    
    // Build consistent headers
    const headers = buildHeaders(cookie, options.headers?.["x-csrf-token"], machineId);
    
    // Merge with any additional headers from options
    const finalHeaders = {
        ...headers,
        ...options.headers,
    };

    // Remove undefined values
    Object.keys(finalHeaders).forEach(key => {
        if (finalHeaders[key] === undefined || finalHeaders[key] === null) {
            delete finalHeaders[key];
        }
    });

    console.log(`[Request Headers] ${JSON.stringify(finalHeaders, null, 2)}`);

    const response = await fetch(url, {
        ...options,
        headers: finalHeaders,
    });

    // Capture response headers including roblox-machine-id
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
    });
    
    console.log(`[Response Headers] ${JSON.stringify(responseHeaders, null, 2)}`);
    
    // Return both response and headers
    return {
        response,
        headers: responseHeaders,
        machineId: responseHeaders["roblox-machine-id"] || machineId
    };
}

// Delay helper - random delay between min and max ms to mimic human behavior
function delay(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Main endpoint to handle birthdate change
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
        const roblosecurity = cookie.startsWith(".ROBLOSECURITY=")
            ? cookie
            : `.ROBLOSECURITY=${cookie}`;

        // Get or create fingerprint for this session
        const fingerprint = getFingerprint(cookie);
        logs.push(`🔐 Session fingerprint initialized`);
        logs.push(`   Machine ID: ${fingerprint.machineId}`);
        logs.push(`   Sec-CH-UA: ${fingerprint.secChUa}`);

        let currentMachineId = fingerprint.machineId;

        // STEP 1: Get CSRF Token
        logs.push("🔄 Step 1: Getting CSRF token...");

        const csrfResult = await robloxRequest(
            "https://users.roblox.com/v1/description",
            {
                method: "POST",
                headers: {
                    "x-csrf-token": "fetch" // Some endpoints accept this to force token return
                }
            },
            cookie,
            currentMachineId
        );

        const csrfToken = csrfResult.response.headers.get("x-csrf-token");
        
        // Update machine ID from response if provided
        if (csrfResult.machineId) {
            currentMachineId = csrfResult.machineId;
            logs.push(`   Received Machine ID: ${currentMachineId}`);
        }

        if (!csrfToken) {
            return res.status(403).json({
                success: false,
                error: "Failed to get CSRF token. Make sure your cookie is valid.",
                logs,
            });
        }

        logs.push("✅ Step 1: CSRF token obtained");

        // Human-like delay between steps
        await delay(1000, 2000);

        // STEP 2: Trigger Challenge
        logs.push("🔄 Step 2: Sending birthdate change request...");

        const changeResult = await robloxRequest(
            "https://users.roblox.com/v1/birthdate",
            {
                method: "POST",
                headers: {
                    "x-csrf-token": csrfToken,
                },
                body: JSON.stringify({
                    birthMonth: parseInt(birthMonth),
                    birthDay: parseInt(birthDay),
                    birthYear: parseInt(birthYear),
                    password: password,
                }),
            },
            cookie,
            currentMachineId
        );

        const changeRequest = changeResult.response;

        // Update machine ID from response if provided
        if (changeResult.machineId) {
            currentMachineId = changeResult.machineId;
        }

        if (changeRequest.status === 200) {
            logs.push("✅ Step 2: Birthdate changed without challenge!");
            return res.json({
                success: true,
                message: "Birthdate changed successfully!",
                newBirthdate: {
                    month: birthMonth,
                    day: birthDay,
                    year: birthYear,
                },
                logs,
            });
        }

        if (changeRequest.status !== 403) {
            const errorText = await changeRequest.text();
            console.error(
                `[Error] Change request failed with status ${changeRequest.status}: ${errorText}`,
            );
            return res.status(500).json({
                success: false,
                error: `Unexpected response from Roblox: ${changeRequest.status}`,
                logs,
            });
        }

        const challengeId = changeRequest.headers.get("rblx-challenge-id");
        const challengeType = changeRequest.headers.get("rblx-challenge-type");
        const challengeMetadata = changeRequest.headers.get("rblx-challenge-metadata");

        const step2Headers = {};
        changeRequest.headers.forEach((value, key) => { step2Headers[key] = value; });
        console.log(`[Step 2 Response Headers] ${JSON.stringify(step2Headers)}`);
        logs.push(`   Step 2 Response Headers: ${JSON.stringify(step2Headers)}`);

        if (!challengeId || !challengeType || !challengeMetadata) {
            const errorText = await changeRequest.text();
            console.error(
                `[Error] Challenge headers missing. Status: ${changeRequest.status}, Body: ${errorText}`,
            );
            return res.status(500).json({
                success: false,
                error: "Challenge headers not found. Roblox might have blocked the request or changed the API.",
                logs,
            });
        }

        logs.push("✅ Step 2: Challenge triggered");
        logs.push(`   Challenge ID: ${challengeId}`);
        logs.push(`   Challenge Type: ${challengeType}`);

        await delay(1500, 2500);

        // STEP 3: Continue Challenge (First)
        logs.push("🔄 Step 3: Continuing challenge...");

        const continueResult1 = await robloxRequest(
            "https://apis.roblox.com/challenge/v1/continue",
            {
                method: "POST",
                headers: {
                    "x-csrf-token": csrfToken,
                },
                body: JSON.stringify({
                    challengeId,
                    challengeType,
                    challengeMetadata,
                }),
            },
            cookie,
            currentMachineId
        );

        const continueChallenge1 = continueResult1.response;

        // Update machine ID from response if provided
        if (continueResult1.machineId) {
            currentMachineId = continueResult1.machineId;
        }

        if (continueChallenge1.status !== 200) {
            const errorText = await continueChallenge1.text();
            console.error(
                `[Error] Step 3 failed: ${continueChallenge1.status} - ${errorText}`,
            );
            return res.status(500).json({
                success: false,
                error: `Challenge continue failed: ${continueChallenge1.status}`,
                details: errorText,
                logs,
            });
        }

        const challenge1Data = await continueChallenge1.json();

        logs.push("✅ Step 3: Challenge continued");
        logs.push(`   New Challenge ID: ${challenge1Data.challengeId}`);
        logs.push(`   New Challenge Type: ${challenge1Data.challengeType}`);

        // Parse metadata to get userId and inner challengeId
        const metadata = JSON.parse(challenge1Data.challengeMetadata);
        const userId = metadata.userId;
        const innerChallengeId = metadata.challengeId;

        logs.push(`   User ID: ${userId}`);
        logs.push(`   Inner Challenge ID: ${innerChallengeId}`);
        console.log(`[Step 3 Parsed Metadata] ${JSON.stringify(metadata)}`);
        logs.push(`   Full Metadata: ${JSON.stringify(metadata)}`);

        await delay(2000, 3500);

        // STEP 4: Verify Password
        logs.push("🔄 Step 4: Verifying password...");

        const step4Body = JSON.stringify({
            challengeId: innerChallengeId,
            actionType: 7,
            code: password,
        });
        console.log(`[Step 4 Request Body] ${step4Body}`);
        logs.push(`   Step 4 Request Body: ${step4Body}`);

        const verifyResult = await robloxRequest(
            `https://twostepverification.roblox.com/v1/users/${userId}/challenges/password/verify`,
            {
                method: "POST",
                headers: {
                    "x-csrf-token": csrfToken,
                },
                body: step4Body,
            },
            cookie,
            currentMachineId
        );

        const verifyPassword = verifyResult.response;

        // Update machine ID from response if provided
        if (verifyResult.machineId) {
            currentMachineId = verifyResult.machineId;
        }

        const step4ResponseText = await verifyPassword.text();
        const step4Headers = {};
        verifyPassword.headers.forEach((value, key) => { step4Headers[key] = value; });
        console.log(`[Step 4 Response Status] ${verifyPassword.status}`);
        console.log(`[Step 4 Response Body] ${step4ResponseText}`);
        console.log(`[Step 4 Response Headers] ${JSON.stringify(step4Headers)}`);
        logs.push(`   Step 4 Status: ${verifyPassword.status}`);
        logs.push(`   Step 4 Response: ${step4ResponseText}`);
        logs.push(`   Step 4 Headers: ${JSON.stringify(step4Headers)}`);

        if (verifyPassword.status !== 200) {
            const errorData = JSON.parse(step4ResponseText);
            console.error(
                `[Error] Step 4 failed: ${verifyPassword.status} - ${step4ResponseText}`,
            );
            return res.status(500).json({
                success: false,
                error: `Password verification failed: ${errorData.errors?.[0]?.message || verifyPassword.status}`,
                logs,
            });
        }

        const verifyData = JSON.parse(step4ResponseText);
        const verificationToken = verifyData.verificationToken;

        if (!verificationToken) {
            return res.status(500).json({
                success: false,
                error: "No verification token received",
                logs,
            });
        }

        logs.push("✅ Step 4: Password verified");
        logs.push(
            `   Verification Token: ${verificationToken.substring(0, 20)}...`,
        );

        await delay(1500, 2500);

        // STEP 5. Complete Challenge with Verification Token
        logs.push("🔄 Step 5: Completing challenge with verification token...");

        // Only send the 4 fields Roblox expects - not the full step 3 metadata
        const step5Metadata = {
            rememberDevice: false,
            actionType: metadata.actionType || "Generic",
            verificationToken: verificationToken,
            challengeId: innerChallengeId,
        };

        logs.push(`   Step 5 Metadata: ${JSON.stringify(step5Metadata)}`);

        const finalResult = await robloxRequest(
            "https://apis.roblox.com/challenge/v1/continue",
            {
                method: "POST",
                headers: {
                    "x-csrf-token": csrfToken,
                },
                body: JSON.stringify({
                    challengeId: challenge1Data.challengeId,
                    challengeType: "twostepverification",
                    challengeMetadata: JSON.stringify(step5Metadata),
                }),
            },
            cookie,
            currentMachineId
        );

        const finalChallenge = finalResult.response;

        // Update machine ID from response if provided
        if (finalResult.machineId) {
            currentMachineId = finalResult.machineId;
        }

        if (finalChallenge.status !== 200) {
            const errorText = await finalChallenge.text();
            console.error(
                `[Error] Step 5 failed: ${finalChallenge.status} - ${errorText}`,
            );
            return res.status(500).json({
                success: false,
                error: `Final challenge failed: ${finalChallenge.status}`,
                details: errorText,
                logs,
            });
        }

        const finalChallengeData = await finalChallenge.json();
        const finalChallengeHeaders = {};
        finalChallenge.headers.forEach((value, key) => {
            finalChallengeHeaders[key] = value;
        });
        console.log(`[Step 5 Response Body] ${JSON.stringify(finalChallengeData)}`);
        console.log(`[Step 5 Response Headers] ${JSON.stringify(finalChallengeHeaders)}`);
        logs.push(`   Step 5 Response Body: ${JSON.stringify(finalChallengeData)}`);
        logs.push(`   Step 5 Response Headers: ${JSON.stringify(finalChallengeHeaders)}`);

        logs.push("✅ Step 5: Challenge completed successfully!");

        await delay(2000, 3000);

        // STEP 6: Retry birthdate request
        logs.push("🔄 Step 6: Retrying birthdate change after verification...");

        // Build base64 encoded challenge metadata as per Roblox's expected format
        const step6ChallengeMetadata = Buffer.from(JSON.stringify({
            rememberDevice: false,
            actionType: "Generic",
            verificationToken: verificationToken,
            challengeId: innerChallengeId,
        })).toString("base64");

        logs.push(`   Step 6 Challenge Metadata (base64): ${step6ChallengeMetadata}`);

        // Build headers with all challenge headers AND consistent fingerprint
        const step6Headers = buildHeaders(cookie, csrfToken, currentMachineId);
        step6Headers["rblx-challenge-id"] = challenge1Data.challengeId;
        step6Headers["rblx-challenge-type"] = "twostepverification";
        step6Headers["rblx-challenge-metadata"] = step6ChallengeMetadata;

        const retryResult = await robloxRequest(
            "https://users.roblox.com/v1/birthdate",
            {
                method: "PATCH",
                headers: step6Headers,
                body: JSON.stringify({
                    birthMonth: parseInt(birthMonth),
                    birthDay: parseInt(birthDay),
                    birthYear: parseInt(birthYear),
                    password: password,
                }),
            },
            cookie,
            currentMachineId
        );

        const retryBirthdate = retryResult.response;

        if (retryBirthdate.status !== 200) {
            const errorText = await retryBirthdate.text();
            const step6Headers = {};
            retryBirthdate.headers.forEach((value, key) => { step6Headers[key] = value; });
            console.error(`[Error] Step 6 failed: ${retryBirthdate.status} - ${errorText}`);
            console.log(`[Step 6 Response Headers] ${JSON.stringify(step6Headers)}`);
            logs.push("❌ Step 6 failed");
            logs.push(`   Status: ${retryBirthdate.status}`);
            logs.push(`   Response: ${errorText}`);
            logs.push(`   Headers: ${JSON.stringify(step6Headers)}`);
            return res.status(500).json({
                success: false,
                error: "Birthdate change failed after verification",
                details: errorText,
                logs,
            });
        }

        logs.push("✅ Step 6: Birthdate changed successfully!");
        logs.push("🎉 All steps completed successfully!");

        // Success!
        res.json({
            success: true,
            message: "Birthdate changed successfully!",
            newBirthdate: {
                month: birthMonth,
                day: birthDay,
                year: birthYear,
            },
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

// Health check endpoint
app.get("/api/health", (req, res) => {
    res.json({ status: "ok", message: "Server is running" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
    console.log(`📁 Place index.html in a 'public' folder`);
});
