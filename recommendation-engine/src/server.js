/**
 * server.js — API process entrypoint.
 *
 * Run the WORKER as a separate process (src/workers/recommendation.worker.js).
 * Do not start the worker in-process here in production; see README for why.
 */

require('dotenv').config();
const { createApp } = require('./app');

const PORT = process.env.PORT || 4000;

const app = createApp();

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[reco-api] listening on port ${PORT}`);
});
