// ==UserScript==
// @name         Enrich & Send (Userscript — your code, only 2 changes)
// @namespace    https://realcustomai.online/
// @version      1.1.1
// @description  원본 content.js 동작(엔터 가로채기→API 보강→붙여넣기→전송) 그대로. 변경은 GM_xmlhttpRequest와 401 로그인 탭 오픈 딱 두 가지.
// @match        https://chatgpt.com/*
// @match        https://gemini.google.com/*
// @match        https://x.com/i/grok*
// @match        https://grok.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      realcustomai.online
// @noframes
// ==/UserScript==
/* globals GM_xmlhttpRequest */

(function () {
  "use strict";

  /***** 설정 (지연 단축 + 버튼 제거 버전) — 원본 유지 *****/
  const API_BASE   = "https://realcustomai.online";
  const API_URL    = `${API_BASE}/api/recommend`;
  const LOGIN_URL  = `${API_BASE}/`; // 401이면 여기 띄움

  // ▼ 속도 관련
  const TIMEOUT_MS     = 6000;
  const SEND_DELAY_MS  = 0;

  // ▼ 길이 조건
  const MIN_LEN        = 10;
  const MAX_LEN        = 1000;

  const SHOW_LOG       = true;

  let isProcessing = false;
  let boundTextbox = null;
  let sendBtnBackup = null;
  // synthetic keydown 무시용
  let ignoreSyntheticUntil = 0;

  const log = (...a) => SHOW_LOG && console.log("[US]", ...a);

  /***** 유틸 *****/
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      promise.then(v => { clearTimeout(t); resolve(v); })
             .catch(e => { clearTimeout(t); reject(e); });
    });
  }
  function showToast(msg, type="info", ttl=1500) {
    try {
      const el = document.createElement("div");
      el.textContent = msg;
      el.style.cssText = `
        position: fixed; z-index: 2147483647;
        bottom: 20px; left: 50%; transform: translateX(-50%);
        background: ${type==="error"?"#ef4444":type==="success"?"#22c55e":"#334155"};
        color: #fff; padding: 8px 12px; border-radius: 10px;
        font: 13px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        box-shadow: 0 6px 16px rgba(0,0,0,.2); opacity: .97;
      `;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), ttl);
    } catch {}
  }
  function isVisible(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    if (el.offsetParent === null && cs.position !== "fixed") return false;
    return true;
  }
  function normalizeNl(s) { return (s ?? "").replace(/\r\n/g, "\n"); }

  /** 텍스트 적용 안정 대기 */
  async function waitTextApplied(el, expected, opt = {}) {
    const maxWait   = opt.maxWait   ?? 600;
    const settle    = opt.settle    ?? 64;
    const interval  = opt.interval  ?? 16;
    const minWait   = opt.minWait   ?? 50;

    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (minWait > 0) await sleep(minWait);

    const want = normalizeNl(expected);
    const t0 = performance.now();
    let stableFor = 0;

    while (performance.now() - t0 < maxWait) {
      const cur = normalizeNl(readTextboxValue(el));
      if (cur === want) {
        stableFor += interval;
        if (stableFor >= settle) {
          return { ok: true, elapsedMs: performance.now() - t0, stableForMs: stableFor };
        }
      } else {
        stableFor = 0;
      }
      await sleep(interval);
    }
    return { ok: false, elapsedMs: performance.now() - t0, stableForMs: stableFor };
  }

  /*** 값 읽기/쓰기 — 원본 유지(※ input[type="text"] 확장 없음) ***/
  function readTextboxValue(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA") return el.value;
    if (el.getAttribute("contenteditable") === "true") return el.innerText || "";
    return "";
  }
  function writeTextboxValue(el, text) {
    if (!el) return;

    if (el.tagName === "TEXTAREA") {
      el.value = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (el.getAttribute("contenteditable") === "true") {
      el.focus();
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
      } catch (_) {
        el.textContent = text;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    try { el.textContent = text; } catch {}
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /*** 주변 탐색 유틸(텍스트박스 기준 상위→자손) ***/
  function queryNear(el, selector, depth=6) {
    let p = el;
    for (let i=0; i<depth && p; i++, p = p.parentElement) {
      const cand = Array.from(p.querySelectorAll(selector)).find(isVisible);
      if (cand) return cand;
    }
    return null;
  }

  // Grok 중복 클릭 가드 (0.8초)
  let grokSendLock = false;
  const GROK_CLICK_GUARD_MS = 800;

  /***** 사이트 어댑터 레이어 — 원본 유지 *****/
  const adapters = [
    {
      id: "chatgpt",
      test: (u) => u.hostname === "chatgpt.com",
      findTextbox() { return document.querySelector('textarea[data-testid="prompt-textarea"]'); },
      findSendButton() { return document.querySelector('button[data-testid="send-button"]'); },
      triggerSend(textbox) {
        const btn = this.findSendButton();
        if (btn) {
          ["pointerdown","mousedown","pointerup","mouseup","click"]
            .forEach(t => btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window })));
          return true;
        }
        return false;
      }
    },

    /* ==== 제미니: 텍스트박스 근처 '보내기/전송/Send' 탐색 + '공유' 제외 ==== */
    {
      id: "gemini",
      test: (u) => u.hostname === "gemini.google.com",
      findTextbox() {
        const t = Array.from(document.querySelectorAll('textarea, div[contenteditable="true"]'))
          .find(el => isVisible(el) && (el.tagName === "TEXTAREA" || el.getAttribute("contenteditable")==="true"));
        return t || null;
      },
      findSendButton() {
        const tb = this.findTextbox();
        if (!tb) return null;

        // 1) aria-label 기반(공유 제외)
        const sel = [
          'button[aria-label*="보내"]',
          'button[aria-label*="전송"]',
          'button[aria-label*="Send"]',
          '[role="button"][aria-label*="보내"]',
          '[role="button"][aria-label*="전송"]',
          '[role="button"][aria-label*="Send"]'
        ].join(',');
        let btn = queryNear(tb, sel, 6);
        if (btn) {
          const label = (btn.getAttribute('aria-label')||btn.textContent||'').trim();
          if (/(공유|share)/i.test(label)) btn = null;
        }

        // 2) 툴바/푸터의 마지막 버튼(대개 보내기) 시도
        if (!btn) {
          const toolbar = queryNear(tb, 'footer,div[role="toolbar"],div[aria-label*="도구"],div[aria-label*="툴바"]', 6);
          if (toolbar) {
            const btns = Array.from(toolbar.querySelectorAll('button,[role="button"]')).filter(isVisible);
            const filtered = btns.filter(b => !/(공유|share)/i.test((b.getAttribute('aria-label')||b.textContent||'').trim()));
            btn = filtered.at(-1) || null;
          }
        }

        return btn || null;
      },
      triggerSend(textbox) {
        // 1) 클릭 우선(가장 안전)
        const btn = this.findSendButton();
        if (btn) {
          ["pointerdown","mousedown","pointerup","mouseup","click"]
            .forEach(t => btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window })));
          return true;
        }
        // 2) form submit 폴백
        const form = textbox?.closest?.('form');
        if (form && typeof form.requestSubmit === 'function') {
          form.requestSubmit();
          return true;
        }
        // 3) 최후 수단: 키 폴백(신뢰도 낮음)
        if (textbox) {
          ignoreSyntheticUntil = performance.now() + 200;
          const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" });
          textbox.dispatchEvent(ev);
          return true;
        }
        return false;
      }
    },

    {
      /* ==== Grok: 원클릭 + 락 ==== */
      id: "grok",
      test: (u) => (u.hostname === "x.com" && u.pathname.startsWith("/i/grok")) || u.hostname === "grok.com",

      // contenteditable 우선 + textarea 폴백
      findTextbox() {
        const cand = Array.from(document.querySelectorAll(
          'div[role="textbox"][contenteditable="true"], div[contenteditable="true"], textarea'
        )).find(isVisible);
        return cand || null;
      },

      // Ask/Ask Grok/Send/전송/보내기 + data-testid 휴리스틱 (텍스트박스 근처 우선)
      findSendButton() {
        const tb = this.findTextbox();
        const scope = tb ? (tb.closest('[role="dialog"], [data-testid], form, section, main') || document) : document;

        const selectors = [
          'button[aria-label*="Ask Grok"]', '[role="button"][aria-label*="Ask Grok"]',
          'button[aria-label*="Ask"]',      '[role="button"][aria-label*="Ask"]',
          'button[aria-label*="Send" i]',   '[role="button"][aria-label*="Send" i]',
          'button[aria-label*="전송"]',      '[role="button"][aria-label*="전송"]',
          'button[aria-label*="보내기"]',    '[role="button"][aria-label*="보내기"]',
          '[data-testid*="grok"][role="button"]', 'button[data-testid*="grok"]',
          'div[role="toolbar"] button:last-child', 'footer button:last-child'
        ];

        for (const sel of selectors) {
          const btn = Array.from(scope.querySelectorAll(sel)).find(isVisible);
          if (btn) return btn;
        }

        const allBtns = Array.from(scope.querySelectorAll('button,[role="button"]'))
          .filter(isVisible)
          .filter(b => {
            const t = (b.getAttribute('aria-label') || b.textContent || '').trim();
            return /(ask|send|전송|보내기|grok)/i.test(t);
          });
        return allBtns.at(-1) || null;
      },

      triggerSend(textbox) {
        // 중복 클릭 가드
        if (grokSendLock) return true;

        const btn = this.findSendButton();
        if (btn) {
          // ★ 한 번만, 순수 click 만 보냄 (mousedown/up 등 금지)
          grokSendLock = true;
          if (typeof btn.click === "function") btn.click();
          else btn.dispatchEvent(new MouseEvent("click", { bubbles:true, cancelable:true, view:window }));

          setTimeout(() => { grokSendLock = false; }, GROK_CLICK_GUARD_MS);
          return true;
        }

        // form 폴백
        const form = textbox?.closest?.('form');
        if (form && typeof form.requestSubmit === 'function') {
          form.requestSubmit();
          return true;
        }

        // 버튼이 아예 안 보일 때만 키 시퀀스 폴백
        if (textbox) {
          simulateEnter(textbox);
          return true;
        }
        return false;
      }
    }
  ];

  function pickAdapter() {
    const u = new URL(location.href);
    return adapters.find(a => a.test(u)) || null;
  }
  const activeAdapter = pickAdapter();

  /*** 전송 버튼 잠금/해제 (제미니는 포커스 점프 방지 위해 비활성) ***/
  function lockSendButton(lock) {
    if (activeAdapter?.id === "gemini") return; // 🔒 제미니에서는 잠금 비활성
    const btn = findSendButton();
    if (!btn) return;
    if (lock) {
      if (!sendBtnBackup) {
        sendBtnBackup = {
          disabled: btn.disabled,
          pe: btn.style.pointerEvents || "",
          title: btn.getAttribute("title")
        };
      }
      btn.disabled = true;
      btn.style.pointerEvents = "none";
      btn.setAttribute("title", "확장 보강 중…");
    } else {
      if (sendBtnBackup) {
        btn.disabled = sendBtnBackup.disabled;
        btn.style.pointerEvents = sendBtnBackup.pe;
        if (sendBtnBackup.title == null) btn.removeAttribute("title");
        else btn.setAttribute("title", sendBtnBackup.title);
        sendBtnBackup = null;
      } else {
        btn.disabled = false;
        btn.style.pointerEvents = "";
        btn.removeAttribute("title");
      }
    }
  }

  /*** 요소 탐색 (어댑터 우선 → 공통 폴백) ***/
  function findTextbox() {
    if (activeAdapter?.findTextbox) {
      const el = activeAdapter.findTextbox();
      if (el) return el;
    }
    let el = Array.from(document.querySelectorAll('div[contenteditable="true"]')).find(isVisible);
    if (el) return el;
    el = Array.from(document.querySelectorAll('[role="textbox"] div[contenteditable="true"]')).find(isVisible);
    if (el) return el;
    el = Array.from(document.querySelectorAll('textarea')).find(isVisible);
    if (el) return el;
    el = Array.from(document.querySelectorAll('textarea[data-testid="prompt-textarea"]')).find(isVisible);
    return el || null;
  }
  function findSendButton() {
    if (activeAdapter?.findSendButton) {
      const b = activeAdapter.findSendButton();
      if (b) return b;
    }
    let btn = document.querySelector('button[data-testid="send-button"]');
    if (btn && isVisible(btn)) return btn;
    btn = Array.from(document.querySelectorAll('button[aria-label]'))
      .find(b => isVisible(b) && /send|전송|보내기/i.test(b.getAttribute('aria-label')||""));
    if (btn) return btn;
    btn = Array.from(document.querySelectorAll('button'))
      .find(b => isVisible(b) && /send|전송|보내기/i.test((b.textContent||"")));
    return btn || null;
  }

  /*** API 호출 — (변경 1) 원본 fetch/chrome.runtime → GM_xmlhttpRequest ***/
  async function callApiRaw(query) {
    const payload = {
      query,
      context: {
        source: "chrome-ext", // 원본 표기로 유지
        page_url: location.href,
        lang: document.documentElement.lang || "ko",
        length: query.length
      }
    };

    return new Promise((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut=true; reject(new Error("timeout")); }, TIMEOUT_MS);

      GM_xmlhttpRequest({
        method: "POST",
        url: API_URL,
        headers: {
          "Content-Type": "application/json",
          "Accept": "*/*",
          "X-From-Extension": "1"
        },
        data: JSON.stringify(payload),
        withCredentials: true,
        onload: (res) => {
          if (timedOut) return; clearTimeout(timer);
          try {
            // (변경 2) 401 → 로그인 탭 오픈
            if (res.status === 401) {
              window.open(LOGIN_URL, "_blank", "noopener");
              reject(new Error("auth_needed"));
              return;
            }
            if (res.status < 200 || res.status >= 300) {
              reject(new Error(`api_${res.status}:${res.responseText || ""}`));
              return;
            }

            const isJson = (res.responseHeaders || "").toLowerCase().includes("application/json");
            if (isJson) {
              const j = JSON.parse(res.responseText || "null");
              if (j && typeof j.finalText === "string") { resolve(j.finalText); return; }
              if (typeof j === "string") { resolve(j); return; }
              resolve(JSON.stringify(j ?? "")); return;
            }
            resolve(res.responseText || "");
          } catch (e) {
            reject(new Error(String(e)));
          }
        },
        onerror: () => { if (!timedOut) { clearTimeout(timer); reject(new Error("network_error")); } },
        ontimeout: () => { if (!timedOut) { clearTimeout(timer); reject(new Error("timeout")); } }
      });
    });
  }

  /*** 네이티브 전송 트리거(어댑터 우선 → 공통 폴백 + form 폴백) ***/
  function simulateEnter(el) {
    if (!el) return false;
    const combos = [{}, { ctrlKey: true }, { metaKey: true }];
    for (const mod of combos) {
      ["keydown","keypress","keyup"].forEach(type => {
        const ev = new KeyboardEvent(type, {
          bubbles: true, cancelable: true,
          key: "Enter", code: "Enter",
          ctrlKey: !!mod.ctrlKey, metaKey: !!mod.metaKey
        });
        el.dispatchEvent(ev);
      });
    }
    return true;
  }
  async function triggerSend(textbox) {
    if (activeAdapter?.triggerSend && activeAdapter.triggerSend(textbox)) return;

    // 공통: form 폴백
    const form = textbox?.closest?.('form');
    if (form && typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return;
    }

    // 최후 수단: 엔터 폴백
    if (textbox) {
      ignoreSyntheticUntil = performance.now() + 200;
      const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" });
      textbox.dispatchEvent(ev);
    }
  }

  /*** 메인 플로우 — 원본 유지 ***/
  async function processAndSend() {
    const textbox = boundTextbox || findTextbox();
    if (!textbox) { showToast("입력창을 못 찾았어요.", "error"); return; }

    const original = (readTextboxValue(textbox) || "").trim();
    if (!original) { await triggerSend(textbox); return; }

    const len = original.length;
    if (len < MIN_LEN || len > MAX_LEN) {
      showToast("길이 범위 밖 — 원문만 전송", "info", 900);
      await triggerSend(textbox);
      return;
    }

    if (isProcessing) return;
    isProcessing = true;
    lockSendButton(true);
    showToast("보강 중…", "info", TIMEOUT_MS);

    try {
      const serverText = await withTimeout(callApiRaw(original), TIMEOUT_MS);

      // 1) 텍스트 교체
      writeTextboxValue(textbox, serverText);

      // 2-A) 값 반영 완료 확인
      const stabilize = await waitTextApplied(textbox, serverText, {
        maxWait: 600,
        settle: 64,
        interval: 16,
        minWait: 50
      });

      // 2-B) 적응형 추가 지연
      if (!stabilize.ok || stabilize.elapsedMs > 200) {
        await sleep(120);
      } else if (SEND_DELAY_MS > 0) {
        await sleep(SEND_DELAY_MS);
      }

      // 3) 포커스 보정 + 언락
      textbox.focus(); // ✅ 전송 직전 포커스 복구
      lockSendButton(false);

      // 4) 전송
      await triggerSend(textbox);

      showToast("전송됨", "success", 1000);
    } catch (e) {
      log("API/auth fail or timeout", e);
      lockSendButton(false);
      if (String(e).includes("auth_needed")) {
        showToast("사이트를 열었습니다. 로그인 후 다시 전송하세요.", "info", 2000);
      } else if (String(e).includes("timeout")) {
        showToast("응답 지연 — 원문만 전송", "error", 1500);
        await triggerSend(textbox);
      } else {
        showToast("보강 실패 — 원문만 전송", "error", 1200);
        await triggerSend(textbox);
      }
    } finally {
      setTimeout(() => { isProcessing = false; }, 200);
    }
  }

  /*** 키보드 바인딩(Enter, Cmd/Ctrl+Enter — Shift+Enter는 줄바꿈 유지) ***/
  function bindTextbox(el) {
    if (!el || el.__extBound || !isVisible(el)) return;
    el.__extBound = true;

    ["keydown", "keypress", "keyup"].forEach((evName) => {
      el.addEventListener(evName, (e) => {
        if (!e.isTrusted || performance.now() < ignoreSyntheticUntil) return;
        if (e.isComposing) return;

        const isEnter = (e.key === "Enter");
        const isPlain = isEnter && !(e.shiftKey || e.altKey || e.metaKey || e.ctrlKey);
        const isCmdCtl = isEnter && (e.metaKey || e.ctrlKey);
        if (!isPlain && !isCmdCtl) return;

        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();

        if (isProcessing) return;
        if (evName === "keydown") processAndSend();
      }, true);
    });
    boundTextbox = el;
    log("textbox bound (visible)", el);
  }

  /*** DOM 감시 + 초기화 ***/
  const obs = new MutationObserver(() => {
    if (!activeAdapter) return;
    const tb = findTextbox(); if (tb) bindTextbox(tb);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  (function init() {
    log("userscript loaded");
    if (!activeAdapter) {
      log("no adapter for this url; noop");
      return;
    }
    const tb = findTextbox(); if (tb) bindTextbox(tb);
  })();
})();
