const { analyzeContext } = require('../context-director');

module.exports = function(app) {
  app.post('/api/context/analyze', async (req, res) => {
    const { messages, query, userLocation } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query' });
    try {
      const analysis = await analyzeContext(messages || [], query, userLocation || '');
      res.json(analysis || {
        topic: '', expandedQuery: query,
        needsLocationSearch: false, locationSearchQuery: null,
        needsWebSearch: false, webSearchQuery: null
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
