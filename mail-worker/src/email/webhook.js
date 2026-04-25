import emailUtils from '../utils/email-utils';

export function isWebhookEnabled(env) {
  return !!String(env?.EMAIL_WEBHOOK_URL || '').trim()
    && !!String(env?.EMAIL_WEBHOOK_SECRET || '').trim();
}

export async function forwardWorkerEmailToWebhook(message, env) {
  const rawContent = await readMessageRaw(message);
  const fromHeader = message?.headers?.get('from') || message?.headers?.get('From') || '';
  const messageId = message?.headers?.get('message-id') || message?.headers?.get('Message-ID') || `<${crypto.randomUUID()}@cloud-mail.local>`;
  const toAddr = String(message?.to || '').trim().toLowerCase();

  const payload = {
    message_id: String(messageId || '').trim(),
    to_addr: toAddr,
    raw_content: rawContent,
    from_addr: extractAddress(fromHeader)
  };

  console.log(`[Webhook] 准备发送(Email Event) -> to=${payload.to_addr || 'unknown'} message_id=${payload.message_id || 'unknown'}`);
  return await postEmailWebhook(env, payload);
}

async function postEmailWebhook(env, payload) {
  const url = resolveWebhookUrl(String(env?.EMAIL_WEBHOOK_URL || '').trim());
  if (!url) {
    throw new Error('EMAIL_WEBHOOK_URL 未配置');
  }

  console.log(`[Webhook] 开始请求 -> url=${url} to=${payload?.to_addr || 'unknown'} message_id=${payload?.message_id || 'unknown'}`);

  const timeoutMs = Number.parseInt(String(env?.EMAIL_WEBHOOK_TIMEOUT_MS || '10000'), 10) || 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('email-webhook-timeout'), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': String(env?.EMAIL_WEBHOOK_SECRET || '').trim()
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const bodyText = await resp.text();
    console.log(`[Webhook] 请求完成 -> status=${resp.status} ok=${resp.ok} to=${payload?.to_addr || 'unknown'} message_id=${payload?.message_id || 'unknown'}`);

    if (!resp.ok) {
      console.error(`[Webhook] 请求失败 -> status=${resp.status} body=${bodyText}`);
      throw new Error(`Webhook 请求失败: ${resp.status} ${bodyText}`);
    }

    try {
      const data = JSON.parse(bodyText || '{}');
      console.log(`[Webhook] 请求成功 -> response=${JSON.stringify(data)}`);
      return data;
    } catch (_) {
      console.log(`[Webhook] 请求成功 -> raw=${bodyText}`);
      return { success: true, raw: bodyText };
    }
  } finally {
    clearTimeout(timer);
  }
}

async function readMessageRaw(message) {
  try {
    const resp = new Response(message.raw);
    const rawBuffer = await resp.arrayBuffer();
    return await new Response(rawBuffer).text();
  } catch (_) {
    return buildFallbackRawEmail(message);
  }
}

function buildFallbackRawEmail(message) {
  const fromHeader = message?.headers?.get('from') || message?.headers?.get('From') || '';
  const subject = message?.headers?.get('subject') || message?.headers?.get('Subject') || '(无主题)';
  const messageId = message?.headers?.get('message-id') || message?.headers?.get('Message-ID') || `<${crypto.randomUUID()}@cloud-mail.local>`;
  const toAddr = String(message?.to || '').trim();

  return [
    `Message-ID: ${String(messageId || '').replace(/\r?\n/g, ' ').trim()}`,
    fromHeader ? `From: ${String(fromHeader).replace(/\r?\n/g, ' ').trim()}` : '',
    toAddr ? `To: ${String(toAddr).replace(/\r?\n/g, ' ').trim()}` : '',
    `Subject: ${String(subject || '(无主题)').replace(/\r?\n/g, ' ').trim()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    '',
    ''
  ].filter(Boolean).join('\r\n');
}

function resolveWebhookUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/api/webhook/email';
    }
    return url.toString();
  } catch (_) {
    return raw;
  }
}

function extractAddress(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  try {
    return emailUtils.getEmail(value) || value;
  } catch (_) {
    const m = value.match(/<([^>]+)>/);
    return m ? m[1].trim() : value;
  }
}
