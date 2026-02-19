// birthdate-server.js - Node.js Backend for Roblox Birthdate Changer
// Install dependencies: npm install express cors

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve HTML file from public folder

// Helper function to make requests to Roblox
async function robloxRequest(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            ...options.headers
        }
    });
    
    return response;
}

// Main endpoint to handle birthdate change
app.post('/api/change-birthdate', async (req, res) => {
    try {
        const { cookie, password, birthMonth, birthDay, birthYear } = req.body;
        
        if (!cookie || !password || !birthMonth || !birthDay || !birthYear) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields' 
            });
        }

        const logs = [];
        
        // STEP 1: Get CSRF Token
        logs.push('🔄 Step 1: Getting CSRF token...');
        
        const csrf1 = await robloxRequest('https://users.roblox.com/v1/birthdate', {
            method: 'POST',
            headers: {
                'Cookie': `.ROBLOSECURITY=${cookie}`
            },
            body: JSON.stringify({
                birthMonth: 1,
                birthDay: 1,
                birthYear: 2000,
                password: ''
            })
        });

        const csrfToken = csrf1.headers.get('x-csrf-token');
        
        if (!csrfToken) {
            return res.status(500).json({ 
                success: false, 
                error: 'Failed to get CSRF token',
                logs 
            });
        }
        
        logs.push('✅ Step 1: CSRF token obtained');

        // STEP 2: Trigger Challenge
        logs.push('🔄 Step 2: Sending birthdate change request...');
        
        const changeRequest = await robloxRequest('https://users.roblox.com/v1/birthdate', {
            method: 'POST',
            headers: {
                'Cookie': `.ROBLOSECURITY=${cookie}`,
                'x-csrf-token': csrfToken
            },
            body: JSON.stringify({
                birthMonth: parseInt(birthMonth),
                birthDay: parseInt(birthDay),
                birthYear: parseInt(birthYear),
                password: password
            })
        });

        if (changeRequest.status !== 403) {
            return res.status(500).json({ 
                success: false, 
                error: `Unexpected response: ${changeRequest.status}`,
                logs 
            });
        }

        const challengeId = changeRequest.headers.get('rblx-challenge-id');
        const challengeType = changeRequest.headers.get('rblx-challenge-type');
        const challengeMetadata = changeRequest.headers.get('rblx-challenge-metadata');

        if (!challengeId || !challengeType || !challengeMetadata) {
            return res.status(500).json({ 
                success: false, 
                error: 'Challenge headers not found',
                logs 
            });
        }

        logs.push('✅ Step 2: Challenge triggered');
        logs.push(`   Challenge ID: ${challengeId}`);
        logs.push(`   Challenge Type: ${challengeType}`);

        // STEP 3: Continue Challenge (First)
        logs.push('🔄 Step 3: Continuing challenge...');
        
        const continueChallenge1 = await robloxRequest('https://apis.roblox.com/challenge/v1/continue', {
            method: 'POST',
            body: JSON.stringify({
                challengeId,
                challengeType,
                challengeMetadata
            })
        });

        if (continueChallenge1.status !== 200) {
            const errorText = await continueChallenge1.text();
            return res.status(500).json({ 
                success: false, 
                error: `Challenge continue failed: ${continueChallenge1.status}`,
                details: errorText,
                logs 
            });
        }

        const challenge1Data = await continueChallenge1.json();
        
        logs.push('✅ Step 3: Challenge continued');
        logs.push(`   New Challenge ID: ${challenge1Data.challengeId}`);
        logs.push(`   New Challenge Type: ${challenge1Data.challengeType}`);

        // Parse metadata to get userId and inner challengeId
        const metadata = JSON.parse(challenge1Data.challengeMetadata);
        const userId = metadata.userId;
        const innerChallengeId = metadata.challengeId;

        logs.push(`   User ID: ${userId}`);
        logs.push(`   Inner Challenge ID: ${innerChallengeId}`);

        // STEP 4: Verify Password
        logs.push('🔄 Step 4: Verifying password...');
        
        const verifyPassword = await robloxRequest(
            `https://twostepverification.roblox.com/v1/users/${userId}/challenges/password/verify`,
            {
                method: 'POST',
                body: JSON.stringify({
                    challengeId: innerChallengeId,
                    actionType: 7,
                    code: password
                })
            }
        );

        if (verifyPassword.status !== 200) {
            const errorData = await verifyPassword.json();
            return res.status(500).json({ 
                success: false, 
                error: `Password verification failed: ${errorData.errors?.[0]?.message || verifyPassword.status}`,
                logs 
            });
        }

        const verifyData = await verifyPassword.json();
        const verificationToken = verifyData.verificationToken;

        if (!verificationToken) {
            return res.status(500).json({ 
                success: false, 
                error: 'No verification token received',
                logs 
            });
        }

        logs.push('✅ Step 4: Password verified');
        logs.push(`   Verification Token: ${verificationToken.substring(0, 20)}...`);

        // STEP 5: Complete Challenge with Verification Token
        logs.push('🔄 Step 5: Completing challenge with verification token...');
        
        const finalChallenge = await robloxRequest('https://apis.roblox.com/challenge/v1/continue', {
            method: 'POST',
            body: JSON.stringify({
                challengeId: challenge1Data.challengeId,
                challengeType: 'twostepverification',
                challengeMetadata: JSON.stringify({
                    verificationToken: verificationToken
                })
            })
        });

        if (finalChallenge.status !== 200) {
            const errorText = await finalChallenge.text();
            return res.status(500).json({ 
                success: false, 
                error: `Final challenge failed: ${finalChallenge.status}`,
                details: errorText,
                logs 
            });
        }

        logs.push('✅ Step 5: Challenge completed successfully!');
        logs.push('🎉 Birthdate changed successfully!');

        // Success!
        res.json({
            success: true,
            message: 'Birthdate changed successfully!',
            newBirthdate: {
                month: birthMonth,
                day: birthDay,
                year: birthYear
            },
            logs
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            logs: [error.stack]
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Server is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📁 Place index.html in a 'public' folder`);
});
