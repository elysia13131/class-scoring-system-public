const scheduleStore = require('../data/scheduleStore');

function installRoutes(app) {

  app.get('/api/schedules/:memberId', (req, res) => {
    try {
      const { memberId } = req.params;
      const { date } = req.query;
      let schedules;
      if (date) {
        schedules = scheduleStore.getSchedulesByDate(date, memberId);
      } else {
        schedules = scheduleStore.getUpcomingSchedules(memberId, 50);
      }
      res.json({ schedules });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/schedules/:memberId/date/:date', (req, res) => {
    try {
      const { memberId, date } = req.params;
      const schedules = scheduleStore.getSchedulesByDate(date, memberId);
      res.json({ schedules, date });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/schedules', (req, res) => {
    try {
      const { title, description, dueAt, createdBy, targetMemberIds, isGlobal } = req.body;
      if (!dueAt) return res.status(400).json({ error: 'dueAt为必填项' });
      if (!targetMemberIds || targetMemberIds.length === 0) {
        return res.status(400).json({ error: '至少选择一个目标成员' });
      }
      const schedule = scheduleStore.createSchedule({
        title, description, dueAt,
        createdBy: createdBy || 'unknown',
        targetMemberIds,
        isGlobal: isGlobal || false
      });
      res.json({ success: true, schedule });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/schedules/:id', (req, res) => {
    try {
      const { id } = req.params;
      const { memberId } = req.query;
      const ok = scheduleStore.deleteSchedule(id, memberId || 'unknown');
      res.json({ success: ok });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { installRoutes };
