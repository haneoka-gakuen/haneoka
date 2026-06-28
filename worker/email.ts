import { waitUntil } from "cloudflare:workers";

type AuthEmailKind = "continue-signup" | "reset-password" | "verify-email" | "verify-email-change";
type AuthEmailPurpose = "account-change" | "password-reset" | "signup-verification";

export type EmailLocale = "ja" | "en" | "zh-TW" | "zh-CN" | "ko";

interface AuthEmailMessage {
  actionURL: string;
  kind: AuthEmailKind;
  locale: EmailLocale;
  newEmail?: string;
  recipient: string;
  userName: string;
}

interface EmailCopy {
  action: string;
  fallbackAction: string;
  greeting: (name: string) => string;
  heading: string;
  intro: string;
  lang: string;
  signature: string;
  subject: string;
  warning: string;
}

const MAX_EMAIL_LENGTH = 254;
const MAX_ACTION_URL_LENGTH = 4_096;
const EMAIL_COOLDOWN_MS = 60_000;
const EMAIL_DAILY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const EMAIL_DAILY_LIMIT = 10;

const emailAddress = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > MAX_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Authentication email address is invalid");
  }
  return normalized;
};

const actionURL = (value: string, baseURL: string, kind: AuthEmailKind): string => {
  if (value.length > MAX_ACTION_URL_LENGTH) throw new Error("Authentication action URL is too long");
  const action = new URL(value);
  const base = new URL(baseURL);
  const expectedPath =
    kind === "reset-password" || kind === "continue-signup"
      ? /^\/api\/auth\/reset-password\/[A-Za-z0-9_-]+$/
      : /^\/api\/auth\/verify-email$/;
  if (
    action.origin !== base.origin ||
    action.username ||
    action.password ||
    action.hash ||
    !expectedPath.test(action.pathname)
  ) {
    throw new Error("Authentication action URL is invalid");
  }
  return action.toString();
};

const escapeHTML = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

