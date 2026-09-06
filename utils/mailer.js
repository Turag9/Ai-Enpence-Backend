import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, // Gmail App Password
  },
});

export const sendOtpEmail = async (toEmail, otp) => {
  await transporter.sendMail({
    from: `"ExpenseAI" <${process.env.EMAIL_USER}>`,
    to: toEmail,
    subject: 'Password Reset OTP - ExpenseAI',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 32px; border-radius: 12px; border: 1px solid #e2e8f0;">
        <h2 style="color: #7c3aed; margin-bottom: 8px;">ExpenseAI</h2>
        <p style="color: #475569; margin-bottom: 24px;">আপনার পাসওয়ার্ড রিসেট করতে নিচের OTP কোডটি ব্যবহার করুন:</p>
        <div style="background: #f5f3ff; border-radius: 10px; padding: 24px; text-align: center; letter-spacing: 12px; font-size: 36px; font-weight: bold; color: #7c3aed;">
          ${otp}
        </div>
        <p style="color: #94a3b8; font-size: 13px; margin-top: 20px;">এই OTP <strong>10 মিনিট</strong> পর্যন্ত valid। কাউকে এটি শেয়ার করবেন না।</p>
      </div>
    `,
  });
};
