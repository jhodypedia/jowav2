// controllers/authController.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import User from "../models/User.js";
import { sendMail } from "../config/mailer.js";

dotenv.config();
const SECRET = process.env.JWT_SECRET || "changemejwtsecret";

/**
 * Helper to safely get body params
 */
function getBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body); // for raw text body
  } catch {
    return {};
  }
}

// REGISTER
export async function register(req, res) {
  try {
    const { username, email, phone, password } = getBody(req);
    if (!username || !email || !password) {
      return res.status(400).json({ error: "username, email, password required" });
    }

    const existEmail = await User.findOne({ where: { email } });
    if (existEmail) return res.status(409).json({ error: "Email already registered" });

    const existPhone = phone ? await User.findOne({ where: { phone } }) : null;
    if (existPhone) return res.status(409).json({ error: "Phone already registered" });

    const hashed = await bcrypt.hash(password, 10);
    const apiKey = uuidv4().replace(/-/g, "");
    const user = await User.create({
      username,
      email,
      phone,
      password: hashed,
      apiKey,
      role: "user"
    });

    return res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      apiKey: user.apiKey,
      role: user.role
    });
  } catch (err) {
    console.error("register err:", err);
    return res.status(500).json({ error: err.message });
  }
}

// LOGIN
export async function login(req, res) {
  try {
    console.log("📥 Body received:", req.body);

    const { email, password } = getBody(req);
    if (!email || !password) return res.status(400).json({ error: "email & password required" });

    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: user.id, apiKey: user.apiKey, role: user.role }, SECRET, { expiresIn: "7d" });

    return res.json({
      token,
      apiKey: user.apiKey,
      role: user.role,
      id: user.id,
      username: user.username
    });
  } catch (err) {
    console.error("login err:", err);
    return res.status(500).json({ error: err.message });
  }
}

// FORGOT PASSWORD
export async function forgotPassword(req, res) {
  try {
    const { email } = getBody(req);
    if (!email) return res.status(400).json({ error: "email required" });

    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const resetToken = uuidv4().replace(/-/g, "");
    user.resetToken = resetToken;
    user.resetTokenExp = new Date(Date.now() + 3600 * 1000); // 1 hour
    await user.save();

    const resetLink = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;
    const html = `
      <p>Hi ${user.username},</p>
      <p>Klik link berikut untuk reset password (berlaku 1 jam):</p>
      <p><a href="${resetLink}">${resetLink}</a></p>
    `;
    await sendMail(user.email, "Reset Password", html);

    return res.json({ success: true, message: "Reset link sent to email" });
  } catch (err) {
    console.error("forgotPassword err:", err);
    return res.status(500).json({ error: err.message });
  }
}

// RESET PASSWORD
export async function resetPassword(req, res) {
  try {
    const { token, password } = getBody(req);
    if (!token || !password) return res.status(400).json({ error: "token & password required" });

    const user = await User.findOne({ where: { resetToken: token } });
    if (!user) return res.status(400).json({ error: "Invalid token" });

    if (!user.resetTokenExp || new Date() > new Date(user.resetTokenExp)) {
      return res.status(400).json({ error: "Token expired" });
    }

    user.password = await bcrypt.hash(password, 10);
    user.resetToken = null;
    user.resetTokenExp = null;
    await user.save();

    return res.json({ success: true, message: "Password reset successful" });
  } catch (err) {
    console.error("resetPassword err:", err);
    return res.status(500).json({ error: err.message });
  }
}

// UPDATE PROFILE
export async function updateProfile(req, res) {
  try {
    const { username, phone, password } = getBody(req);
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (username) user.username = username;
    if (phone) user.phone = phone;
    if (password) user.password = await bcrypt.hash(password, 10);
    await user.save();

    return res.json({ success: true });
  } catch (err) {
    console.error("updateProfile err:", err);
    return res.status(500).json({ error: err.message });
  }
}

// GET ALL USERS (Admin)
export async function getAllUsers(req, res) {
  try {
    const users = await User.findAll({
      attributes: ["id", "username", "email", "phone", "apiKey", "role", "premium", "premiumUntil", "createdAt"]
    });
    return res.json(users);
  } catch (err) {
    console.error("getAllUsers err:", err);
    return res.status(500).json({ error: err.message });
  }
}

// SET USER ROLE (Admin)
export async function setUserRole(req, res) {
  try {
    const { userId, role } = getBody(req);
    if (!["admin", "user"].includes(role)) return res.status(400).json({ error: "Invalid role" });

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    user.role = role;
    await user.save();
    return res.json({ success: true });
  } catch (err) {
    console.error("setUserRole err:", err);
    return res.status(500).json({ error: err.message });
  }
}

// SET PREMIUM (Admin)
export async function setPremium(req, res) {
  try {
    const { userId, months = 1 } = getBody(req);
    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const now = new Date();
    const base = user.premiumUntil && new Date(user.premiumUntil) > now ? new Date(user.premiumUntil) : now;
    base.setMonth(base.getMonth() + months);

    user.premium = true;
    user.premiumUntil = base;
    await user.save();

    return res.json({ success: true, premiumUntil: base });
  } catch (err) {
    console.error("setPremium err:", err);
    return res.status(500).json({ error: err.message });
  }
}
