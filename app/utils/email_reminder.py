import os
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, date
from zoneinfo import ZoneInfo


def send_reminder_email(to_email: str, user_name: str):
    smtp_server = os.getenv("SMTP_SERVER", "smtp.qq.com")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_user = os.getenv("SMTP_USER", "")
    smtp_password = os.getenv("SMTP_PASSWORD", "")

    if not smtp_user or not smtp_password:
        print("SMTP not configured, skipping email")
        return False

    today_str = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")

    subject_tpl = os.getenv("REMINDER_EMAIL_SUBJECT", "提醒：{today} 工作总结尚未填写")
    body_tpl = os.getenv("REMINDER_EMAIL_BODY",
        "Hi {user_name}，\n\n"
        "今天是 {today}，你还没有填写每日工作总结哦～\n\n"
        "请尽快登录心动坐标记录今日的工作事项：\n"
        "http://localhost:8002/work-summary\n\n"
        "保持好习惯，每天都总结！\n\n"
        "—— 心动坐标 · 自动提醒")

    subject = subject_tpl.replace("{today}", today_str)
    body = body_tpl.replace("{user_name}", user_name).replace("{today}", today_str)

    msg = MIMEMultipart()
    msg["From"] = smtp_user
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain", "utf-8"))

    try:
        server = smtplib.SMTP(smtp_server, smtp_port, timeout=15)
        server.starttls()
        server.login(smtp_user, smtp_password)
        server.sendmail(smtp_user, [to_email], msg.as_string())
        server.quit()
        print(f"Reminder email sent to {to_email}")
        return True
    except Exception as e:
        print(f"Failed to send email: {e}")
        return False
