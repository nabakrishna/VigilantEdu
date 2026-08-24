/**
 * app.js
 *
 * Standalone Express app wiring for this module. In a real monorepo, you
 * will most likely NOT run this file directly — instead you'll mount
 * `recommendationRoutes` onto your platform's existing app (see README,
 * "Integrating into the Existing Application"). This file exists so the
 * module can be run/tested in isolation.
 */

const express = require('express');
const recommendationRoutes = require('./routes/recommendation.routes');
const { errorHandler } = require('./middleware/errorHandler.middleware');

function createApp() {
  const app = express();

  app.use(express.json());

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.use('/api', recommendationRoutes);

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