const copyFor = (message: AuthEmailMessage): EmailCopy => {
  const destination = message.newEmail ? ` ${message.newEmail}` : "";
  const copy: Record<AuthEmailKind, Omit<EmailCopy, "greeting" | "lang">> = {
    "verify-email": {
      action: "メールアドレスを確認",
      fallbackAction: "ボタンが動作しない場合は、次のリンクを開いてください：",
      heading: "メールアドレスを確認",
      intro: "このメールアドレスを確認して、Haneoka アカウントの設定を完了してください。",
      signature: "Haneoka",
      subject: "[Haneoka] メールアドレスを確認してください",
      warning:
        "このリンクは 1 時間で期限切れになります。アカウントを作成した覚えがない場合は、このメールを無視してください。",
    },
    "continue-signup": {
      action: "パスワードを設定して続行",
      fallbackAction: "ボタンが動作しない場合は、次のリンクを開いてください：",
      heading: "アカウントのパスワードを設定",
      intro: "安全なリンクからパスワードを設定して、Haneoka アカウントのセットアップを完了してください。",
      signature: "Haneoka",
      subject: "[Haneoka] アカウント設定を安全に続行",
      warning:
        "この手順を完了すると、メールアドレスが確認され、以前のパスワードと既存のセッションが無効になり、アカウント設定が完了します。登録した覚えがない場合は、このメールを無視してください。",
    },
    "reset-password": {
      action: "パスワードを再設定",
      fallbackAction: "ボタンが動作しない場合は、次のリンクを開いてください：",
      heading: "パスワードを再設定",
      intro: "下の安全なリンクから、Haneoka アカウントの新しいパスワードを設定してください。",
      signature: "Haneoka",
      subject: "[Haneoka] パスワードを再設定",
      warning:
        "このリンクは 1 時間で期限切れになります。再設定をリクエストしていない場合は、このメールを無視し、現在のパスワードをそのままお使いください。",
    },
    "verify-email-change": {
      action: "メールアドレス変更を承認",
      fallbackAction: "ボタンが動作しない場合は、次のリンクを開いてください：",
      heading: "メールアドレス変更を承認",
      intro: `Haneoka へのサインインに使用するメールアドレスを${destination}に変更します。`,
      signature: "Haneoka",
      subject: "[Haneoka] メールアドレス変更を承認",
      warning:
        "このリンクは 1 時間で期限切れになります。この変更をリクエストしていない場合は、リンクを開かないでください。",
    },
  };

  const localizedCopy: Record<EmailLocale, Record<AuthEmailKind, Omit<EmailCopy, "greeting" | "lang">>> = {
    ja: copy,
    en: {
      "verify-email": {
        action: "Verify email",
        fallbackAction: "If the button does not work, open this link:",
        heading: "Verify your email address",
        intro: "Confirm this address to finish setting up your Haneoka account.",
        signature: "Haneoka",
        subject: "[Haneoka] Verify your email address",
        warning: "This link expires in one hour. If you did not create this account, you can ignore this email.",
      },
      "continue-signup": {
        action: "Choose password and continue",
        fallbackAction: "If the button does not work, open this link:",
        heading: "Choose the password for this account",
        intro: "Use this secure link to choose your password and finish setting up your Haneoka account.",
        signature: "Haneoka",
        subject: "[Haneoka] Securely continue setting up your account",
        warning:
          "Completing this step verifies the email address, replaces any earlier password, revokes existing sessions, and finishes account setup. If you did not try to register, ignore this email.",
      },
      "reset-password": {
        action: "Reset password",
        fallbackAction: "If the button does not work, open this link:",
        heading: "Reset your password",
        intro: "Use the secure link below to choose a new password for your Haneoka account.",
        signature: "Haneoka",
        subject: "[Haneoka] Reset your password",
        warning:
          "This link expires in one hour. If you did not request a reset, ignore this email and keep your password.",
      },
      "verify-email-change": {
        action: "Approve email change",
        fallbackAction: "If the button does not work, open this link:",
        heading: "Approve your email change",
        intro: `Confirm that you want to change your Haneoka sign-in email to${destination}.`,
        signature: "Haneoka",
        subject: "[Haneoka] Approve your email change",
        warning: "This link expires in one hour. If you did not request this change, do not open the link.",
      },
    },
    "zh-TW": {
      "verify-email": {
        action: "驗證電子郵件",
        fallbackAction: "如果按鈕無法使用，請開啟此連結：",
        heading: "驗證你的電子郵件地址",
        intro: "確認此地址以完成 Haneoka 帳號設定。",
        signature: "Haneoka",
        subject: "[Haneoka] 驗證你的電子郵件地址",
        warning: "此連結將於一小時後失效。若非你建立此帳號，請忽略這封郵件。",
      },
      "continue-signup": {
        action: "設定密碼並繼續",
        fallbackAction: "如果按鈕無法使用，請開啟此連結：",
        heading: "設定此帳號的密碼",
        intro: "使用此安全連結設定密碼，並完成 Haneoka 帳號設定。",
        signature: "Haneoka",
        subject: "[Haneoka] 安全地繼續設定帳號",
        warning:
          "完成此步驟會驗證電子郵件地址、取代任何舊密碼、撤銷現有工作階段，並完成帳號設定。若非你嘗試註冊，請忽略這封郵件。",
      },
      "reset-password": {
        action: "重設密碼",
        fallbackAction: "如果按鈕無法使用，請開啟此連結：",
        heading: "重設你的密碼",
        intro: "使用下方安全連結，為你的 Haneoka 帳號設定新密碼。",
        signature: "Haneoka",
        subject: "[Haneoka] 重設你的密碼",
        warning: "此連結將於一小時後失效。若非你要求重設，請忽略這封郵件並保留目前的密碼。",
      },
      "verify-email-change": {
        action: "核准變更電子郵件",
        fallbackAction: "如果按鈕無法使用，請開啟此連結：",
        heading: "核准變更電子郵件",
        intro: `確認你要將 Haneoka 登入電子郵件變更為${destination}。`,
        signature: "Haneoka",
        subject: "[Haneoka] 核准變更電子郵件",
        warning: "此連結將於一小時後失效。若非你要求此變更，請勿開啟連結。",
      },
    },
    "zh-CN": {
      "verify-email": {
        action: "验证电子邮件",
        fallbackAction: "如果按钮无法使用，请打开此链接：",
        heading: "验证你的电子邮件地址",
        intro: "确认此地址以完成 Haneoka 帐号设置。",
        signature: "Haneoka",
        subject: "[Haneoka] 验证你的电子邮件地址",
        warning: "此链接将在一小时后失效。如果不是你创建了此帐号，请忽略这封邮件。",
      },
      "continue-signup": {
        action: "设置密码并继续",
        fallbackAction: "如果按钮无法使用，请打开此链接：",
        heading: "设置此帐号的密码",
        intro: "使用此安全链接设置密码，并完成 Haneoka 帐号设置。",
        signature: "Haneoka",
        subject: "[Haneoka] 安全地继续设置帐号",
        warning:
          "完成此步骤会验证电子邮件地址、替换任何旧密码、撤销现有会话，并完成帐号设置。如果不是你尝试注册，请忽略这封邮件。",
      },
      "reset-password": {
        action: "重设密码",
        fallbackAction: "如果按钮无法使用，请打开此链接：",
        heading: "重设你的密码",
        intro: "使用下方安全链接，为你的 Haneoka 帐号设置新密码。",
        signature: "Haneoka",
        subject: "[Haneoka] 重设你的密码",
        warning: "此链接将在一小时后失效。如果不是你要求重设，请忽略这封邮件并保留当前密码。",
      },
      "verify-email-change": {
        action: "批准更改电子邮件",
        fallbackAction: "如果按钮无法使用，请打开此链接：",
        heading: "批准更改电子邮件",
        intro: `确认你要将 Haneoka 登录电子邮件更改为${destination}。`,
        signature: "Haneoka",
        subject: "[Haneoka] 批准更改电子邮件",
        warning: "此链接将在一小时后失效。如果不是你要求此更改，请勿打开链接。",
      },
    },
    ko: {
      "verify-email": {
        action: "이메일 확인",
        fallbackAction: "버튼이 작동하지 않으면 이 링크를 여세요:",
        heading: "이메일 주소 확인",
        intro: "이 주소를 확인하여 Haneoka 계정 설정을 완료하세요.",
        signature: "Haneoka",
        subject: "[Haneoka] 이메일 주소 확인",
        warning: "이 링크는 한 시간 후에 만료됩니다. 계정을 만든 적이 없다면 이 이메일을 무시해도 됩니다.",
      },
      "continue-signup": {
        action: "비밀번호 설정하고 계속",
        fallbackAction: "버튼이 작동하지 않으면 이 링크를 여세요:",
        heading: "계정 비밀번호 설정",
        intro: "이 보안 링크에서 비밀번호를 설정하여 Haneoka 계정 설정을 완료하세요.",
        signature: "Haneoka",
        subject: "[Haneoka] 계정 설정을 안전하게 계속",
        warning:
          "이 단계를 완료하면 이메일 주소가 확인되고, 이전 비밀번호와 기존 세션이 해제되며 계정 설정이 완료됩니다. 가입을 시도한 적이 없다면 이 이메일을 무시하세요.",
      },
      "reset-password": {
        action: "비밀번호 재설정",
        fallbackAction: "버튼이 작동하지 않으면 이 링크를 여세요:",
        heading: "비밀번호 재설정",
        intro: "아래 보안 링크에서 Haneoka 계정의 새 비밀번호를 설정하세요.",
        signature: "Haneoka",
        subject: "[Haneoka] 비밀번호 재설정",
        warning:
          "이 링크는 한 시간 후에 만료됩니다. 재설정을 요청하지 않았다면 이 이메일을 무시하고 현재 비밀번호를 유지하세요.",
      },
      "verify-email-change": {
        action: "이메일 변경 승인",
        fallbackAction: "버튼이 작동하지 않으면 이 링크를 여세요:",
        heading: "이메일 변경 승인",
        intro: `Haneoka 로그인 이메일을${destination}(으)로 변경할지 확인하세요.`,
        signature: "Haneoka",
        subject: "[Haneoka] 이메일 변경 승인",
        warning: "이 링크는 한 시간 후에 만료됩니다. 이 변경을 요청하지 않았다면 링크를 열지 마세요.",
      },
    },
  };
  const language: Record<EmailLocale, Pick<EmailCopy, "greeting" | "lang">> = {
    ja: { greeting: (name) => (name ? `${name} さん、こんにちは。` : "こんにちは。"), lang: "ja" },
    en: { greeting: (name) => (name ? `Hello ${name},` : "Hello,"), lang: "en" },
    "zh-TW": { greeting: (name) => (name ? `${name}，你好：` : "你好："), lang: "zh-Hant" },
    "zh-CN": { greeting: (name) => (name ? `${name}，你好：` : "你好："), lang: "zh-Hans" },
    ko: { greeting: (name) => (name ? `${name}님, 안녕하세요.` : "안녕하세요."), lang: "ko" },
  };
  return { ...localizedCopy[message.locale][message.kind], ...language[message.locale] };
};

