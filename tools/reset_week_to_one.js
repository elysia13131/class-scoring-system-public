const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'backend', 'data', 'config.json');

try {
    // Get current Beijing Time
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Shanghai"}));
    
    // Find the most recent Monday (Monday = 1)
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
    const monday = new Date(now.setDate(diff));
    monday.setHours(0, 0, 0, 0);
    
    // Format to ISO with +08:00
    const offset = 8;
    const pad = (n) => (n < 10 ? '0' + n : n);
    const dateStr = `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}T00:00:00+08:00`;
    
    const config = {
        startDate: dateStr
    };
    
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`✅ 已重置当前时间为第一周！ (起始日期已设为本周一: ${dateStr})`);
} catch (err) {
    console.error('❌ 重置周次失败:', err);
}
