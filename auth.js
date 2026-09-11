'use strict';

const { google } = require('googleapis');
const { shell, safeStorage } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'];

function tokenPath(app) {
  return path.join(app.getPath('userData'), 'tokens.dat');
}

function saveTokens(app, tokens) {
  const json = JSON.stringify(tokens);
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf-8');
  fs.writeFileSync(tokenPath(app), data);
}

function loadTokens(app) {
  const p = tokenPath(app);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p);
  try {
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf-8');
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

// Runs Google's "installed app" loopback OAuth flow: spins up a throwaway
// local HTTP server, opens the system browser for consent, and captures the
// authorization code from the redirect.
function runLoopbackFlow(config) {
  return new Promise((resolve, reject) => {
    let port;

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, 'http://127.0.0.1');
        if (reqUrl.pathname !== '/oauth2callback') {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = reqUrl.searchParams.get('code');
        const err = reqUrl.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (err) {
          res.end('<h2>Sign-in failed. You can close this tab and check the app console.</h2>');
          server.close();
          reject(new Error('OAuth error: ' + err));
          return;
        }
        res.end('<h2>Signed in! You can close this tab and go back to the overlay.</h2>');
        server.close();

        const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
        const client = new google.auth.OAuth2(config.clientId, config.clientSecret, redirectUri);
        const { tokens } = await client.getToken(code);
        resolve(tokens);
      } catch (e) {
        reject(e);
      }
    });

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      const client = new google.auth.OAuth2(config.clientId, config.clientSecret, redirectUri);
      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
      });
      shell.openExternal(authUrl);
    });
  });
}

// Returns an authorized OAuth2 client, running the interactive sign-in flow
// only the first time (or after tokens are deleted / revoked).
async function getAuthorizedClient(app, config) {
  if (!config.clientId || config.clientId.startsWith('YOUR_')) {
    throw new Error(
      'config.json still has placeholder OAuth credentials. See README.md to create your own client ID/secret.'
    );
  }

  const oauth2Client = new google.auth.OAuth2(config.clientId, config.clientSecret);

  const existing = loadTokens(app);
  if (existing) {
    oauth2Client.setCredentials(existing);
  } else {
    const tokens = await runLoopbackFlow(config);
    oauth2Client.setCredentials(tokens);
    saveTokens(app, tokens);
  }

  // Google occasionally rotates the access/refresh token pair; persist
  // whatever the client hands us so future launches don't need a fresh login.
  oauth2Client.on('tokens', (tokens) => {
    const merged = { ...oauth2Client.credentials, ...tokens };
    saveTokens(app, merged);
  });

  return oauth2Client;
}

function clearTokens(app) {
  const p = tokenPath(app);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

module.exports = { getAuthorizedClient, clearTokens };
