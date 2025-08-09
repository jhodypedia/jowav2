// controllers/logController.js
import Log from "../models/Log.js";

export async function getLogs(req, res) {
  try {
    // admin sees all logs, user sees own logs
    if (req.user.role === "admin") {
      const logs = await Log.findAll({ order: [["createdAt", "DESC"]] });
      return res.json(logs);
    } else {
      const logs = await Log.findAll({ where: { userId: req.user.id }, order: [["createdAt", "DESC"]] });
      return res.json(logs);
    }
  } catch (err) {
    console.error("getLogs err:", err);
    return res.status(500).json({ error: err.message });
  }
}
