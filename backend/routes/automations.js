const automationStore = require('../data/automationStore');

function installRoutes(app) {

  app.get('/api/automations/:memberId', (req, res) => {
    try {
      const { memberId } = req.params;
      const list = automationStore.getAutomationsByMember(memberId);
      res.json({ automations: list });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/automations', (req, res) => {
    try {
      const { name, prompt, intervalMinutes, fixedTime, createdBy } = req.body;
      const auto = automationStore.createAutomation({
        name, prompt, intervalMinutes: intervalMinutes || null,
        fixedTime: fixedTime || null, createdBy: createdBy || 'unknown'
      });
      res.json({ success: true, automation: auto });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/automations/:id', (req, res) => {
    try {
      const { id } = req.params;
      const { memberId } = req.query;
      const ok = automationStore.deleteAutomation(id, memberId || 'unknown');
      res.json({ success: ok });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { installRoutes };
