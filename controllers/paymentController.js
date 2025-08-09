// controllers/paymentController.js
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import Payment from "../models/Payment.js";
import User from "../models/User.js";

const MIDTRANS_API = process.env.MIDTRANS_IS_PRODUCTION === "true"
  ? "https://api.midtrans.com/v2"
  : "https://api.sandbox.midtrans.com/v2";

function getAuthHeader() {
  const serverKey = process.env.MIDTRANS_SERVER_KEY || "";
  const authString = Buffer.from(serverKey + ":").toString("base64");
  return `Basic ${authString}`;
}

/**
 * Create QRIS payment (charge API) and return QR detail to frontend.
 * Protected: verifyToken (req.user)
 */
export async function createPremiumPaymentQRIS(req, res) {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const amount = 35000;
    const orderId = `PREMIUM-${uuidv4()}`;

    // create payment record (pending)
    await Payment.create({
      orderId,
      userId: user.id,
      amount,
      status: "pending",
      provider: "midtrans",
      notification: null
    });

    // prepare payload for charge
    const payload = {
      payment_type: "qris",
      transaction_details: {
        order_id: orderId,
        gross_amount: amount
      }
    };

    const { data } = await axios.post(
      `${MIDTRANS_API}/charge`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: getAuthHeader()
        }
      }
    );

    // Midtrans response for QRIS usually contains actions or qr_string / qr_url
    // Actions example: data.actions = [{name:"generate-qr-code", url:"<qr url>"}]
    // Also there may be 'qr_string' or 'qr_code' in data
    const qrisAction = (data.actions || []).find(a => a.name === "generate-qr-code");
    const qrUrl = qrisAction?.url || data.qr_string || data.qr_code || null;

    // We can also return full `data` so frontend can inspect
    return res.json({
      success: true,
      orderId,
      amount,
      qris: {
        qrUrl,
        raw: data
      }
    });
  } catch (err) {
    console.error("createPremiumPaymentQRIS err:", err.response?.data || err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * verify signature_key from midtrans
 */
function verifyMidtransSignature(notification) {
  try {
    const serverKey = process.env.MIDTRANS_SERVER_KEY || "";
    const input = notification.order_id + notification.status_code + notification.gross_amount + serverKey;
    const signature = crypto.createHash("sha512").update(input).digest("hex");
    return signature === notification.signature_key;
  } catch (err) {
    return false;
  }
}

/**
 * Webhook endpoint for Midtrans - public
 * Update Payment record and activate premium when settled
 */
export async function midtransNotification(req, res) {
  try {
    const notification = req.body;

    if (!verifyMidtransSignature(notification)) {
      console.warn("Invalid Midtrans signature:", notification.order_id);
      return res.status(403).json({ error: "Invalid signature" });
    }

    const orderId = notification.order_id;
    const transaction_status = notification.transaction_status;
    const gross_amount = parseInt(notification.gross_amount || 0, 10);

    const payment = await Payment.findOne({ where: { orderId } });
    if (!payment) {
      console.warn("Payment not found for orderId:", orderId);
      return res.status(404).json({ error: "Order not found" });
    }

    // save notification raw
    payment.notification = notification;

    // verify amount matches expected
    if (gross_amount !== payment.amount) {
      payment.status = "amount_mismatch";
      await payment.save();
      console.warn(`Amount mismatch for ${orderId}: expected ${payment.amount}, got ${gross_amount}`);
      return res.status(400).json({ error: "Amount mismatch" });
    }

    // update status
    payment.status = transaction_status;
    await payment.save();

    // if success -> activate premium
    const statusLower = (transaction_status || "").toString().toLowerCase();
    if (statusLower === "settlement" || statusLower === "capture" || statusLower === "success") {
      const user = await User.findByPk(payment.userId);
      if (user) {
        const now = new Date();
        const expiryBase = user.premiumUntil && new Date(user.premiumUntil) > now ? new Date(user.premiumUntil) : now;
        expiryBase.setMonth(expiryBase.getMonth() + 1);

        user.premium = true;
        user.premiumUntil = expiryBase;
        await user.save();
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("midtransNotification err:", err);
    return res.status(500).json({ error: err.message });
  }
}
