'use strict';

const { google } = require('googleapis');

function getClient(auth) {
  return google.youtube({ version: 'v3', auth });
}

// Looks for a broadcast that is currently live on the signed-in channel and
// returns its live chat ID, or null if nothing is live right now.
async function findActiveLiveChatId(auth) {
  const youtube = getClient(auth);
  const res = await youtube.liveBroadcasts.list({
    part: ['snippet'],
    broadcastStatus: 'active',
    broadcastType: 'all',
    maxResults: 1,
  });

  const items = res.data.items || [];
  if (items.length === 0) return null;
  return items[0].snippet.liveChatId || null;
}

// Fetches one page of live chat messages. Pass the previous response's
// nextPageToken to continue where you left off; omit it to start fresh.
async function pollChat(auth, liveChatId, pageToken) {
  const youtube = getClient(auth);
  const res = await youtube.liveChatMessages.list({
    liveChatId,
    part: ['snippet', 'authorDetails'],
    pageToken: pageToken || undefined,
  });
  return res.data;
}

module.exports = { findActiveLiveChatId, pollChat };
