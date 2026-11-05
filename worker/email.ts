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
  expiry: string;
  details?: string;
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
  const destination = message.newEmail || "";
  const common = {
    ja: {
      lang: "ja",
      greeting: (name: string) => (name ? `${name} さん、こんにちは。` : "こんにちは。"),
      expiry: "このリンクの有効期限は1時間です。",
      fallbackAction: "ボタンを開けない場合は、次のURLをブラウザーに貼り付けてください。",
    },
    en: {
      lang: "en",
      greeting: (name: string) => (name ? `Hello ${name},` : "Hello,"),
      expiry: "This link is valid for one hour.",
      fallbackAction: "If the button does not open, copy this URL into your browser.",
    },
    "zh-TW": {
      lang: "zh-Hant",
      greeting: (name: string) => (name ? `${name}，你好：` : "你好："),
      expiry: "此連結的有效期限為一小時。",
      fallbackAction: "若按鈕無法開啟，請將以下網址貼到瀏覽器。",
    },
    "zh-CN": {
      lang: "zh-Hans",
      greeting: (name: string) => (name ? `${name}，你好：` : "你好："),
      expiry: "此链接的有效期为一小时。",
      fallbackAction: "若按钮无法打开，请将以下网址粘贴到浏览器。",
    },
    ko: {
      lang: "ko",
      greeting: (name: string) => (name ? `${name}님, 안녕하세요.` : "안녕하세요."),
      expiry: "이 링크는 한 시간 동안 유효합니다.",
      fallbackAction: "버튼이 열리지 않으면 아래 URL을 브라우저에 붙여 넣으세요.",
    },
  } satisfies Record<EmailLocale, Pick<EmailCopy, "lang" | "greeting" | "expiry" | "fallbackAction">>;
  type MessageCopy = Pick<EmailCopy, "heading" | "intro" | "action" | "warning" | "details">;
  const messages: Record<EmailLocale, Record<AuthEmailKind, MessageCopy>> = {
    ja: {
      "verify-email": {
        heading: "メールアドレスを確認",
        intro: "このメールアドレスを確認して、Haneoka アカウントの設定を完了してください。",
        action: "メールアドレスを確認",
        warning: "アカウントを作成した覚えがない場合は、このメールを無視してください。",
      },
      "continue-signup": {
        heading: "アカウント設定を完了",
        intro: "パスワードを設定すると、Haneoka アカウントをご利用いただけます。",
        action: "パスワードを設定",
        details:
          "この手続きでメールアドレスの確認が完了し、以前のパスワードは置き換えられ、ログイン中のセッションは終了します。",
        warning: "登録した覚えがない場合は、このメールを無視してください。",
      },
      "reset-password": {
        heading: "パスワードを再設定",
        intro: "Haneoka アカウントの新しいパスワードを設定してください。",
        action: "パスワードを再設定",
        warning: "再設定をリクエストしていない場合は、このメールを無視してください。現在のパスワードは変更されません。",
      },
      "verify-email-change": {
        heading: "メールアドレスの変更を承認",
        intro: destination
          ? `Haneoka のログイン用メールアドレスを ${destination} に変更するリクエストがありました。`
          : "Haneoka のログイン用メールアドレスの変更を確認してください。",
        action: "メールアドレスの変更を承認",
        warning: "この変更をリクエストしていない場合は、リンクを開かないでください。",
      },
    },
    en: {
      "verify-email": {
        heading: "Verify your email address",
        intro: "Confirm this address to finish setting up your Haneoka account.",
        action: "Verify email",
        warning: "If you did not create this account, you can ignore this email.",
      },
      "continue-signup": {
        heading: "Finish setting up your account",
        intro: "Choose a password to start using your Haneoka account.",
        action: "Set password",
        details: "This also verifies your email, replaces any earlier password, and signs out existing sessions.",
        warning: "If you did not try to register, you can ignore this email.",
      },
      "reset-password": {
        heading: "Reset your password",
        intro: "Choose a new password for your Haneoka account.",
        action: "Reset password",
        warning: "If you did not request a reset, ignore this email. Your current password will stay the same.",
      },
      "verify-email-change": {
        heading: "Approve your email change",
        intro: destination
          ? `A change to your Haneoka sign-in email was requested. Confirm the new address: ${destination}.`
          : "Confirm the requested change to your Haneoka sign-in email.",
        action: "Approve email change",
        warning: "If you did not request this change, do not open the link.",
      },
    },
    "zh-TW": {
      "verify-email": {
        heading: "驗證你的電子郵件",
        intro: "確認此地址，即可完成 Haneoka 帳號設定。",
        action: "驗證電子郵件",
        warning: "若非你建立此帳號，請忽略這封郵件。",
      },
      "continue-signup": {
        heading: "完成帳號設定",
        intro: "設定密碼，開始使用你的 Haneoka 帳號。",
        action: "設定密碼",
        details: "這個步驟也會完成電子郵件驗證、取代舊密碼，並登出已登入的裝置。",
        warning: "若非你嘗試註冊，請忽略這封郵件。",
      },
      "reset-password": {
        heading: "重設你的密碼",
        intro: "為你的 Haneoka 帳號設定新密碼。",
        action: "重設密碼",
        warning: "若非你要求重設，請忽略這封郵件。目前的密碼不會改變。",
      },
      "verify-email-change": {
        heading: "確認變更電子郵件",
        intro: destination
          ? `你要求將 Haneoka 登入電子郵件變更為 ${destination}，請確認此變更。`
          : "請確認變更你的 Haneoka 登入電子郵件。",
        action: "確認變更",
        warning: "若非你要求此變更，請勿開啟連結。",
      },
    },
    "zh-CN": {
      "verify-email": {
        heading: "验证你的电子邮件",
        intro: "确认此地址，即可完成 Haneoka 帐号设置。",
        action: "验证电子邮件",
        warning: "如果不是你创建了此帐号，请忽略这封邮件。",
      },
      "continue-signup": {
        heading: "完成帐号设置",
        intro: "设置密码，开始使用你的 Haneoka 帐号。",
        action: "设置密码",
        details: "这一步也会完成邮箱验证、替换旧密码，并退出已登录的设备。",
        warning: "如果不是你尝试注册，请忽略这封邮件。",
      },
      "reset-password": {
        heading: "重设你的密码",
        intro: "为你的 Haneoka 帐号设置新密码。",
        action: "重设密码",
        warning: "如果不是你要求重设，请忽略这封邮件。当前密码不会改变。",
      },
      "verify-email-change": {
        heading: "确认更改电子邮件",
        intro: destination
          ? `你要求将 Haneoka 登录邮箱更改为 ${destination}，请确认此更改。`
          : "请确认更改你的 Haneoka 登录邮箱。",
        action: "确认更改",
        warning: "如果不是你要求此更改，请勿打开链接。",
      },
    },
    ko: {
      "verify-email": {
        heading: "이메일 주소 확인",
        intro: "이 주소를 확인하여 Haneoka 계정 설정을 완료하세요.",
        action: "이메일 확인",
        warning: "계정을 만든 적이 없다면 이 이메일을 무시해도 됩니다.",
      },
      "continue-signup": {
        heading: "계정 설정 완료",
        intro: "비밀번호를 설정하고 Haneoka 계정 사용을 시작하세요.",
        action: "비밀번호 설정",
        details: "이 단계를 완료하면 이메일이 확인되고, 이전 비밀번호가 교체되며 로그인된 세션이 종료됩니다.",
        warning: "가입을 시도한 적이 없다면 이 이메일을 무시하세요.",
      },
      "reset-password": {
        heading: "비밀번호 재설정",
        intro: "Haneoka 계정의 새 비밀번호를 설정하세요.",
        action: "비밀번호 재설정",
        warning: "재설정을 요청하지 않았다면 이 이메일을 무시하세요. 현재 비밀번호는 변경되지 않습니다.",
      },
      "verify-email-change": {
        heading: "이메일 변경 승인",
        intro: destination
          ? `Haneoka 로그인 이메일을 ${destination}(으)로 변경하는 요청을 확인해 주세요.`
          : "Haneoka 로그인 이메일 변경 요청을 확인해 주세요.",
        action: "이메일 변경 승인",
        warning: "이 변경을 요청하지 않았다면 링크를 열지 마세요.",
      },
    },
  };
  const messageCopy = messages[message.locale][message.kind];
  return {
    ...common[message.locale],
    ...messageCopy,
    signature: "Haneoka",
    subject: `[Haneoka] ${messageCopy.heading}`,
  };
};