const renderEmail = (message: AuthEmailMessage, safeURL: string): { html: string; subject: string; text: string } => {
  const copy = copyFor(message);
  const name = message.userName.trim();
  const text = [
    copy.greeting(name),
    "",
    copy.intro,
    "",
    copy.action,
    safeURL,
    "",
    copy.warning,
    "",
    copy.signature,
  ].join("\n");
  const html = `<!doctype html>
<html lang="${copy.lang}">
  <body style="margin:0;background:#fef7ff;color:#1d1b20;font-family:Roboto,'Noto Sans',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px;background:#fef7ff">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;border:1px solid #cac4d0;border-radius:28px;background:#fffbfe;overflow:hidden">
          <tr><td style="padding:24px 32px;background:#e8def8;font-size:14px;font-weight:700;letter-spacing:.08em;color:#21005d">HANEOKA</td></tr>
          <tr><td style="padding:32px">
            <h1 style="margin:0 0 20px;font-size:28px;line-height:1.28;font-weight:500;letter-spacing:0;color:#1d1b20">${escapeHTML(copy.heading)}</h1>
            <p style="margin:0 0 12px;font-size:16px;line-height:1.6;color:#1d1b20">${escapeHTML(copy.greeting(name))}</p>
            <p style="margin:0 0 26px;font-size:16px;line-height:1.6;color:#49454f">${escapeHTML(copy.intro)}</p>
            <p style="margin:0 0 28px"><a href="${escapeHTML(safeURL)}" style="display:inline-block;border-radius:20px;background:#6750a4;color:#ffffff;text-decoration:none;padding:12px 24px;font-size:14px;font-weight:700;line-height:20px">${escapeHTML(copy.action)}</a></p>
            <p style="margin:0 0 20px;padding:16px;border-radius:12px;background:#f3edf7;font-size:14px;line-height:1.55;color:#49454f">${escapeHTML(copy.warning)}</p>
            <p style="margin:0;font-size:12px;line-height:1.55;color:#79747e;word-break:break-all">${escapeHTML(copy.fallbackAction)}<br><a href="${escapeHTML(safeURL)}" style="color:#6750a4;text-decoration:underline">${escapeHTML(safeURL)}</a></p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  return { html, subject: copy.subject, text };
};

const errorDetails = (error: unknown): { code: string; message: string; name: string } => {
  if (!(error instanceof Error)) {
    return { code: "email_send_failed", message: "Authentication email delivery failed", name: "Error" };
  }
  const code = "code" in error && typeof error.code === "string" ? error.code : "email_send_failed";
  return { code, message: "Authentication email delivery failed", name: error.name || "Error" };
};

const sendAuthEmail = async (env: Env, baseURL: string, message: AuthEmailMessage): Promise<void> => {
  const recipient = emailAddress(message.recipient);
  const sender = emailAddress(env.AUTH_EMAIL_FROM);
  const safeURL = actionURL(message.actionURL, baseURL, message.kind);
  const content = renderEmail(message, safeURL);
  await env.EMAIL.send({
    from: { email: sender, name: "haneoka" },
    to: recipient,
    subject: content.subject,
    html: content.html,
    text: content.text,
  });
};

const emailPurpose = (kind: AuthEmailKind): AuthEmailPurpose => {
  switch (kind) {
    case "continue-signup":
    case "verify-email":
      return "signup-verification";
    case "reset-password":
      return "password-reset";
    case "verify-email-change":
      return "account-change";
  }
};

const recipientHash = async (env: Env, recipient: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(recipient));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const claimAuthEmailDelivery = async (
  env: Env,
  recipientValue: string,
  kind: AuthEmailKind,
): Promise<boolean> => {
  const recipient = emailAddress(recipientValue);
  const now = Date.now();
  const dayCutoff = now - EMAIL_DAILY_WINDOW_MS;
  const claimed = await env.DB.prepare(
    `INSERT INTO auth_email_delivery_guard
       (recipient_hash, purpose, window_started_at, sent_count, last_sent_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(recipient_hash, purpose) DO UPDATE SET
       window_started_at = CASE
         WHEN auth_email_delivery_guard.window_started_at <= ? THEN excluded.window_started_at
         ELSE auth_email_delivery_guard.window_started_at
       END,
       sent_count = CASE
         WHEN auth_email_delivery_guard.window_started_at <= ? THEN 1
         ELSE auth_email_delivery_guard.sent_count + 1
       END,
       last_sent_at = excluded.last_sent_at,
       updated_at = excluded.updated_at
     WHERE auth_email_delivery_guard.last_sent_at <= ?
       AND (
         auth_email_delivery_guard.window_started_at <= ?
         OR auth_email_delivery_guard.sent_count < ?
       )
     RETURNING 1 AS claimed`,
  )
    .bind(
      await recipientHash(env, recipient),
      emailPurpose(kind),
      now,
      now,
      now,
      dayCutoff,
      dayCutoff,
      now - EMAIL_COOLDOWN_MS,
      dayCutoff,
      EMAIL_DAILY_LIMIT,
    )
    .first<{ claimed: number }>();
  return claimed?.claimed === 1;
};

export const queueAuthEmail = (env: Env, baseURL: string, message: AuthEmailMessage): void => {
  waitUntil(
    sendAuthEmail(env, baseURL, message).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "auth.email.send_failed",
          kind: message.kind,
          error: errorDetails(error),
        }),
      );
    }),
  );
};
