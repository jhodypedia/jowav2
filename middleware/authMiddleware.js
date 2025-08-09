import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import User from "../models/User.js";
dotenv.config();

const SECRET = process.env.JWT_SECRET || "changemejwtsecret";

export async function verifyToken(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "No token provided" });

    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

export async function verifyApiKey(req, res, next) {
  try {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) return res.status(401).json({ error: "No API key" });

    const user = await User.findOne({ where: { apiKey } });
    if (!user) return res.status(401).json({ error: "Invalid API key" });

    req.user = { id: user.id, apiKey: user.apiKey, role: user.role };
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ✅ Middleware khusus Admin
export function verifyAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Access denied. Admin only." });
  }
  next();
}
