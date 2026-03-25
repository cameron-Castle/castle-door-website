// ==UserScript==
// @name         QBO Send Subject AutoFill (PO + Invoice No)
// @namespace    https://castledoorict.com/
// @version      1.1.0
// @description  Auto-fills QBO Send Invoice subject once per dialog, while still allowing manual edits.
// @author       You
// @match        https://*.qbo.intuit.com/*
// @match        https://qbo.intuit.com/*
// @match        https://*.intuit.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const DEBUG = false;
  const STORAGE_KEY = 'qboAutoSubject_poByInvoiceNo_v1';
  const poByInvoiceNo = new Map();
  let lastClickedInvoiceNo = '';
  let lastClickedPO = '';

  let session = {
    dialogEl: null,
    subjectEl: null,
    manualEdited: false,
    internalSet: false,
    inputBound: false,
    autofilled: false
  };

  function log(...args) {
    if (DEBUG) console.log('[QBO-AutoSubject]', ...args);
  }

  function loadSavedPOMap() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const pairs = JSON.parse(raw);
      if (!Array.isArray(pairs)) return;
      for (const p of pairs) {
        if (!Array.isArray(p) || p.length !== 2) continue;
        const inv = normalize(p[0]);
        const po = cleanPoCandidate(p[1]);
        if (inv && po) poByInvoiceNo.set(inv, po);
      }
    } catch (_) {}
  }

  function savePOMap() {
    try {
      const pairs = Array.from(poByInvoiceNo.entries()).slice(-250);
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pairs));
    } catch (_) {}
  }

  function rememberPO(invoiceNo, po) {
    const inv = normalize(invoiceNo);
    const clean = cleanPoCandidate(po);
    if (!inv || !clean) return;
    poByInvoiceNo.set(inv, clean);
    savePOMap();
  }

  function normalize(v) {
    return (v || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function cleanPoCandidate(value) {
    const v = normalize(value).replace(/^[:\-\s]+/, '').trim();
    if (!v) return '';
    const bad = new Set(['HIDDEN', '(HIDDEN)', 'PO', '#', 'INVOICE', 'TERMS', 'DATE', 'DUE', 'NET']);
    if (bad.has(v.toUpperCase())) return '';
    return v;
  }

  function setNativeValue(el, value) {
    if (!el) return false;
    if (normalize(el.value) === normalize(value)) return false;

    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    const setter = desc && desc.set;

    session.internalSet = true;
    try {
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    } finally {
      session.internalSet = false;
    }
    return true;
  }

  function findSendDialog() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .modal, .ReactModal__Content'));
    return dialogs.find((d) => /send\s+invoice/i.test(normalize(d.textContent || '')));
  }

  function findSubjectInput(dialog) {
    if (!dialog) return null;

    const explicit = dialog.querySelector('input[aria-label*="Subject" i], input[name*="subject" i], input[id*="subject" i]');
    if (explicit) return explicit;

    const labels = Array.from(dialog.querySelectorAll('label, div, span')).filter((n) => normalize(n.textContent).toLowerCase() === 'subject');
    for (const label of labels) {
      const c = label.closest('div, form, section') || label.parentElement;
      if (!c) continue;
      const input = c.querySelector('input[type="text"], input:not([type]), textarea');
      if (input) return input;
    }

    const inputs = Array.from(dialog.querySelectorAll('input[type="text"], input:not([type])'));
    return inputs[2] || null;
  }

  function findInvoiceNoFromDialog(dialog) {
    if (!dialog) return '';
    const heading = dialog.querySelector('h1, h2, [role="heading"]');
    const headingText = normalize((heading && heading.textContent) || '');
    let m = headingText.match(/(?:send\s+invoice|invoice)\s+([A-Za-z0-9\-]+)/i);
    if (m) return m[1];

    const t = normalize(dialog.textContent || '');
    m = t.match(/\b(?:send\s+invoice|invoice)\s+([A-Za-z0-9\-]+)\b/i);
    return m ? m[1] : '';
  }

  function warmCacheFromVisibleInvoiceEditor() {
    // When opening full-page "Review and send", the PO field may disappear.
    // Cache it while still on the editable invoice screen.
    const invInput = document.querySelector('input[aria-label*="Invoice no" i], input[aria-label*="Invoice number" i]');
    const poInput = document.querySelector('input[aria-label*="PO #" i], input[aria-label*="Purchase Order" i], input[placeholder*="PO" i]');
    if (!invInput || !poInput) return;
    if (!isVisible(invInput) || !isVisible(poInput)) return;

    const inv = normalize(invInput.value);
    const po = cleanPoCandidate(poInput.value);
    if (inv && po) rememberPO(inv, po);
  }

  function findInvoiceNumber(dialog) {
    const fromDialog = findInvoiceNoFromDialog(dialog);
    if (fromDialog) return fromDialog;

    // Only use direct page inputs if they are visible; hidden/background editors
    // can otherwise leak a stale invoice number from another screen.
    const direct = document.querySelector('input[aria-label*="Invoice no" i], input[aria-label*="Invoice number" i]');
    if (direct && isVisible(direct) && normalize(direct.value)) return normalize(direct.value);

    const title = normalize(document.title);
    const m = title.match(/invoice\s+([A-Za-z0-9\-]+)/i);
    if (m) return m[1];

    return '';
  }

  function findInputNearLabel(regex) {
    const labels = Array.from(document.querySelectorAll('label, div, span')).filter((n) => regex.test(normalize(n.textContent)));
    for (const label of labels) {
      const scope = label.closest('section, form, div') || label.parentElement;
      if (!scope) continue;
      const candidate = Array.from(scope.querySelectorAll('input[type="text"], input:not([type]), textarea')).find(isVisible);
      if (candidate) return candidate;
    }
    return null;
  }

  function findListViewPOByInvoiceNo(invoiceNo) {
    const inv = normalize(invoiceNo);
    if (!inv) return '';

    const rows = Array.from(document.querySelectorAll('table tbody tr, [role="rowgroup"] [role="row"]'));
    if (!rows.length) return '';

    const headerCells = Array.from(document.querySelectorAll('table thead th, [role="columnheader"]'));
    let noIdx = -1;
    let poIdx = -1;

    headerCells.forEach((h, idx) => {
      const text = normalize(h.textContent).toLowerCase();
      if (text === 'no.' || text === 'no' || text === 'invoice no.' || text === 'invoice no') noIdx = idx;
      if (text === 'purchase order #' || text === 'purchase order' || text === 'po #' || text === 'po') poIdx = idx;
    });

    if (noIdx < 0 || poIdx < 0) return '';

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td, [role="gridcell"]'));
      if (!cells.length) continue;
      const noText = normalize((cells[noIdx] && cells[noIdx].textContent) || '');
      if (noText !== inv) continue;
      return cleanPoCandidate((cells[poIdx] && cells[poIdx].textContent) || '');
    }

    return '';
  }

  function captureSendRowContext(event) {
    try {
      const target = event.target;
      if (!target || !(target instanceof Element)) return;

      const clickEl = target.closest('a, button, [role="menuitem"], span, div');
      if (!clickEl) return;

      const label = normalize(clickEl.textContent || '').toLowerCase();
      const aria = normalize(clickEl.getAttribute('aria-label') || '').toLowerCase();
      const isSendAction = label === 'send' || aria === 'send' || /\bsend\b/.test(label + ' ' + aria);
      if (!isSendAction) return;

      const row = clickEl.closest('tr, [role="row"]');
      if (!row) return;

      const table = row.closest('table, [role="grid"]');
      if (!table) return;

      const headerCells = Array.from(table.querySelectorAll('thead th, [role="columnheader"]'));
      let noIdx = -1;
      let poIdx = -1;
      headerCells.forEach((h, idx) => {
        const text = normalize(h.textContent).toLowerCase();
        if (text === 'no.' || text === 'no' || text === 'invoice no.' || text === 'invoice no') noIdx = idx;
        if (text === 'purchase order #' || text === 'purchase order' || text === 'po #' || text === 'po') poIdx = idx;
      });
      if (noIdx < 0 || poIdx < 0) return;

      const cells = Array.from(row.querySelectorAll('td, [role="gridcell"]'));
      const inv = normalize((cells[noIdx] && cells[noIdx].textContent) || '');
      const po = cleanPoCandidate((cells[poIdx] && cells[poIdx].textContent) || '');
      if (!inv) return;

      lastClickedInvoiceNo = inv;
      lastClickedPO = po || '';
      if (po) rememberPO(inv, po);
    } catch (e) {
      log('captureSendRowContext error', e);
    }
  }

  function captureInvoiceEditorContext(event) {
    try {
      const target = event.target;
      if (!target || !(target instanceof Element)) return;

      const actionEl = target.closest('button, a, span, div');
      if (!actionEl) return;
      const label = normalize(actionEl.textContent || '').toLowerCase();
      const aria = normalize(actionEl.getAttribute('aria-label') || '').toLowerCase();
      const isReviewSend = /review\s*and\s*send/.test(label + ' ' + aria);
      if (!isReviewSend) return;

      const invInput = document.querySelector('input[aria-label*="Invoice no" i], input[aria-label*="Invoice number" i]');
      const poInput = document.querySelector('input[aria-label*="PO #" i], input[aria-label*="Purchase Order" i], input[placeholder*="PO" i]');
      if (!invInput || !poInput) return;
      if (!isVisible(invInput) || !isVisible(poInput)) return;

      const inv = normalize(invInput.value);
      const po = cleanPoCandidate(poInput.value);
      if (inv && po) rememberPO(inv, po);
    } catch (e) {
      log('captureInvoiceEditorContext error', e);
    }
  }

  function findPOValue(invoiceNo) {
    const poInput = findInputNearLabel(/^purchase\s*order\s*#?$|^po\s*#?$/i);
    if (poInput && isVisible(poInput)) {
      const po = cleanPoCandidate(poInput.value);
      if (po) return po;
    }

    const bySelector = document.querySelector('input[aria-label*="PO #" i], input[aria-label*="Purchase Order" i], input[placeholder*="PO" i]');
    if (bySelector && isVisible(bySelector)) {
      const po = cleanPoCandidate(bySelector.value);
      if (po) return po;
    }

    const listPo = findListViewPOByInvoiceNo(invoiceNo);
    if (listPo) return listPo;

    return invoiceNo ? (poByInvoiceNo.get(invoiceNo) || '') : '';
  }

  function buildSubject(po, invoiceNo) {
    if (po && invoiceNo) return `New payment request from Castle Door and Hardware - invoice ${invoiceNo} - PO ${po}`;
    if (invoiceNo) return `New payment request from Castle Door and Hardware - invoice ${invoiceNo}`;
    return '';
  }

  function resetSession() {
    session = {
      dialogEl: null,
      subjectEl: null,
      manualEdited: false,
      internalSet: false,
      inputBound: false,
      autofilled: false
    };
  }

  function ensureSession(dialog, subjectEl) {
    if (session.dialogEl !== dialog || session.subjectEl !== subjectEl) {
      resetSession();
      session.dialogEl = dialog;
      session.subjectEl = subjectEl;
    }

    if (!session.inputBound && subjectEl) {
      subjectEl.addEventListener('input', () => {
        if (!session.internalSet) {
          session.manualEdited = true;
          log('Subject manually edited; auto-overwrite disabled for this dialog.');
        }
      });
      session.inputBound = true;
    }
  }

  function applySubject() {
    const dialog = findSendDialog();
    const container = dialog || document;

    const subjectEl = findSubjectInput(container);
    if (!subjectEl) {
      resetSession();
      return;
    }

    ensureSession(container, subjectEl);
    if (session.manualEdited || session.autofilled) return;

    const invoiceNo = findInvoiceNumber(dialog || document);
    if (!invoiceNo) return;

    let po = findPOValue(invoiceNo);
    if (!po && invoiceNo === lastClickedInvoiceNo) {
      po = lastClickedPO;
    }
    if (po) rememberPO(invoiceNo, po);

    const next = buildSubject(po, invoiceNo);
    if (!next) return;

    const current = normalize(subjectEl.value);
    const looksDefault = !current || /new payment request/i.test(current) || /invoice\s*\[?invoice/i.test(current) || /^invoice\s+[A-Za-z0-9\-]+$/i.test(current);
    if (!looksDefault) {
      session.manualEdited = true;
      return;
    }

    const changed = setNativeValue(subjectEl, next);
    if (changed) {
      session.autofilled = true;
      log('Subject autofilled:', next);
    }
  }

  const observer = new MutationObserver(() => {
    try {
      warmCacheFromVisibleInvoiceEditor();
      applySubject();
    } catch (e) {
      log('Error', e);
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  loadSavedPOMap();
  document.addEventListener('click', captureSendRowContext, true);
  document.addEventListener('click', captureInvoiceEditorContext, true);
  setInterval(warmCacheFromVisibleInvoiceEditor, 700);
  setInterval(applySubject, 600);
})();

