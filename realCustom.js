// ==UserScript==
// @name         RealCustomAI Enrich & Send (Debug Version)
// @namespace    https://realcustomai.online/
// @version      1.1.2-debug
// @description  원본 content.js 동작(엔터 가로채기→API 보강→붙여넣기→전송) 그대로 작동하면서 디버깅 로그를 추가한 버전입니다.
//               GM_xmlhttpRequest 사용과 401 응답시 로그인 탭을 여는 변경 사항을 포함합니다.
//               문제 발생 시 콘솔의 [RC-DEBUG] 로그를 확인하세요.
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

/*
 * 이 스크립트는 RealCustom AI 추천 API를 호출하여 입력된 프롬프트를 보강한 뒤
 * 다시 입력창에 붙여넣고 전송해주는 기능을 제공합니다. 디버깅을 위해 곳곳에
 * 상세한 로그를 추가했습니다. 문제 발생 시 브라우저 콘솔의 [RC-DEBUG] 메시지를 참고하세요.
 */

(function () {
  "use strict";

  /******************************************************************************/
  /*                                환경 설정                                    */
  /******************************************************************************/
  const API_BASE   = "https://realcustomai.online";
  const API_URL    = `${API_BASE}/api/recommend`;
  const LOGIN_URL  = `${API_BASE}/`;

  // 속도 관련 설정
  const TIMEOUT_MS     = 6000;    // 서버 응답 타임아웃(ms)
  const SEND_DELAY_MS  = 0;       // 기본 지연(ms) - 값 반영 안정화 지연 외에 추가 지연이 필요하다면 조정

  // 길이 조건: 이 범위를 벗어나면 원본을 그대로 전송합니다.
  const MIN_LEN        = 10;
  const MAX_LEN        = 1000;

  // true로 설정하면 디버그 로그를 콘솔에 출력합니다.
  const SHOW_LOG       = true;

  // 내부 상태 플래그
  let isProcessing = false;
  let boundTextbox = null;
  let sendBtnBackup = null;
  let ignoreSyntheticUntil = 0;

  /**
   * 디버깅용 로그 함수.
   * @param {...any} args 출력할 값
   */
  function logDebug(...args) {
    if (!SHOW_LOG) return;
    try {
      console.log('[RC-DEBUG]', ...args);
    } catch (_) {
      // 콘솔에 출력할 수 없는 경우는 무시
    }
  }

  /******************************************************************************/
  /*                                유틸리티 함수                                 */
  /******************************************************************************/
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

  /**
   * 지정된 시간 안에 완료되지 않으면 거부하는 Promise 래퍼
   * @param {Promise<any>} promise 처리할 프로미스
   * @param {number} ms 타임아웃(ms)
   */
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      promise.then(v => { clearTimeout(t); resolve(v); })
             .catch(e => { clearTimeout(t); reject(e); });
    });
  }

  /**
   * 화면 하단에 간단한 토스트 메시지를 표시합니다.
   * 오류가 발생하거나 정보 알림이 필요할 때 사용합니다.
   */
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
    } catch (e) {
      // 토스트 생성 실패 시 무시
      logDebug('Toast creation failed', e);
    }
  }

  /**
   * 요소가 화면에 보이는지 여부를 판정합니다.
   * @param {Element} el 검사할 요소
   */
  function isVisible(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    if (el.offsetParent === null && cs.position !== "fixed") return false;
    return true;
  }

  /**
   *
\n 및 \r\n을 \n으로 통일합니다.
   * @param {string} s 문자열
   */
  function normalizeNl(s) { return (s ?? "").replace(/\r\n/g, "\n"); }

  /**
   * 값 쓰기 이후 DOM에 안정적으로 반영되었는지 기다립니다.
   * 타이밍 문제로 값이 교체되고 바로 전송하면 실제 UI에 반영되지 않는 경우가 있기 때문에
   * 짧게 확인합니다.
   * @param {Element} el 텍스트 박스 요소
   * @param {string} expected 기대되는 텍스트
   * @param {Object} opt 옵션: maxWait, settle, interval, minWait
   */
  async function waitTextApplied(el, expected, opt = {}) {
    const maxWait   = opt.maxWait   ?? 600;
    const settle    = opt.settle    ?? 64;
    const interval  = opt.interval  ?? 16;
    const minWait   = opt.minWait   ?? 50;

    // 최초 두 프레임 + 최소 대기
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
          logDebug('waitTextApplied: value stabilized', {elapsedMs: performance.now() - t0, stableForMs: stableFor});
          return { ok: true, elapsedMs: performance.now() - t0, stableForMs: stableFor };
        }
      } else {
        stableFor = 0;
      }
      await sleep(interval);
    }
    logDebug('waitTextApplied: value did not stabilize', {elapsedMs: performance.now() - t0, stableForMs: stableFor});
    return { ok: false, elapsedMs: performance.now() - t0, stableForMs: stableFor };
  }

  /**
   * 텍스트 박스의 현재 값을 읽어 반환합니다.
   * textarea 또는 contenteditable 노드 모두 지원합니다.
   * @param {Element|null} el 대상 요소
   */
  function readTextboxValue(el) {
    if (!el) return "";
    try {
      if (el.tagName === "TEXTAREA") return el.value;
      if (el.getAttribute("contenteditable") === "true") return el.innerText || "";
    } catch (e) {
      logDebug('readTextboxValue error', e);
    }
    return "";
  }

  /**
   * 텍스트 박스에 텍스트를 씁니다. textarea와 contenteditable을 모두 지원합니다.
   * 작성 후 input/change 이벤트를 발생시켜 React 등 프레임워크가 변화를 감지하도록 합니다.
   * @param {Element|null} el 대상 요소
   * @param {string} text 입력할 텍스트
   */
  function writeTextboxValue(el, text) {
    if (!el) return;
    logDebug('writeTextboxValue called', {tag: el.tagName, contenteditable: el.getAttribute('contenteditable'), text});
    try {
      if (el.tagName === "TEXTAREA") {
        el.value = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      if (el.getAttribute("contenteditable") === "true") {
        el.focus();
        try {
          // 모든 내용을 선택하고 새 텍스트를 삽입합니다. 일부 사이트에서는 execCommand가 막혀있을 수 있음
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
        } catch (_) {
          el.textContent = text;
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      // 기타 요소에 대해서는 textContent를 사용합니다.
      try { el.textContent = text; } catch {}
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      logDebug('writeTextboxValue error', e);
    }
  }

  /**
   * 텍스트 박스 주변에서 선택자에 맞는 요소를 찾습니다.
   * 주어진 깊이까지 상위 노드를 탐색하며, 각 상위 노드 내에서 자손을 찾습니다.
   * @param {Element|null} el 시작 요소
   * @param {string} selector CSS 선택자
   * @param {number} depth 탐색할 상위 깊이 (기본 6)
   */
  function queryNear(el, selector, depth=6) {
    let p = el;
    for (let i=0; i<depth && p; i++, p = p.parentElement) {
      const cand = Array.from(p.querySelectorAll(selector)).find(isVisible);
      if (cand) return cand;
    }
    return null;
  }

  /**
   * 페이지에서 지원되는 사이트인지 판별하여 어댑터를 선택합니다.
   */
  function pickAdapter() {
    const u = new URL(location.href);
    return adapters.find(a => a.test(u)) || null;
  }

  /******************************************************************************/
  /*                            사이트별 어댑터 정의                               */
  /******************************************************************************/
  // Grok 중복 클릭 가드 (0.8초)
  let grokSendLock = false;
  const GROK_CLICK_GUARD_MS = 800;

  const adapters = [
    {
      id: "chatgpt",
      test: (u) => u.hostname === "chatgpt.com",
      findTextbox() { return document.querySelector('textarea[data-testid="prompt-textarea"]'); },
      findSendButton() { return document.querySelector('button[data-testid="send-button"]'); },
      triggerSend(textbox) {
        const btn = this.findSendButton();
        if (btn) {
          ["pointerdown","mousedown","pointerup","mouseup","click"].forEach(t => btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true })));
          logDebug('triggerSend(chatgpt): clicked send button');
          return true;
        }
        return false;
      }
    },
    {
      /* 제미니: 텍스트박스 근처에서 '보내기/전송/Send' 탐색 + '공유' 제외 */
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
        // 2) 툴바/푸터의 마지막 버튼 시도
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
        const btn = this.findSendButton();
        if (btn) {
          ["pointerdown","mousedown","pointerup","mouseup","click"].forEach(t => btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true })));
          logDebug('triggerSend(gemini): clicked send button');
          return true;
        }
        const form = textbox?.closest?.('form');
        if (form && typeof form.requestSubmit === 'function') {
          form.requestSubmit();
          logDebug('triggerSend(gemini): submitted form fallback');
          return true;
        }
        if (textbox) {
          simulateEnter(textbox);
          logDebug('triggerSend(gemini): simulated enter fallback');
          return true;
        }
        return false;
      }
    },
    {
      /* Grok: 다양한 사이트에서 실행되는 경우를 포함하여 버튼을 휴리스틱으로 탐색 */
      id: "grok",
      test: (u) => (u.hostname === "x.com" && u.pathname.startsWith("/i/grok")) || u.hostname === "grok.com",
      findTextbox() {
        const cand = Array.from(document.querySelectorAll(
          'div[role="textbox"][contenteditable="true"], div[contenteditable="true"], textarea'
        )).find(isVisible);
        return cand || null;
      },
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
        if (grokSendLock) {
          logDebug('triggerSend(grok): send locked');
          return true;
        }
        const btn = this.findSendButton();
        if (btn) {
          grokSendLock = true;
          if (typeof btn.click === 'function') btn.click();
          else btn.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true }));
          logDebug('triggerSend(grok): clicked send button');
          setTimeout(() => { grokSendLock = false; }, GROK_CLICK_GUARD_MS);
          return true;
        }
        const form = textbox?.closest?.('form');
        if (form && typeof form.requestSubmit === 'function') {
          form.requestSubmit();
          logDebug('triggerSend(grok): submitted form fallback');
          return true;
        }
        if (textbox) {
          simulateEnter(textbox);
          logDebug('triggerSend(grok): simulated enter fallback');
          return true;
        }
        return false;
      }
    }
  ];

  // 현재 페이지에 대응되는 어댑터를 저장합니다.
  const activeAdapter = pickAdapter();

  /******************************************************************************/
  /*                           보조 동작: 전송 버튼 락/언락                       */
  /******************************************************************************/
  /**
   * 전송 버튼을 잠그거나 해제합니다. 작업 중에는 버튼을 비활성화하여 중복 전송을 방지합니다.
   * 제미니에서는 포커스가 이동하는 문제가 있어 잠금 기능을 사용하지 않습니다.
   * @param {boolean} lock 잠금 여부
   */
  function lockSendButton(lock) {
    if (activeAdapter?.id === 'gemini') return;
    const btn = findSendButton();
    if (!btn) return;
    if (lock) {
      if (!sendBtnBackup) {
        sendBtnBackup = {
          disabled: btn.disabled,
          pe: btn.style.pointerEvents || '',
          title: btn.getAttribute('title')
        };
      }
      btn.disabled = true;
      btn.style.pointerEvents = 'none';
      btn.setAttribute('title', '확장 보강 중…');
      logDebug('lockSendButton: button locked');
    } else {
      if (sendBtnBackup) {
        btn.disabled = sendBtnBackup.disabled;
        btn.style.pointerEvents = sendBtnBackup.pe;
        if (sendBtnBackup.title == null) btn.removeAttribute('title');
        else btn.setAttribute('title', sendBtnBackup.title);
        sendBtnBackup = null;
      } else {
        btn.disabled = false;
        btn.style.pointerEvents = '';
        btn.removeAttribute('title');
      }
      logDebug('lockSendButton: button unlocked');
    }
  }

  /******************************************************************************/
  /*                            공통 요소 탐색 함수                                */
  /******************************************************************************/
  function findTextbox() {
    if (activeAdapter?.findTextbox) {
      try {
        const el = activeAdapter.findTextbox();
        if (el) return el;
      } catch (e) {
        logDebug('findTextbox adapter error', e);
      }
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
      try {
        const b = activeAdapter.findSendButton();
        if (b) return b;
      } catch (e) {
        logDebug('findSendButton adapter error', e);
      }
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

  /******************************************************************************/
  /*                          API 호출 (GM_xmlhttpRequest)                       */
  /******************************************************************************/
  /**
   * 서버에 프롬프트를 보내고 보강된 텍스트를 받아옵니다.
   * GM_xmlhttpRequest를 사용해 CORS 제약을 우회합니다. 401 응답이 오면 로그인 탭을 띄우고 예외를 던집니다.
   * @param {string} query 사용자가 입력한 프롬프트
   * @returns {Promise<string>} 보강된 텍스트
   */
  async function callApiRaw(query) {
    const payload = {
      query,
      context: {
        source: "chrome-ext", // 원본 표기
        page_url: location.href,
        lang: document.documentElement.lang || "ko",
        length: query.length
      }
    };
    logDebug('callApiRaw: sending to API', { url: API_URL, payload });
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut=true; reject(new Error('timeout')); }, TIMEOUT_MS);
      try {
        GM_xmlhttpRequest({
          method: 'POST',
          url: API_URL,
          headers: {
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'X-From-Extension': '1'
          },
          data: JSON.stringify(payload),
          withCredentials: true,
          onload: (res) => {
            if (timedOut) return; clearTimeout(timer);
            try {
              logDebug('callApiRaw: response received', {status: res.status, responseHeaders: res.responseHeaders, responseText: res.responseText});
              if (res.status === 401) {
                window.open(LOGIN_URL, '_blank', 'noopener');
                reject(new Error('auth_needed'));
                return;
              }
              if (res.status < 200 || res.status >= 300) {
                reject(new Error(`api_${res.status}:${res.responseText || ''}`));
                return;
              }
              const isJson = (res.responseHeaders || '').toLowerCase().includes('application/json');
              if (isJson) {
                const j = JSON.parse(res.responseText || 'null');
                if (j && typeof j.finalText === 'string') { resolve(j.finalText); return; }
                if (typeof j === 'string') { resolve(j); return; }
                resolve(JSON.stringify(j ?? ''));
                return;
              }
              resolve(res.responseText || '');
            } catch (e) {
              reject(new Error(String(e)));
            }
          },
          onerror: () => {
            if (!timedOut) {
              clearTimeout(timer);
              reject(new Error('network_error'));
            }
          },
          ontimeout: () => {
            if (!timedOut) {
              clearTimeout(timer);
              reject(new Error('timeout'));
            }
          }
        });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /******************************************************************************/
  /*                 키보드 이벤트 및 전송 트리거 함수 정의                       */
  /******************************************************************************/
  /**
   * 엔터 키를 직접 시뮬레이션합니다. 일부 사이트에서 폼 제출 이벤트를 트리거하기 위한 폴백입니다.
   * @param {Element} el 텍스트 박스 요소
   */
  function simulateEnter(el) {
    if (!el) return false;
    const combos = [{}, { ctrlKey: true }, { metaKey: true }];
    for (const mod of combos) {
      ['keydown','keypress','keyup'].forEach(type => {
        const ev = new KeyboardEvent(type, {
          bubbles: true, cancelable: true,
          key: 'Enter', code: 'Enter',
          ctrlKey: !!mod.ctrlKey, metaKey: !!mod.metaKey
        });
        el.dispatchEvent(ev);
      });
    }
    return true;
  }

  /**
   * 지정된 텍스트 박스에 대해 네이티브 전송을 트리거합니다.
   * 어댑터가 정의한 triggerSend를 우선 사용합니다. 폴백으로 form.submit 혹은 엔터 시뮬레이션을 시도합니다.
   * @param {Element|null} textbox 텍스트 박스 요소
   */
  async function triggerSend(textbox) {
    if (activeAdapter?.triggerSend && activeAdapter.triggerSend(textbox)) return;
    const form = textbox?.closest?.('form');
    if (form && typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      logDebug('triggerSend: form submitted via fallback');
      return;
    }
    if (textbox) {
      ignoreSyntheticUntil = performance.now() + 200;
      const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' });
      textbox.dispatchEvent(ev);
      logDebug('triggerSend: enter key dispatched via fallback');
    }
  }

  /******************************************************************************/
  /*                              메인 로직 함수 정의                             */
  /******************************************************************************/
  /**
   * 현재 텍스트 박스의 내용을 서버에 보내고 보강된 텍스트를 받아 전송까지 처리합니다.
   */
  async function processAndSend() {
    const textbox = boundTextbox || findTextbox();
    if (!textbox) {
      showToast('입력창을 못 찾았어요.', 'error');
      logDebug('processAndSend: no textbox found');
      return;
    }
    const original = (readTextboxValue(textbox) || '').trim();
    if (!original) {
      logDebug('processAndSend: empty input → triggering native send');
      await triggerSend(textbox);
      return;
    }
    const len = original.length;
    logDebug('processAndSend: original input', {len, original});
    if (len < MIN_LEN || len > MAX_LEN) {
      showToast('길이 범위 밖 — 원문만 전송', 'info', 900);
      logDebug('processAndSend: input length out of range, sending original');
      await triggerSend(textbox);
      return;
    }
    if (isProcessing) {
      logDebug('processAndSend: already processing → ignoring');
      return;
    }
    isProcessing = true;
    lockSendButton(true);
    showToast('보강 중…', 'info', TIMEOUT_MS);
    try {
      // API 호출
      const serverText = await withTimeout(callApiRaw(original), TIMEOUT_MS);
      logDebug('processAndSend: API returned', {serverText});
      // 텍스트 교체
      writeTextboxValue(textbox, serverText);
      // 값 반영 완료 대기
      const stabilize = await waitTextApplied(textbox, serverText, {
        maxWait: 600,
        settle: 64,
        interval: 16,
        minWait: 50
      });
      // 추가 지연
      if (!stabilize.ok || stabilize.elapsedMs > 200) {
        await sleep(120);
      } else if (SEND_DELAY_MS > 0) {
        await sleep(SEND_DELAY_MS);
      }
      // 포커스 복구 및 버튼 언락
      textbox.focus();
      lockSendButton(false);
      // 전송
      await triggerSend(textbox);
      showToast('전송됨', 'success', 1000);
      logDebug('processAndSend: message sent successfully');
    } catch (e) {
      logDebug('processAndSend: error occurred', e);
      lockSendButton(false);
      if (String(e).includes('auth_needed')) {
        showToast('사이트를 열었습니다. 로그인 후 다시 전송하세요.', 'info', 2000);
      } else if (String(e).includes('timeout')) {
        showToast('응답 지연 — 원문만 전송', 'error', 1500);
        await triggerSend(textbox);
      } else {
        showToast('보강 실패 — 원문만 전송', 'error', 1200);
        await triggerSend(textbox);
      }
    } finally {
      setTimeout(() => { isProcessing = false; }, 200);
    }
  }

  /******************************************************************************/
  /*                   텍스트 박스 바인딩 및 DOM 변화 감지                           */
  /******************************************************************************/
  /**
   * 주어진 텍스트 박스에 키보드 이벤트를 바인딩합니다. 이미 바인딩된 요소는 건너뜁니다.
   * @param {Element|null} el 텍스트 박스 요소
   */
  function bindTextbox(el) {
    if (!el || el.__extBound || !isVisible(el)) return;
    el.__extBound = true;
    ['keydown', 'keypress', 'keyup'].forEach((evName) => {
      el.addEventListener(evName, (e) => {
        if (!e.isTrusted || performance.now() < ignoreSyntheticUntil) return;
        if (e.isComposing) return;
        const isEnter = (e.key === 'Enter');
        const isPlain = isEnter && !(e.shiftKey || e.altKey || e.metaKey || e.ctrlKey);
        const isCmdCtl = isEnter && (e.metaKey || e.ctrlKey);
        if (!isPlain && !isCmdCtl) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        if (isProcessing) return;
        if (evName === 'keydown') processAndSend();
      }, true);
    });
    boundTextbox = el;
    logDebug('bindTextbox: textbox bound', el);
  }

  /**
   * DOM 변화 감지 및 초기화. 페이지 내에서 동적으로 텍스트 박스가 등장하는 경우를 대비하여
   * MutationObserver로 변화가 생길 때마다 텍스트 박스를 다시 바인딩합니다.
   */
  const obs = new MutationObserver(() => {
    if (!activeAdapter) return;
    const tb = findTextbox(); if (tb) bindTextbox(tb);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  /**
   * 초기화 함수. 스크립트 로딩 후 즉시 실행되어 첫 텍스트 박스를 바인딩합니다.
   */
  (function init() {
    logDebug('userscript loaded');
    if (!activeAdapter) {
      logDebug('no adapter for this url; script inactive');
      return;
    }
    const tb = findTextbox(); if (tb) bindTextbox(tb);
  })();
})();