const renderEmail = (message: AuthEmailMessage, safeURL: string): { html: string; subject: string; text: string } => {
  const copy = copyFor(message);
  const greeting = copy.greeting(message.userName.trim());
  const siteURL = new URL("/", safeURL).href;
  // Public PNG works in mail image proxies and clients without SVG support.
  const logoURL = new URL("/apple-touch-icon.png", siteURL).href;
  const text = [
    copy.heading,
    "",
    greeting,
    "",
    copy.intro,
    ...(copy.details ? ["", copy.details] : []),
    "",
    `${copy.action}:`,
    safeURL,
    "",
    copy.expiry,
    "",
    copy.warning,
    "",
    copy.signature,
    siteURL,
  ].join("\n");
  const html = `<!doctype html>
<html lang="${copy.lang}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHTML(copy.heading)}</title></head>
<body style="margin:0;padding:0;background:#fcf8fd;color:#1b1b1f;font-family:Arial,'Hiragino Kaku Gothic ProN','Yu Gothic','Microsoft JhengHei','Microsoft YaHei','Malgun Gothic',sans-serif;-webkit-text-size-adjust:100%">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHTML(copy.intro)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#fcf8fd" style="width:100%;border-collapse:collapse">
    <tr><td align="center" style="padding:24px 12px">
      <!--[if mso]><table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;border-collapse:separate;background:#ffffff;border:1px solid #c7c5d0;border-radius:24px">
        <tr><td style="padding:24px 24px 20px;border-bottom:1px solid #e4e1ec">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
            <td width="44" style="vertical-align:middle"><a href="${siteURL}" style="text-decoration:none"><img src="${logoURL}" width="44" height="44" alt="" referrerpolicy="no-referrer" border="0" style="display:block;border:0;border-radius:12px"></a></td>
            <td style="padding-left:12px;vertical-align:middle"><a href="${siteURL}" style="font-size:20px;line-height:26px;font-weight:700;letter-spacing:.2px;color:#31356e;text-decoration:none">Haneoka</a></td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:28px 24px 24px">
          <h1 style="margin:0 0 22px;font-size:26px;line-height:34px;font-weight:600;color:#1b1b1f">${escapeHTML(copy.heading)}</h1>
          <p style="margin:0 0 12px;font-size:15px;line-height:24px">${escapeHTML(greeting)}</p>
          <p style="margin:0 0 20px;font-size:16px;line-height:26px;color:#46464f;overflow-wrap:anywhere">${escapeHTML(copy.intro)}</p>
          ${copy.details ? `<p style="margin:0 0 20px;font-size:14px;line-height:22px;color:#46464f">${escapeHTML(copy.details)}</p>` : ""}
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 18px"><tr><td align="center" bgcolor="#555994" style="border-radius:24px;mso-padding-alt:12px 24px">
            <a href="${escapeHTML(safeURL)}" style="display:inline-block;border:12px solid #555994;border-right-width:24px;border-left-width:24px;border-radius:24px;background:#555994;color:#ffffff;font-size:14px;line-height:20px;font-weight:700;text-align:center;text-decoration:none">${escapeHTML(copy.action)}</a>
          </td></tr></table>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px"><tr><td bgcolor="#e0e0ff" style="padding:8px 12px;border-radius:8px;font-size:13px;line-height:20px;color:#3d417b">${escapeHTML(copy.expiry)}</td></tr></table>
          <p style="margin:0;font-size:13px;line-height:21px;color:#46464f">${escapeHTML(copy.warning)}</p>
        </td></tr>
        <tr><td style="padding:20px 24px;border-top:1px solid #e4e1ec;background:#f6f2f7;border-radius:0 0 24px 24px">
          <p style="margin:0 0 8px;font-size:12px;line-height:19px;color:#46464f">${escapeHTML(copy.fallbackAction)}</p>
          <p style="margin:0;font-size:12px;line-height:19px;word-break:break-all;overflow-wrap:anywhere"><a href="${escapeHTML(safeURL)}" style="color:#555994;text-decoration:underline;word-break:break-all">${escapeHTML(safeURL)}</a></p>
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
      <p style="margin:18px 0 0;font-size:12px;line-height:20px;color:#777680"><a href="${siteURL}" style="color:#555994;text-decoration:none">Haneoka</a> &nbsp;/&nbsp; ${new URL(siteURL).hostname}</p>
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
