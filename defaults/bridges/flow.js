(async function () {
  const job = window.__FLOW_JOB__;
  if (!job || !job.job_id) return;

  window.__FLOW_RESULTS__ = window.__FLOW_RESULTS__ || {};
  window.__FLOW_ACTIVE_JOB_ID__ = job.job_id;

  let finished = false;

  function reportResult(status, imageBase64, mimeType, errorMsg) {
    if (finished) return;
    finished = true;
    window.__FLOW_RESULTS__[job.job_id] = {
      job_id: job.job_id,
      token: job.token,
      status: status,
      image_base64: imageBase64 || null,
      mime_type: mimeType || null,
      error: errorMsg || null,
    };
    const cleanTitle = (document.title || 'Google Flow').replace(
      /^\[FLOW_BRIDGE:[^\]]+\]\s*/,
      ''
    );
    document.title = `[FLOW_BRIDGE:${job.job_id}:${status}] ${cleanTitle}`;
  }

  function isAuthScreen() {
    if (window.location.hostname === 'accounts.google.com') return true;
    const hasEmailInput = Boolean(document.querySelector('input[type="email"]'));
    const hasSignInLink = Boolean(
      document.querySelector('a[href*="accounts.google.com/ServiceLogin"]')
    );
    const hasPrompt = Boolean(findPromptInput());
    return (hasEmailInput || hasSignInLink) && !hasPrompt;
  }

  function findPromptInput() {
    const selectors = [
      'textarea[aria-label*="prompt" i]',
      'textarea[placeholder*="prompt" i]',
      'textarea[placeholder*="describe" i]',
      'textarea[placeholder*="create" i]',
      'textarea:not([disabled]):not([readonly])',
      '[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      '[role="textbox"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        return el;
      }
    }
    return null;
  }

  function setNativePromptValue(el, value) {
    el.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' })
      );
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = value;
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' })
      );
    }
  }

  function selectAspectRatioIfRequested(ratio) {
    if (!ratio) return;
    const candidates = Array.from(
      document.querySelectorAll('button, [role="option"], [role="radio"]')
    );
    for (const el of candidates) {
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (label.includes(ratio)) {
        el.click();
        return;
      }
    }
  }

  function findGenerateButton() {
    const buttons = Array.from(document.querySelectorAll('button'));
    const keywords = ['generate', 'create', 'run', 'send', 'gerar', 'criar'];
    for (const btn of buttons) {
      if (btn.disabled) continue;
      const text = (btn.getAttribute('aria-label') || btn.textContent || '')
        .trim()
        .toLowerCase();
      if (keywords.some((kw) => text.includes(kw))) {
        return btn;
      }
    }
    return document.querySelector('button[type="submit"]:not([disabled])');
  }

  function snapshotBaselineMedia() {
    const seen = new Set();
    for (const img of Array.from(document.querySelectorAll('img'))) {
      const src = img.currentSrc || img.src || '';
      if (src) seen.add(src);
    }
    return seen;
  }

  function findNewGeneratedMedia(baseline) {
    for (const img of Array.from(document.querySelectorAll('img'))) {
      const src = img.currentSrc || img.src || '';
      if (!src || baseline.has(src)) continue;
      if (img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256) {
        return { kind: 'img', el: img, src };
      }
    }
    for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
      if (canvas.width >= 256 && canvas.height >= 256) {
        if (!canvas.dataset.flowBaseline) {
          return { kind: 'canvas', el: canvas };
        }
      }
    }
    return null;
  }

  async function extractBase64(media) {
    if (media.kind === 'canvas') {
      const dataUrl = media.el.toDataURL('image/png');
      const idx = dataUrl.indexOf(',');
      return { base64: idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl, mime: 'image/png' };
    }

    try {
      const res = await fetch(media.src, { credentials: 'include' });
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
        reader.readAsDataURL(blob);
      });
      const idx = dataUrl.indexOf(',');
      return {
        base64: idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl,
        mime: blob.type || 'image/png',
      };
    } catch (_corsErr) {
      const canvas = document.createElement('canvas');
      canvas.width = media.el.naturalWidth;
      canvas.height = media.el.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas unavailable for image extraction');
      ctx.drawImage(media.el, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');
      const idx = dataUrl.indexOf(',');
      return { base64: idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl, mime: 'image/png' };
    }
  }

  try {
    if (isAuthScreen()) {
      reportResult(
        'AUTH_REQUIRED',
        null,
        null,
        'Sessão Google não autenticada na janela do Flow. Faça login na janela aberta e tente novamente.'
      );
      return;
    }

    const waitStart = Date.now();
    let promptEl = findPromptInput();
    while (!promptEl && Date.now() - waitStart < 15000) {
      if (isAuthScreen()) {
        reportResult(
          'AUTH_REQUIRED',
          null,
          null,
          'Sessão Google não autenticada na janela do Flow. Faça login na janela aberta e tente novamente.'
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
      promptEl = findPromptInput();
    }

    if (!promptEl) {
      reportResult(
        'ERROR',
        null,
        null,
        'Campo de prompt do Google Flow não encontrado na página.'
      );
      return;
    }

    for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
      if (canvas.width >= 256 && canvas.height >= 256) {
        canvas.dataset.flowBaseline = '1';
      }
    }
    const baseline = snapshotBaselineMedia();

    selectAspectRatioIfRequested(job.aspect_ratio);
    setNativePromptValue(promptEl, job.prompt);
    await new Promise((r) => setTimeout(r, 150));

    const submitBtn = findGenerateButton();
    if (submitBtn) {
      submitBtn.click();
    } else {
      promptEl.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })
      );
    }

    const timeoutMs = Number(job.timeout_ms) > 0 ? Number(job.timeout_ms) : 90000;
    const deadline = Date.now() + timeoutMs;

    const media = await new Promise((resolve, reject) => {
      let observer = null;
      let timer = null;

      const cleanup = () => {
        if (observer) observer.disconnect();
        if (timer) clearInterval(timer);
      };

      const check = () => {
        if (finished) {
          cleanup();
          return;
        }
        if (isAuthScreen()) {
          cleanup();
          reject(new Error('AUTH_REQUIRED'));
          return;
        }
        const found = findNewGeneratedMedia(baseline);
        if (found) {
          cleanup();
          resolve(found);
          return;
        }
        if (Date.now() > deadline) {
          cleanup();
          reject(new Error('Timeout aguardando imagem gerada no Google Flow.'));
        }
      };

      observer = new MutationObserver(() => check());
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      timer = setInterval(check, 500);
      check();
    });

    const extracted = await extractBase64(media);
    reportResult('OK', extracted.base64, extracted.mime, null);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    if (msg === 'AUTH_REQUIRED') {
      reportResult(
        'AUTH_REQUIRED',
        null,
        null,
        'Sessão Google não autenticada na janela do Flow. Faça login na janela aberta e tente novamente.'
      );
    } else {
      reportResult('ERROR', null, null, msg);
    }
  }
})();
