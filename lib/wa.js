const WA_TOKEN = process.env.WA_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN || '';
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID || '';

function waApiUrl() { return `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`; }

export async function waSend(payload) {
  const res = await fetch(waApiUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WA_TOKEN}` },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  if (!res.ok) console.error('WA send error', res.status, text);
  return { status: res.status, text };
}

export async function sendText(to, body) {
  return waSend({ messaging_product: 'whatsapp', to, type: 'text', text: { body } });
}

export async function sendButtons(to, text, buttons) {
  return waSend({ messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'button', body: { text }, action: { buttons } } });
}

export async function sendList(to, bodyText, buttonText, sectionTitle, rows, headerText, footerText) {
  const interactive = {
    type: 'list',
    body: { text: bodyText },
    action: { button: buttonText || 'Select', sections: [{ title: sectionTitle || 'Options', rows }] }
  };
  if (headerText) interactive.header = { type: 'text', text: headerText };
  if (footerText) interactive.footer = { text: footerText };
  return waSend({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
}

export async function sendImage(to, imageUrl, caption = '') {
  return waSend({ messaging_product: 'whatsapp', to, type: 'image', image: { link: imageUrl, caption } });
}

export async function sendImageByMediaId(to, mediaId, caption = '') {
  return waSend({ messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId, caption } });
}

// Send the 'order_review' template with a dynamic URL button.
// The template is configured with a URL like:
//   https://hunt-whatsappapi-...run.app/{{1}}
// so we pass only the path/query part (e.g. 'checkout/?u=...&t=...') as {{1}}.
export async function sendOrderReviewTemplate(to, urlForCheckout) {
  let pathParam = urlForCheckout || '';
  try {
    if (pathParam.startsWith('http://') || pathParam.startsWith('https://')) {
      const u = new URL(pathParam);
      pathParam = `${u.pathname.replace(/^\//, '')}${u.search}`;
    } else {
      // Trim leading slash if present so it fits '{{1}}' after the base URL
      pathParam = pathParam.replace(/^\//, '');
    }
  } catch (_) {
    // Fallback: best-effort, just strip leading slash
    pathParam = pathParam.replace(/^\//, '');
  }

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: 'order_review',
      language: { code: 'en' },
      components: [
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [
            { type: 'text', text: pathParam }
          ]
        }
      ]
    }
  };

  return waSend(payload);
}
