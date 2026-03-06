// birthdate-server.js
// Install: npm install express cors
// Run: node birthdate-server.js

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/*
Better browser‑like headers
*/
const BROWSER_HEADERS = {
    "Content-Type": "application/json",

    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",

    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",

    "Origin": "https://www.roblox.com",
    "Referer": "https://www.roblox.com/my/account#!/info",

    "Cache-Control": "no-cache",
    "Pragma": "no-cache",

    "sec-ch-ua": '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-platform-version": '"15.0.0"',
    "sec-ch-ua-arch": '"x86"',
    "sec-ch-ua-bitness": '"64"',
    "sec-ch-ua-model": '""',

    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",

    "Connection": "keep-alive",
    "priority": "u=1, i",
};

/*
Request wrapper
*/
async function robloxRequest(url, options = {}) {
    console.log(`[Roblox Request] ${options.method || "GET"} ${url}`);

    const response = await fetch(url, {
        ...options,
        headers: {
            ...BROWSER_HEADERS,
            ...options.headers,
        },
        redirect: "follow",
    });

    return response;
}

/*
Human delay
*/
function delay(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
MAIN ENDPOINT
*/
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

        /*
        STEP 1
        GET CSRF
        */

        logs.push("🔄 Step 1: Getting CSRF token...");

        const csrf1 = await robloxRequest(
            "https://users.roblox.com/v1/description",
            {
                method: "POST",
                headers: {
                    Cookie: roblosecurity,
                },
            }
        );

        const csrfToken = csrf1.headers.get("x-csrf-token");

        if (!csrfToken) {
            return res.status(403).json({
                success: false,
                error: "Failed to get CSRF token",
                logs,
            });
        }

        logs.push("✅ CSRF token obtained");

        await delay(1000, 2000);

        /*
        STEP 2
        TRIGGER BIRTHDATE CHANGE
        */

        logs.push("🔄 Step 2: Sending birthdate change request...");

        const changeRequest = await robloxRequest(
            "https://users.roblox.com/v1/birthdate",
            {
                method: "POST",
                headers: {
                    Cookie: roblosecurity,
                    "x-csrf-token": csrfToken,
                },
                body: JSON.stringify({
                    birthMonth: parseInt(birthMonth),
                    birthDay: parseInt(birthDay),
                    birthYear: parseInt(birthYear),
                    password: password,
                }),
            }
        );

        if (changeRequest.status === 200) {
            logs.push("✅ Birthdate changed without challenge");

            return res.json({
                success: true,
                logs,
            });
        }

        if (changeRequest.status !== 403) {
            return res.status(500).json({
                success: false,
                error: "Unexpected Roblox response",
                logs,
            });
        }

        const challengeId = changeRequest.headers.get("rblx-challenge-id");
        const challengeType = changeRequest.headers.get("rblx-challenge-type");
        const challengeMetadata =
            changeRequest.headers.get("rblx-challenge-metadata");

        logs.push("✅ Challenge triggered");

        await delay(1500, 2500);

        /*
        STEP 3
        CONTINUE CHALLENGE
        */

        logs.push("🔄 Step 3: Continuing challenge...");

        const continueChallenge = await robloxRequest(
            "https://apis.roblox.com/challenge/v1/continue",
            {
                method: "POST",
                headers: {
                    Cookie: roblosecurity,
                    "x-csrf-token": csrfToken,
                },
                body: JSON.stringify({
                    challengeId,
                    challengeType,
                    challengeMetadata,
                }),
            }
        );

        const challengeData = await continueChallenge.json();

        const metadata = JSON.parse(challengeData.challengeMetadata);

        const userId = metadata.userId;
        const innerChallengeId = metadata.challengeId;

        await delay(2000, 3500);

        /*
        STEP 4
        VERIFY PASSWORD
        */

        logs.push("🔄 Step 4: Verifying password...");

        const verifyPassword = await robloxRequest(
            `https://twostepverification.roblox.com/v1/users/${userId}/challenges/password/verify`,
            {
                method: "POST",
                headers: {
                    Cookie: roblosecurity,
                    "x-csrf-token": csrfToken,
                },
                body: JSON.stringify({
                    challengeId: innerChallengeId,
                    actionType: 7,
                    code: password,
                }),
            }
        );

        const verifyData = await verifyPassword.json();

        const verificationToken = verifyData.verificationToken;

        logs.push("✅ Password verified");

        await delay(1500, 2500);

        /*
        STEP 5
        COMPLETE CHALLENGE
        */

        logs.push("🔄 Step 5: Completing challenge...");

        const step5Metadata = {
            rememberDevice: false,
            actionType: metadata.actionType || "Generic",
            verificationToken,
            challengeId: innerChallengeId,
        };

        await robloxRequest("https://apis.roblox.com/challenge/v1/continue", {
            method: "POST",
            headers: {
                Cookie: roblosecurity,
                "x-csrf-token": csrfToken,
            },
            body: JSON.stringify({
                challengeId: challengeData.challengeId,
                challengeType: "twostepverification",
                challengeMetadata: JSON.stringify(step5Metadata),
            }),
        });

        await delay(2000, 3000);

        /*
        STEP 6
        RETRY BIRTHDATE CHANGE
        */

        logs.push("🔄 Step 6: Retrying birthdate change...");

        const step6Metadata = Buffer.from(
            JSON.stringify({
                rememberDevice: false,
                actionType: "Generic",
                verificationToken,
                challengeId: innerChallengeId,
            })
        ).toString("base64");

        const retryBirthdate = await robloxRequest(
            "https://users.roblox.com/v1/birthdate",
            {
                method: "PATCH",
                headers: {
                    Cookie: roblosecurity,
                    "x-csrf-token": csrfToken,
                    "rblx-challenge-id": challengeData.challengeId,
                    "rblx-challenge-type": "twostepverification",
                    "rblx-challenge-metadata": step6Metadata,
                },
                body: JSON.stringify({
                    birthMonth: parseInt(birthMonth),
                    birthDay: parseInt(birthDay),
                    birthYear: parseInt(birthYear),
                    password: password,
                }),
            }
        );

        if (retryBirthdate.status !== 200) {
            const text = await retryBirthdate.text();

            return res.status(500).json({
                success: false,
                error: text,
                logs,
            });
        }

        logs.push("🎉 Birthdate changed successfully");

        res.json({
            success: true,
            logs,
        });
    } catch (err) {
        console.error(err);

        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

/*
HEALTH CHECK
*/

app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
