import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

export async function sendMail(to, subject, html) {
  return transporter.sendMail({
    from: `"WA API Service" <${process.env.MAIL_USER}>`,
    to,
    subject,
    html
  });
}
