export const dashboardJs = `
// Neuralbrain - Operator Command Center Frontend Logic
// Built with 100% safe DOM methods (createElement, textContent, replaceChildren)
// ZERO innerHTML, ZERO outerHTML, ZERO localStorage, ZERO alert/confirm/prompt

(function () {
  'use strict';

  // State
  let statsData = null;
  let activeTab = 'overview';
  let activeSubTab = 'trajectories';
  let activeNotesCategory = 'all';
  let activeShortSubTab = 'sessions';
  let graphData = null;
  let selectedGraphNodeId = null;
  let isReembedding = false;
  const tabHistoryStack = ['overview'];
  const tabDisplayNames = {
    overview: 'Overview',
    notes: 'Long Term',
    shortTerm: 'Short Term',
    trajectories: 'Observations',
    graph: 'Graph',
    search: 'Search & Inject',
    conformance: 'System & AI'
  };

  // Stale-While-Revalidate (SWR) & Pre-render Cache
  const swrCache = {
    stats: null,
    notes: new Map(),
    sessions: new Map(),
    actions: new Map(),
    trajectories: null,
    observations: null,
    summaries: null,
    graph: new Map()
  };
  const prerenderInFlight = new Set();

  // In-memory authentication state (zero localStorage per SecureCoder rules)
  let inMemoryApiKey = '';
  let isBootstrapRequired = false;
  let isSessionAuthenticated = false;
  let sessionKeyName = '';

  // Idempotency key generator for safe mutation retries
  function generateIdempotencyKey() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'idem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  async function apiFetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    const idempotencyKey = isMutating
      ? (options.idempotencyKey || generateIdempotencyKey())
      : null;

    const headers = new Headers(options.headers || {});
    if (inMemoryApiKey && !headers.has('Authorization')) {
      headers.set('Authorization', 'Bearer ' + inMemoryApiKey);
    }
    if (!headers.has('X-Requested-With')) {
      headers.set('X-Requested-With', 'XMLHttpRequest');
    }
    if (idempotencyKey && !headers.has('Idempotency-Key')) {
      headers.set('Idempotency-Key', idempotencyKey);
    }

    const fetchOpts = { ...options };
    delete fetchOpts.idempotencyKey;
    delete fetchOpts.maxRetries;

    const maxRetries = typeof options.maxRetries === 'number' ? options.maxRetries : (isMutating ? 1 : 0);
    let attempt = 0;
    while (true) {
      try {
        const resp = await fetch(url, { credentials: 'same-origin', ...fetchOpts, headers });
        if (resp.status === 401 && !url.includes('/dashboard/api/session')) {
          isSessionAuthenticated = false;
          updateAuthStatusUI();
        }
        if (resp.status >= 500 && attempt < maxRetries) {
          attempt++;
          continue;
        }
        return resp;
      } catch (err) {
        if (attempt < maxRetries) {
          attempt++;
          continue;
        }
        throw err;
      }
    }
  }

  async function checkAuthStatus() {
    try {
      const resp = await fetch('/dashboard/api/auth-status', {
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      });
      if (resp.ok) {
        const data = await resp.json();
        isBootstrapRequired = Boolean(data.bootstrap_required);
        if (data.authenticated) {
          isSessionAuthenticated = true;
          sessionKeyName = data.session_key_name || 'Active';
        } else {
          isSessionAuthenticated = false;
        }
        updateAuthStatusUI();
      }
    } catch {
      // ignore
    }
  }

  function updateAuthStatusUI() {
    const apiKeyForm = document.getElementById('formDashboardApiKey');
    const apiKeyInput = document.getElementById('inputDashboardApiKey');
    const btnSubmit = document.getElementById('btnSubmitApiKey');
    const btnGenApiKey = document.getElementById('btnGenerateApiKey');
    const sessionCluster = document.getElementById('authSessionCluster');
    const sessionText = document.getElementById('authSessionText');

    if (isBootstrapRequired) {
      if (sessionCluster) sessionCluster.classList.add('hidden');
      if (apiKeyForm) apiKeyForm.classList.remove('hidden');
      if (apiKeyInput) {
        apiKeyInput.placeholder = 'Click "+ Claim First Key"';
        apiKeyInput.disabled = true;
      }
      if (btnSubmit) btnSubmit.classList.add('hidden');
      if (btnGenApiKey) {
        setButtonLabel(btnGenApiKey, '+ Claim First API Key');
        btnGenApiKey.className = 'btn btn-primary';
        btnGenApiKey.title = 'Initial Setup: Claim initial operator API key';
      }
    } else if (isSessionAuthenticated || inMemoryApiKey) {
      // Authenticated! Hide the input field and form, clear the input, and display session cluster
      if (apiKeyForm) apiKeyForm.classList.add('hidden');
      if (apiKeyInput) {
        apiKeyInput.value = '';
        apiKeyInput.disabled = false;
      }
      if (sessionCluster) sessionCluster.classList.remove('hidden');
      if (sessionText) {
        sessionText.textContent = 'KEY: ' + (sessionKeyName || 'Active');
      }
      if (btnGenApiKey) {
        setButtonLabel(btnGenApiKey, '+ Generate API Key');
        btnGenApiKey.className = 'btn btn-primary';
        btnGenApiKey.title = 'Generate client API key';
      }
    } else {
      // Unauthenticated: Show input form and Apply button, hide session cluster
      if (sessionCluster) sessionCluster.classList.add('hidden');
      if (apiKeyForm) apiKeyForm.classList.remove('hidden');
      if (apiKeyInput) {
        apiKeyInput.disabled = false;
        apiKeyInput.placeholder = 'Paste API Key to Authenticate';
      }
      if (btnSubmit) {
        btnSubmit.classList.remove('hidden');
        setButtonLabel(btnSubmit, 'Apply');
      }
      if (btnGenApiKey) {
        setButtonLabel(btnGenApiKey, '+ Generate API Key');
        btnGenApiKey.className = 'btn';
        btnGenApiKey.title = 'Generate client API key (requires authenticated window)';
      }
    }
  }

  // DOM Helper: Safe Element Construction
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, val] of Object.entries(attrs)) {
        if (key === 'className' || key === 'class') {
          node.className = val;
        } else if (key === 'textContent') {
          node.textContent = val;
        } else if (key.startsWith('on') && typeof val === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), val);
        } else if (key === 'style' && typeof val === 'object') {
          Object.assign(node.style, val);
        } else if (val !== null && val !== undefined && val !== false) {
          node.setAttribute(key, val === true ? '' : String(val));
        }
      }
    }
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      if (typeof child === 'string' || typeof child === 'number') {
        node.appendChild(document.createTextNode(String(child)));
      } else if (child instanceof Node) {
        node.appendChild(child);
      } else if (Array.isArray(child)) {
        for (const c of child) {
          if (c instanceof Node) node.appendChild(c);
          else if (typeof c === 'string' || typeof c === 'number') {
            node.appendChild(document.createTextNode(String(c)));
          }
        }
      }
    }
    return node;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SVG_ICON_DEFS = {
    check: [['path', { d: 'M20 6 9 17l-5-5' }]],
    alert: [
      ['path', { d: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z' }],
      ['path', { d: 'M12 9v4' }],
      ['path', { d: 'M12 17h.01' }]
    ],
    wrench: [['path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z' }]],
    copy: [
      ['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }],
      ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }]
    ],
    search: [
      ['circle', { cx: '11', cy: '11', r: '8' }],
      ['path', { d: 'm21 21-4.3-4.3' }]
    ],
    folder: [['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }]],
    edit: [
      ['path', { d: 'M12 20h9' }],
      ['path', { d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z' }]
    ],
    close: [
      ['path', { d: 'M18 6 6 18' }],
      ['path', { d: 'm6 6 12 12' }]
    ],
    refresh: [
      ['path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }],
      ['path', { d: 'M21 3v6h-6' }]
    ],
    download: [
      ['path', { d: 'M12 3v12' }],
      ['path', { d: 'm7 10 5 5 5-5' }],
      ['path', { d: 'M5 21h14' }]
    ],
    layers: [
      ['path', { d: 'm12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z' }],
      ['path', { d: 'm22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65' }],
      ['path', { d: 'm22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65' }]
    ],
    tag: [
      ['path', { d: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42Z' }],
      ['circle', { cx: '7.5', cy: '7.5', r: '.5' }]
    ],
    clock: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['polyline', { points: '12 6 12 12 16 14' }]
    ],
    terminal: [
      ['polyline', { points: '4 17 10 11 4 5' }],
      ['line', { x1: '12', x2: '20', y1: '19', y2: '19' }]
    ],
    chevron: [['path', { d: 'm6 9 6 6 6-6' }]],
    plus: [
      ['path', { d: 'M5 12h14' }],
      ['path', { d: 'M12 5v14' }]
    ],
    trash: [
      ['path', { d: 'M3 6h18' }],
      ['path', { d: 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6' }],
      ['path', { d: 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' }]
    ]
  };

  function createSvgIcon(name, className = 'icon-svg') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const shapes = SVG_ICON_DEFS[name] || SVG_ICON_DEFS.alert;
    for (const [tag, attrs] of shapes) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) {
        node.setAttribute(k, v);
      }
      svg.appendChild(node);
    }
    return svg;
  }

  // Safe Badge Helper
  function createBadge(text, variant = 'subtle', isMono = false, iconName = null) {
    const safeVariant = ['emerald', 'amber', 'rose', 'subtle'].includes(variant) ? variant : 'subtle';
    const iconEl = iconName ? createSvgIcon(iconName, 'icon-svg') : null;
    if (iconEl) {
      iconEl.style.width = '12px';
      iconEl.style.height = '12px';
    }
    const dotEl = (safeVariant !== 'subtle' && !iconName) ? el('span', { className: 'badge-dot' }) : null;
    return el('span', { className: 'badge badge-' + safeVariant + (isMono ? ' badge-mono' : '') },
      dotEl,
      iconEl,
      text
    );
  }

  // Always-Visible Provenance Line in Cool Pewter
  function createProvenanceLine(text) {
    const clockIcon = createSvgIcon('clock', 'icon-svg');
    clockIcon.style.width = '12px';
    clockIcon.style.height = '12px';
    return el('div', {
      className: 'provenance-line',
      style: { marginTop: '8px' }
    }, clockIcon, el('span', { textContent: text }));
  }

  // Skeleton Loader Builder (replaces text/spinner loading indicators)
  function createSkeletonLoader(kind = 'list', count = 3, label = 'Loading...') {
    const wrapper = el('div', { className: 'skeleton-loader', role: 'status', 'aria-live': 'polite' },
      el('span', { className: 'sr-only', textContent: label })
    );
    if (kind === 'kpi') {
      for (let i = 0; i < count; i++) {
        wrapper.appendChild(el('div', { className: 'skeleton skeleton-kpi kpi-card' }));
      }
      return wrapper;
    }
    for (let i = 0; i < count; i++) {
      wrapper.appendChild(
        el('div', { className: 'skeleton-card' },
          el('div', { className: 'skeleton skeleton-line', style: { width: '38%' } }),
          el('div', { className: 'skeleton skeleton-line', style: { width: '92%' } }),
          el('div', { className: 'skeleton skeleton-line', style: { width: '64%' } })
        )
      );
    }
    return wrapper;
  }

  // View Transition Wrapper (graceful fallback if unsupported)
  function runViewTransition(updateFn) {
    if (typeof document !== 'undefined' && typeof document.startViewTransition === 'function') {
      try {
        return document.startViewTransition(() => updateFn());
      } catch {
        updateFn();
        return null;
      }
    }
    updateFn();
    return null;
  }

  // Blurred Icon Swap Helper (filter: blur(4px) on outgoing icon)
  function setButtonLabel(buttonEl, label) {
    if (!buttonEl) return;
    const labelEl = buttonEl.querySelector('.btn-label');
    if (labelEl) {
      labelEl.textContent = label;
    } else {
      buttonEl.textContent = label;
    }
  }

  function swapIconWithBlur(buttonEl, nextLabel, nextIconName = null, durationMs = 180) {
    if (!buttonEl) return;
    if (buttonEl._iconSwapTimer) {
      clearTimeout(buttonEl._iconSwapTimer);
      buttonEl._iconSwapTimer = null;
    }
    const iconSlot = buttonEl.querySelector('.icon-swap-slot');
    const labelEl = buttonEl.querySelector('.btn-label') || (iconSlot ? null : buttonEl);
    if (iconSlot) {
      iconSlot.classList.remove('icon-swap-in');
      iconSlot.classList.add('icon-swap-out');
      iconSlot.style.filter = 'blur(4px)';
      buttonEl._iconSwapTimer = setTimeout(() => {
        buttonEl._iconSwapTimer = null;
        if (nextLabel !== null && nextLabel !== undefined && labelEl) {
          labelEl.textContent = nextLabel;
        }
        if (nextIconName) {
          iconSlot.replaceChildren(createSvgIcon(nextIconName));
        }
        iconSlot.style.filter = '';
        iconSlot.classList.remove('icon-swap-out');
        iconSlot.classList.add('icon-swap-in');
      }, durationMs);
    } else if (nextLabel !== null && nextLabel !== undefined && labelEl) {
      labelEl.textContent = nextLabel;
    }
  }

  // Toast & Undo Toast Notification System (replaces native alert/confirm)
  function showToast(message, variant = 'emerald', durationMs = 4500, options = {}) {
    const container = document.getElementById('toastContainer');
    if (!container) return null;

    let dismissed = false;
    let undone = false;
    const toast = el('div', { className: 'toast toast-' + variant });
    const toastIconName = variant === 'rose' ? 'close' : (variant === 'amber' ? 'alert' : 'check');
    const toastIcon = createSvgIcon(toastIconName);
    toastIcon.style.color = variant === 'rose'
      ? 'var(--accent-rose)'
      : (variant === 'amber' ? 'var(--accent-amber)' : 'var(--accent-emerald)');
    const textSpan = el('span', { textContent: message });
    const contentWrap = el('div', { className: 'toast-content' }, toastIcon, textSpan);
    const actionsWrap = el('div', { className: 'toast-actions' });

    const closeToast = () => {
      if (dismissed) return;
      dismissed = true;
      if (toast.parentElement) toast.remove();
    };

    if (typeof options.onUndo === 'function') {
      const undoBtn = el('button', {
        type: 'button',
        className: 'toast-undo-btn hit-slop',
        textContent: options.undoLabel || 'Undo',
        onClick: async () => {
          if (undone) return;
          undone = true;
          closeToast();
          await options.onUndo();
        }
      });
      actionsWrap.appendChild(undoBtn);
    }

    const closeIcon = createSvgIcon('close');
    closeIcon.style.width = '12px';
    closeIcon.style.height = '12px';
    const closeBtn = el('button', {
      type: 'button',
      className: 'toast-close-btn',
      title: 'Dismiss',
      'aria-label': 'Dismiss notification',
      onClick: closeToast
    }, closeIcon);
    actionsWrap.appendChild(closeBtn);

    toast.appendChild(contentWrap);
    toast.appendChild(actionsWrap);
    container.appendChild(toast);

    setTimeout(() => {
      if (!undone && typeof options.onCommit === 'function') {
        options.onCommit();
      }
      closeToast();
    }, durationMs);

    return toast;
  }

  function showUndoToast(message, onUndo, onCommit, durationMs = 5000) {
    return showToast(message, 'emerald', durationMs, {
      undoLabel: 'Undo',
      onUndo,
      onCommit
    });
  }

  // Swipe-to-Dismiss & Interruptible Animation Controller for Modal Sheets
  function attachSwipeToDismiss(dialog) {
    if (!dialog) return;
    let startY = 0;
    let currentY = 0;
    let startTime = 0;
    let dragging = false;
    let activeAnim = null;

    const onPointerDown = (e) => {
      const target = e.target;
      const isHandle = target && target.closest && (target.closest('.sheet-drag-handle') || target.closest('.modal-header'));
      if (!isHandle) return;
      if (target.closest('button')) return;

      // Interrupt any running spring-back animation mid-way
      if (typeof dialog.getAnimations === 'function') {
        dialog.getAnimations().forEach((anim) => anim.pause());
      }
      if (activeAnim && typeof activeAnim.pause === 'function') {
        activeAnim.pause();
      }

      const computed = window.getComputedStyle(dialog).transform;
      let offsetY = 0;
      if (computed && computed !== 'none') {
        const match = computed.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\s*([^)]+)\)/);
        if (match && match[1]) offsetY = parseFloat(match[1]) || 0;
      }

      dragging = true;
      startY = e.clientY - offsetY;
      currentY = offsetY;
      startTime = performance.now();
      dialog.style.transition = 'none';
      if (dialog.setPointerCapture && e.pointerId !== undefined) {
        try { dialog.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
    };

    const onPointerMove = (e) => {
      if (!dragging) return;
      const dy = Math.max(0, e.clientY - startY);
      currentY = dy;
      dialog.style.transform = 'translateY(' + dy + 'px)';
      dialog.style.opacity = String(Math.max(0.25, 1 - dy / 360));
    };

    const onPointerUp = () => {
      if (!dragging) return;
      dragging = false;
      const elapsed = Math.max(1, performance.now() - startTime);
      const velocityY = currentY / elapsed;

      if (currentY > 110 || velocityY > 0.65) {
        if (typeof dialog.animate === 'function') {
          const outAnim = dialog.animate(
            [
              { transform: 'translateY(' + currentY + 'px)', opacity: dialog.style.opacity || '1' },
              { transform: 'translateY(100%)', opacity: '0' }
            ],
            { duration: 160, easing: 'ease-in', fill: 'forwards' }
          );
          outAnim.onfinish = () => closeModal();
        } else {
          closeModal();
        }
      } else if (typeof dialog.animate === 'function') {
        activeAnim = dialog.animate(
          [
            { transform: 'translateY(' + currentY + 'px)', opacity: dialog.style.opacity || '1' },
            { transform: 'translateY(0px)', opacity: '1' }
          ],
          { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }
        );
        activeAnim.onfinish = () => {
          dialog.style.transform = '';
          dialog.style.opacity = '';
          activeAnim = null;
        };
      } else {
        dialog.style.transform = '';
        dialog.style.opacity = '';
      }
    };

    dialog.addEventListener('pointerdown', onPointerDown);
    dialog.addEventListener('pointermove', onPointerMove);
    dialog.addEventListener('pointerup', onPointerUp);
    dialog.addEventListener('pointercancel', onPointerUp);
  }

  // Modal Dialog System (replaces native alert/confirm/prompt)
  let lastFocusedBeforeModal = null;
  let lastFocusedBeforeCommandMenu = null;

  function getFocusableElements(root) {
    if (!root) return [];
    const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(root.querySelectorAll(selector)).filter((node) => {
      if (node.classList && node.classList.contains('hidden')) return false;
      const style = window.getComputedStyle ? window.getComputedStyle(node) : null;
      return !style || (style.display !== 'none' && style.visibility !== 'hidden');
    });
  }

  function trapDialogFocus(e, root) {
    if (e.key !== 'Tab' || !root) return;
    const focusables = getFocusableElements(root);
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first || !root.contains(document.activeElement)) {
        e.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last || !root.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }

  function showModal(title, bodyNodes, footerButtons = []) {
    const container = document.getElementById('modalContainer');
    if (!container) return;

    if (!container.classList.contains('open')) {
      lastFocusedBeforeModal = document.activeElement;
    }

    const renderDialog = () => {
      container.replaceChildren();

      const dialog = el('div', { className: 'modal-dialog swipe-sheet', tabindex: '-1' });
      const dragHandle = el('div', { className: 'sheet-drag-handle', title: 'Drag down to dismiss' });

      // Header
      const header = el('div', { className: 'modal-header' },
        el('h3', { id: 'modalDialogTitle', className: 'modal-title', textContent: title }),
        el('button', {
          type: 'button',
          className: 'btn hit-slop',
          'aria-label': 'Close modal',
          style: { height: '32px', width: '32px', padding: '0' },
          onClick: closeModal
        }, createSvgIcon('close'))
      );

      // Body
      const body = el('div', { className: 'modal-body' });
      if (Array.isArray(bodyNodes)) {
        body.append(...bodyNodes);
      } else if (bodyNodes instanceof Node) {
        body.appendChild(bodyNodes);
      }

      // Footer
      const footer = el('div', { className: 'modal-footer' });
      const defaultCancel = el('button', { type: 'button', className: 'btn', onClick: closeModal }, 'Cancel');
      footer.appendChild(defaultCancel);

      for (const btnDef of footerButtons) {
        const btn = el('button', {
          type: 'button',
          className: 'btn ' + (btnDef.variant ? 'btn-' + btnDef.variant : 'btn-primary'),
          textContent: btnDef.label,
          onClick: async (e) => {
            if (btnDef.onClick) {
              await btnDef.onClick(e, closeModal);
            }
          }
        });
        footer.appendChild(btn);
      }

      dialog.appendChild(dragHandle);
      dialog.appendChild(header);
      dialog.appendChild(body);
      dialog.appendChild(footer);

      attachSwipeToDismiss(dialog);

      container.appendChild(dialog);
      container.classList.add('open');
      container.setAttribute('aria-labelledby', 'modalDialogTitle');
      container.removeAttribute('aria-hidden');
      container.style.display = 'flex';

      const firstInput = body.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
      const focusTarget = firstInput || getFocusableElements(dialog)[0] || dialog;
      if (focusTarget && typeof focusTarget.focus === 'function') {
        focusTarget.focus();
      }
    };

    runViewTransition(renderDialog);
  }

  function closeModal() {
    const container = document.getElementById('modalContainer');
    if (container) {
      container.classList.remove('open');
      container.setAttribute('aria-hidden', 'true');
      container.removeAttribute('aria-labelledby');
      container.style.display = 'none';
      container.replaceChildren();
    }
    const toRestore = lastFocusedBeforeModal;
    lastFocusedBeforeModal = null;
    if (toRestore && document.contains(toRestore) && typeof toRestore.focus === 'function') {
      toRestore.focus();
    }
  }

  // Format Unix Timestamp or ISO/SQLite Datetime String
  function formatTimestamp(ts) {
    if (ts === null || ts === undefined || ts === '') return 'never';
    let d;
    if (typeof ts === 'number') {
      d = new Date(ts * 1000);
    } else if (typeof ts === 'string') {
      const trimmed = ts.trim();
      if (!trimmed) return 'never';
      if (/^\\d+(\\.\\d+)?$/.test(trimmed)) {
        d = new Date(Number(trimmed) * 1000);
      } else if (/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}/.test(trimmed)) {
        const normalized = trimmed.replace(' ', 'T');
        d = new Date(/[zZ]|[+-]\\d{2}:?\\d{2}$/.test(normalized) ? normalized : normalized + 'Z');
      } else {
        d = new Date(trimmed);
      }
    } else {
      return String(ts);
    }
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function formatShortId(id) {
    if (!id) return '';
    const s = String(id);
    return s.length > 18 ? (s.slice(0, 8) + '…' + s.slice(-4)) : s;
  }

  // Pre-rendering (Prefetch likely next tabs on pointerenter/focus or idle)
  async function prerenderTab(tabKey) {
    if (!tabKey || tabKey === 'overview' || tabKey === 'search' || tabKey === 'conformance') return;
    if (!isSessionAuthenticated && !inMemoryApiKey) return;
    if (prerenderInFlight.has(tabKey)) return;
    prerenderInFlight.add(tabKey);
    try {
      if (tabKey === 'notes' && !swrCache.notes.has('default')) {
        const resp = await apiFetch('/notes?limit=50');
        if (resp.ok) {
          swrCache.notes.set('default', await resp.json());
        }
      } else if (tabKey === 'shortTerm' && !swrCache.sessions.has('default')) {
        const resp = await apiFetch('/sessions?limit=50');
        if (resp.ok) {
          const data = await resp.json();
          swrCache.sessions.set('default', Array.isArray(data.sessions) ? data.sessions : []);
        }
      } else if (tabKey === 'trajectories' && !swrCache.trajectories) {
        const resp = await apiFetch('/trajectories?limit=50');
        if (resp.ok) {
          swrCache.trajectories = await resp.json();
        }
      } else if (tabKey === 'graph' && !swrCache.graph.has('default')) {
        const resp = await apiFetch('/dashboard/api/graph?limit=80');
        if (resp.ok) {
          swrCache.graph.set('default', await resp.json());
        }
      }
    } catch {
      // ignore pre-render network failures
    } finally {
      prerenderInFlight.delete(tabKey);
    }
  }

  // Tab Navigation Handling
  function initTabs() {
    const tabButtons = Array.from(document.querySelectorAll('.nav-tab-btn'));
    tabButtons.forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        const tabKey = btn.getAttribute('data-tab');
        if (!tabKey) return;
        switchTab(tabKey);
      });
      btn.addEventListener('keydown', (e) => {
        let nextIdx = -1;
        if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabButtons.length;
        else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabButtons.length) % tabButtons.length;
        else if (e.key === 'Home') nextIdx = 0;
        else if (e.key === 'End') nextIdx = tabButtons.length - 1;
        if (nextIdx >= 0) {
          e.preventDefault();
          const targetBtn = tabButtons[nextIdx];
          const tabKey = targetBtn && targetBtn.getAttribute('data-tab');
          if (targetBtn && tabKey) {
            switchTab(tabKey);
            targetBtn.focus();
          }
        }
      });
      btn.addEventListener('pointerenter', () => {
        const tabKey = btn.getAttribute('data-tab');
        if (tabKey) prerenderTab(tabKey);
      });
      btn.addEventListener('focus', () => {
        const tabKey = btn.getAttribute('data-tab');
        if (tabKey) prerenderTab(tabKey);
      });
    });

    const subTabButtons = document.querySelectorAll('#paneTrajectories button[data-subtab]');
    subTabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const subTabKey = btn.getAttribute('data-subtab');
        if (!subTabKey) return;
        switchSubTab(subTabKey);
      });
    });

    const shortSubTabButtons = document.querySelectorAll('#paneShortTerm button[data-short-subtab]');
    shortSubTabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const subTabKey = btn.getAttribute('data-short-subtab');
        if (!subTabKey) return;
        switchShortSubTab(subTabKey);
      });
    });

    const btnScopeRepair = document.getElementById('btnScopeGoRepair');
    if (btnScopeRepair) {
      btnScopeRepair.addEventListener('click', () => {
        switchTab('notes');
        activeNotesCategory = 'unknown';
        updateNotesCategoryPills();
        const filterSelect = document.getElementById('notesFilterScope');
        if (filterSelect) filterSelect.value = 'unknown';
        applyNotesFilter();
      });
    }

    const btnShowRepairQueue = document.getElementById('btnShowRepairQueue');
    if (btnShowRepairQueue) {
      btnShowRepairQueue.addEventListener('click', () => {
        activeNotesCategory = 'unknown';
        updateNotesCategoryPills();
        const filterSelect = document.getElementById('notesFilterScope');
        if (filterSelect) filterSelect.value = 'unknown';
        applyNotesFilter();
      });
    }
  }

  function switchTab(tabKey, pushHistory = true) {
    if (pushHistory && tabHistoryStack[tabHistoryStack.length - 1] !== tabKey) {
      tabHistoryStack.push(tabKey);
      if (tabHistoryStack.length > 20) tabHistoryStack.shift();
      if (window.history && typeof window.history.pushState === 'function') {
        try {
          window.history.pushState({ tab: tabKey }, '', '#tab-' + tabKey);
        } catch {
          // ignore
        }
      }
    }

    activeTab = tabKey;
    const applyTabDom = () => {
      document.querySelectorAll('.nav-tab-btn').forEach((btn) => {
        const isTarget = btn.getAttribute('data-tab') === tabKey;
        btn.classList.toggle('active', isTarget);
        btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
      });

      document.querySelectorAll('.tab-pane').forEach((pane) => {
        pane.classList.remove('active');
      });

      const targetPane = document.getElementById('pane' + tabKey.charAt(0).toUpperCase() + tabKey.slice(1));
      if (targetPane) {
        targetPane.classList.add('active');
      }
    };

    runViewTransition(applyTabDom);

    if (tabKey === 'notes') {
      renderNotesTab();
    } else if (tabKey === 'shortTerm') {
      renderShortTermSubView();
    } else if (tabKey === 'trajectories') {
      renderTrajectoriesSubView();
    } else if (tabKey === 'graph') {
      loadGraph();
    } else if (tabKey === 'conformance') {
      renderFailurePatternsTable();
      renderDeadLettersSection();
    }
  }

  function refreshActiveTab() {
    if (activeTab === 'notes') {
      renderNotesTab();
    } else if (activeTab === 'shortTerm') {
      renderShortTermSubView();
    } else if (activeTab === 'trajectories') {
      renderTrajectoriesSubView();
    } else if (activeTab === 'graph') {
      loadGraph();
    } else if (activeTab === 'conformance') {
      renderFailurePatternsTable();
      renderDeadLettersSection();
    }
  }

  function switchSubTab(subTabKey, highlightId = null) {
    activeSubTab = subTabKey;
    const subTabButtons = document.querySelectorAll('#paneTrajectories button[data-subtab]');
    subTabButtons.forEach((btn) => {
      const isSelected = btn.getAttribute('data-subtab') === subTabKey;
      btn.className = isSelected ? 'btn btn-primary' : 'btn';
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });
    renderTrajectoriesSubView(highlightId);
  }

  // Fetch Full Dashboard Stats Snapshot (Stale-While-Revalidate)
  let isFetchingStats = false;
  async function fetchStats() {
    if (isFetchingStats) return;
    isFetchingStats = true;

    const kpiGrid = document.getElementById('overviewKpiGrid');
    if (swrCache.stats) {
      statsData = swrCache.stats;
      renderHeaderAndOverview(true);
    } else if (kpiGrid && kpiGrid.children.length === 0) {
      kpiGrid.replaceChildren();
      for (let i = 0; i < 4; i++) {
        kpiGrid.appendChild(el('div', { className: 'skeleton skeleton-kpi kpi-card' }));
      }
    }

    try {
      const resp = await apiFetch('/dashboard/api/stats');
      if (resp.status === 401) {
        isSessionAuthenticated = false;
        updateAuthStatusUI();
        if (kpiGrid && !swrCache.stats) kpiGrid.replaceChildren();
        showToast('Authentication required: Enter Bearer API key in the top header.', 'amber', 8000);
        const apiKeyInput = document.getElementById('inputDashboardApiKey');
        if (apiKeyInput) {
          apiKeyInput.focus();
        }
        return;
      }
      if (!resp.ok) {
        throw new Error('Stats request failed: ' + resp.status + ' ' + resp.statusText);
      }
      statsData = await resp.json();
      swrCache.stats = statsData;
      syncKnownProjects();
      syncTaskTypes();
      renderHeaderAndOverview(false);
    } catch (err) {
      if (swrCache.stats) renderHeaderAndOverview(false);
      showToast('Error fetching dashboard stats: ' + err.message, 'rose');
    } finally {
      isFetchingStats = false;
    }
  }

  // Render Header & Tab 1 Overview (supports SWR 'updating' label)
  function renderHeaderAndOverview(isStaleRevalidating = false) {
    if (!statsData) return;

    const health = statsData.health || {};
    const counts = statsData.counts || {};
    const storeMeta = health.store_meta || {};

    // 1. Header Badges
    const healthBadge = document.getElementById('healthBadge');
    const healthText = document.getElementById('healthText');
    if (healthBadge && healthText) {
      if (health.status === 'ok') {
        healthBadge.className = 'badge badge-emerald';
        healthText.textContent = isStaleRevalidating ? 'HEALTH: OK (updating)' : 'HEALTH: OK';
      } else {
        healthBadge.className = 'badge badge-rose';
        healthText.textContent = isStaleRevalidating ? 'HEALTH: DEGRADED (updating)' : 'HEALTH: DEGRADED';
      }
    }

    const storeMetaBadge = document.getElementById('storeMetaBadge');
    const storeMetaText = document.getElementById('storeMetaText');
    if (storeMetaBadge && storeMetaText) {
      const tier = storeMeta.embed_tier || 'none';
      const dim = storeMeta.embed_dim || 0;
      const modelId = storeMeta.embed_model_id || 'none';
      storeMetaText.textContent = 'STORE: ' + tier + ' (' + dim + 'd: ' + modelId + ')';
      if (storeMeta.match === false) {
        storeMetaBadge.className = 'badge badge-rose badge-mono';
      } else {
        storeMetaBadge.className = 'badge badge-subtle badge-mono';
      }
    }

    const qdrantBadge = document.getElementById('qdrantBadge');
    const qdrantText = document.getElementById('qdrantText');
    if (qdrantBadge && qdrantText) {
      const qStatus = health.qdrant || 'offline';
      qdrantText.textContent = 'QDRANT: ' + qStatus.toUpperCase();
      qdrantBadge.className = qStatus === 'ok' ? 'badge badge-emerald badge-mono' : 'badge badge-amber badge-mono';
      qdrantBadge.title = qStatus === 'ok'
        ? 'Qdrant vector index is connected on port 6333'
        : 'Qdrant is offline (BM25 + SQL search active). For vector search, run: docker compose up -d qdrant';
    }

    // 1b. Re-embed Status Badge & Auto-resume Polling
    const reembedStatus = health.reembed_status || null;
    updateReembedUI(reembedStatus);
    if (reembedStatus && reembedStatus.status === 'running' && !isReembedding) {
      pollReembedProgress();
    }

    // 2. Loud Mismatch Warning Banner
    const mismatchBanner = document.getElementById('mismatchBanner');
    const mismatchReasonText = document.getElementById('mismatchReasonText');
    if (mismatchBanner && mismatchReasonText) {
      if (storeMeta.match === false) {
        mismatchBanner.classList.add('visible');
        mismatchBanner.style.display = 'flex';
        mismatchReasonText.textContent = storeMeta.mismatch_reason ||
          'Configured embedder differs from pinned store_meta. Vector search is disabled (SQL and BM25 remain active).';
      } else {
        mismatchBanner.classList.remove('visible');
        mismatchBanner.style.display = 'none';
      }
    }

    // 3. Tab Badge for Repair Queue & Calm Repair Button State
    const repairBadge = document.getElementById('repairQueueBadge');
    const unknownNotesCount = counts.notes ? counts.notes.unknown : 0;
    if (repairBadge) {
      repairBadge.textContent = String(unknownNotesCount);
      if (unknownNotesCount > 0) {
        repairBadge.classList.add('visible');
        repairBadge.style.display = 'inline-block';
      } else {
        repairBadge.classList.remove('visible');
        repairBadge.style.display = 'none';
      }
    }

    const btnScopeRepair = document.getElementById('btnScopeGoRepair');
    if (btnScopeRepair) {
      btnScopeRepair.className = unknownNotesCount > 0 ? 'btn btn-amber' : 'btn';
    }
    const btnShowRepairQueue = document.getElementById('btnShowRepairQueue');
    if (btnShowRepairQueue) {
      btnShowRepairQueue.className = unknownNotesCount > 0 ? 'btn btn-amber' : 'btn';
    }

    // 4. KPI Grid Cards
    const kpiGrid = document.getElementById('overviewKpiGrid');
    if (kpiGrid) {
      kpiGrid.replaceChildren();

      // Helper for type_distribution counts
      const typeDist = Array.isArray(statsData.type_distribution) ? statsData.type_distribution : [];
      const sumTypes = (types) => typeDist
        .filter((t) => types.includes(t.type))
        .reduce((acc, t) => acc + (Number(t.count) || 0), 0);

      // Card 0a: Short-Term (Sessions & Next Actions)
      const activeSessions = (statsData.sessions && typeof statsData.sessions.active === 'number')
        ? statsData.sessions.active
        : (counts.sessions && typeof counts.sessions.active === 'number')
          ? counts.sessions.active
          : (statsData.short_term && typeof statsData.short_term.active_sessions === 'number' ? statsData.short_term.active_sessions : 0);
      const readyActions = (statsData.actions && typeof statsData.actions.ready === 'number')
        ? statsData.actions.ready
        : (counts.actions && typeof counts.actions.ready === 'number')
          ? counts.actions.ready
          : (statsData.short_term && typeof statsData.short_term.ready_actions === 'number' ? statsData.short_term.ready_actions : 0);

      kpiGrid.appendChild(createKpiCard(
        'Short-Term (Working)',
        activeSessions + readyActions,
        [
          createBadge(activeSessions + ' active sessions', activeSessions > 0 ? 'emerald' : 'subtle', true),
          createBadge(readyActions + ' ready next actions', readyActions > 0 ? 'amber' : 'subtle', true)
        ],
        isStaleRevalidating
      ));

      // Card 0b: Long-Term (Memories & Lessons)
      const memoriesCount = (counts.notes && typeof counts.notes.memories === 'number')
        ? counts.notes.memories
        : (statsData.long_term && typeof statsData.long_term.memories === 'number'
          ? statsData.long_term.memories
          : sumTypes(['fact', 'architecture', 'pattern', 'workflow', 'preference']));
      const lessonsCount = (counts.notes && typeof counts.notes.lessons === 'number')
        ? counts.notes.lessons
        : (statsData.long_term && typeof statsData.long_term.lessons === 'number'
          ? statsData.long_term.lessons
          : sumTypes(['lesson', 'bug']));

      kpiGrid.appendChild(createKpiCard(
        'Long-Term (Curated)',
        memoriesCount + lessonsCount,
        [
          createBadge(memoriesCount + ' memories', memoriesCount > 0 ? 'emerald' : 'subtle', true),
          createBadge(lessonsCount + ' lessons', lessonsCount > 0 ? 'amber' : 'subtle', true)
        ],
        isStaleRevalidating
      ));

      // Card 1: Notes
      const notesTotal = counts.notes ? counts.notes.total : 0;
      const notesProject = counts.notes ? counts.notes.project : 0;
      const notesGlobal = counts.notes ? counts.notes.global : 0;
      const notesUnknown = counts.notes ? counts.notes.unknown : 0;

      kpiGrid.appendChild(createKpiCard(
        'Notes (Curated)',
        notesTotal,
        [
          createBadge(notesProject + ' project', notesProject > 0 ? 'emerald' : 'subtle', true),
          createBadge(notesGlobal + ' global', 'subtle', true),
          createBadge(notesUnknown + ' unknown', notesUnknown > 0 ? 'rose' : 'subtle', true, notesUnknown > 0 ? 'alert' : null)
        ],
        isStaleRevalidating
      ));

      // Card 2: Trajectories
      const trajTotal = counts.trajectories ? counts.trajectories.total : 0;
      const trajSuccess = counts.trajectories ? counts.trajectories.success : 0;
      const trajFailed = counts.trajectories ? counts.trajectories.failed : 0;
      const trajArchived = counts.trajectories ? counts.trajectories.archived : 0;

      kpiGrid.appendChild(createKpiCard(
        'Trajectories (Tasks)',
        trajTotal,
        [
          createBadge(trajSuccess + ' success', trajSuccess > 0 ? 'emerald' : 'subtle', true),
          createBadge(trajFailed + ' failed', trajFailed > 0 ? 'rose' : 'subtle', true),
          createBadge(trajArchived + ' archived', 'subtle', true)
        ],
        isStaleRevalidating
      ));

      // Card 3: Observations
      const obsTotal = counts.observations ? counts.observations.total : 0;
      const obsFailed = counts.observations ? counts.observations.failed : 0;
      const obsArchived = counts.observations ? counts.observations.archived : 0;

      kpiGrid.appendChild(createKpiCard(
        'Observations (Hot-Path)',
        obsTotal,
        [
          createBadge(obsFailed + ' failed', obsFailed > 0 ? 'amber' : 'subtle', true),
          createBadge(obsArchived + ' archived', 'subtle', true)
        ],
        isStaleRevalidating
      ));

      // Card 4: Summaries
      const sumTotal = counts.summaries ? counts.summaries.total : 0;
      const sumVerified = counts.summaries ? counts.summaries.verified : 0;
      const sumExpired = counts.summaries ? counts.summaries.sources_expired : 0;

      kpiGrid.appendChild(createKpiCard(
        'Extractive Summaries',
        sumTotal,
        [
          createBadge(sumVerified + ' verified', sumVerified > 0 ? 'emerald' : 'subtle', true),
          createBadge(sumExpired + ' src expired', sumExpired > 0 ? 'amber' : 'subtle', true)
        ],
        isStaleRevalidating
      ));

      // Card 5: Failure Patterns
      const fpCount = counts.failure_patterns || 0;
      kpiGrid.appendChild(createKpiCard(
        'Failure Patterns',
        fpCount,
        [createBadge('Atomic SQL UPSERT', fpCount > 0 ? 'amber' : 'subtle', true)],
        isStaleRevalidating
      ));

      // Card 6: Embed Queue
      const eqPending = health.embed_queue_pending || 0;
      const eqStats = health.embed_queue_stats || {};
      const eqFailed = eqStats.failed || 0;
      const eqBadges = [
        createBadge(eqPending + ' pending', eqPending > 0 ? 'amber' : 'subtle', true),
        createBadge((eqStats.done || 0) + ' indexed', 'subtle', true),
        createBadge(eqFailed + ' failed', eqFailed > 0 ? 'rose' : 'subtle', true)
      ];
      if (reembedStatus && reembedStatus.status !== 'idle') {
        const total = reembedStatus.total || 0;
        const processed = reembedStatus.processed || 0;
        const badgeVariant = reembedStatus.status === 'running'
          ? 'amber'
          : reembedStatus.status === 'completed'
            ? 'emerald'
            : 'rose';
        const label = reembedStatus.status === 'failed'
          ? 'reembed: failed'
          : 'reembed: ' + processed + '/' + total;
        eqBadges.push(createBadge(label, badgeVariant, true));
      }
      kpiGrid.appendChild(createKpiCard(
        'Embed Queue (Live)',
        eqPending,
        eqBadges,
        isStaleRevalidating
      ));

      // Card 7: Dead Letters
      const dlCount = counts.dead_letters || 0;
      kpiGrid.appendChild(createKpiCard(
        'Dead Letters (Malformed)',
        dlCount,
        [createBadge('Rule 3: 0 volume drops', dlCount > 0 ? 'rose' : 'subtle', true)],
        isStaleRevalidating
      ));
    }

    // 5. Scope Progress Bar (Rule 4 Telemetry)
    const progressBar = document.getElementById('scopeProgressBar');
    const legendProject = document.getElementById('legendCountProject');
    const legendGlobal = document.getElementById('legendCountGlobal');
    const legendUnknown = document.getElementById('legendCountUnknown');

    const pCount = counts.notes ? counts.notes.project : 0;
    const gCount = counts.notes ? counts.notes.global : 0;
    const uCount = counts.notes ? counts.notes.unknown : 0;
    const totalNotes = pCount + gCount + uCount;

    if (legendProject) legendProject.textContent = String(pCount);
    if (legendGlobal) legendGlobal.textContent = String(gCount);
    if (legendUnknown) legendUnknown.textContent = String(uCount);

    if (progressBar) {
      progressBar.replaceChildren();
      if (totalNotes > 0) {
        const pPct = ((pCount / totalNotes) * 100).toFixed(1);
        const gPct = ((gCount / totalNotes) * 100).toFixed(1);
        const uPct = ((uCount / totalNotes) * 100).toFixed(1);

        if (pCount > 0) {
          progressBar.appendChild(el('div', {
            className: 'scope-bar-segment scope-bar-project',
            style: { width: pPct + '%' },
            title: 'Project Scoped: ' + pCount + ' (' + pPct + '%)'
          }));
        }
        if (gCount > 0) {
          progressBar.appendChild(el('div', {
            className: 'scope-bar-segment scope-bar-global',
            style: { width: gPct + '%' },
            title: 'Global Scoped: ' + gCount + ' (' + gPct + '%)'
          }));
        }
        if (uCount > 0) {
          progressBar.appendChild(el('div', {
            className: 'scope-bar-segment scope-bar-unknown',
            style: { width: uPct + '%' },
            title: 'Unknown Scoped (Repair Queue): ' + uCount + ' (' + uPct + '%)'
          }));
        }
      }
    }

    // 6. Note Type Distribution
    const typeContainer = document.getElementById('typeDistributionContainer');
    if (typeContainer && statsData.type_distribution) {
      typeContainer.replaceChildren();
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });

      const maxCount = Math.max(...statsData.type_distribution.map((t) => t.count), 1);

      statsData.type_distribution.forEach((item) => {
        const pct = ((item.count / maxCount) * 100).toFixed(0);
        const row = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          el('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '14px' } },
            el('span', { style: { fontWeight: '600', textTransform: 'capitalize' } }, item.type),
            el('span', { className: 'code-pill' }, item.count + ' notes')
          ),
          el('div', { style: { height: '8px', background: 'var(--bg-subtle)', borderRadius: '4px', overflow: 'hidden' } },
            el('div', {
              style: {
                height: '100%',
                width: pct + '%',
                background: getTypeColor(item.type),
                borderRadius: '4px'
              }
            })
          )
        );
        list.appendChild(row);
      });
      typeContainer.appendChild(list);
    }

    // 7. Client Spool Telemetry
    const spoolContainer = document.getElementById('spoolStatsContainer');
    if (spoolContainer && statsData.spool) {
      spoolContainer.replaceChildren();
      const spool = statsData.spool;
      const kbSize = (spool.bytes / 1024).toFixed(1);
      const maxMb = (spool.maxBytes / (1024 * 1024)).toFixed(0);

      const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px' } },
        createSubMetricCard('Spool Records', String(spool.count), 'Pending flush'),
        createSubMetricCard('Buffer Size', kbSize + ' KB / ' + maxMb + ' MB', 'Max disk cap'),
        createSubMetricCard('Max Retention', spool.maxAgeHours + ' hours', 'Auto-prune window'),
        createSubMetricCard('Oldest Buffer Age', formatTimestamp(spool.oldestTimestamp), 'Spool epoch')
      );
      spoolContainer.appendChild(grid);
    }

    // 8. Discovered Projects Breakdown Table
    const projectsContainer = document.getElementById('projectsTableContainer');
    if (projectsContainer && statsData.projects) {
      projectsContainer.replaceChildren();
      const table = el('table', { className: 'data-table' },
        el('thead', {},
          el('tr', {},
            el('th', {}, 'Project Identifier'),
            el('th', {}, 'Notes'),
            el('th', {}, 'Trajectories'),
            el('th', {}, 'Observations'),
            el('th', {}, 'Total Records'),
            el('th', {}, 'Actions')
          )
        ),
        el('tbody', {},
          ...statsData.projects.map((proj) => {
            const totalGrains = proj.notes_count + proj.trajectories_count + proj.observations_count;
            return el('tr', {},
              el('td', {},
                el('strong', { className: 'text-mono', style: { color: 'var(--text-primary)' } }, proj.project_id)
              ),
              el('td', {}, el('span', { className: 'code-pill' }, String(proj.notes_count))),
              el('td', {}, el('span', { className: 'code-pill' }, String(proj.trajectories_count))),
              el('td', {}, el('span', { className: 'code-pill' }, String(proj.observations_count))),
              el('td', {}, el('span', { className: 'badge badge-subtle badge-mono' }, String(totalGrains))),
              el('td', {},
                el('button', {
                  type: 'button',
                  className: 'btn hit-slop',
                  style: { height: '28px', padding: '0 10px', fontSize: '12px' },
                  onClick: () => {
                    switchTab('notes');
                    const projInput = document.getElementById('notesFilterProject');
                    if (projInput) projInput.value = proj.project_id;
                    const scopeSelect = document.getElementById('notesFilterScope');
                    if (scopeSelect) scopeSelect.value = 'project';
                    applyNotesFilter();
                  }
                }, 'Explore Notes')
              )
            );
          })
        )
      );
      projectsContainer.appendChild(table);
    }
  }

  function createKpiCard(label, value, breakdownNodes = [], isUpdating = false) {
    const card = el('div', { className: 'kpi-card' });
    const top = el('div', { className: 'kpi-top' },
      el('span', { className: 'kpi-label', textContent: label }),
      isUpdating ? el('span', { className: 'swr-updating-badge', textContent: 'updating' }) : null
    );
    const val = el('div', { className: 'kpi-value tabular-nums', textContent: String(value) });
    const breakdown = el('div', { className: 'kpi-breakdown' });
    breakdown.append(...breakdownNodes);

    card.appendChild(top);
    card.appendChild(val);
    card.appendChild(breakdown);
    return card;
  }

  function createSubMetricCard(title, value, sub) {
    return el('div', {
      style: {
        backgroundColor: 'var(--bg-subtle)',
        padding: '12px',
        borderRadius: '8px',
        border: '1px solid var(--border-color)'
      }
    },
      el('div', { style: { fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase' } }, title),
      el('div', { className: 'tabular-nums', style: { fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)', margin: '4px 0' } }, value),
      el('div', { style: { fontSize: '12px', color: 'var(--text-secondary)' } }, sub)
    );
  }

  function getTypeColor(type) {
    switch (type) {
      case 'bug': return 'var(--accent-rose)';
      case 'lesson': return 'var(--accent-amber)';
      case 'preference': return 'var(--accent-amber)';
      case 'architecture': return 'var(--accent-emerald-deep)';
      case 'pattern': return 'var(--text-secondary)';
      case 'workflow': return 'var(--accent-emerald)';
      case 'fact':
      default: return 'var(--accent-emerald)';
    }
  }

  // Amazon Safe Triangle Geometry for Diagonal Submenu Hover Protection
  let prevMousePoint = { x: 0, y: 0 };
  let currMousePoint = { x: 0, y: 0 };

  function pointCrossSign(p1, p2, p3) {
    return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  }

  function isPointInTriangle(pt, v1, v2, v3) {
    const d1 = pointCrossSign(pt, v1, v2);
    const d2 = pointCrossSign(pt, v2, v3);
    const d3 = pointCrossSign(pt, v3, v1);
    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(hasNeg && hasPos);
  }

  function isInSafeTriangle(point, apex, menuRect) {
    if (!point || !apex || !menuRect) return false;
    const upperLeft = { x: menuRect.left, y: menuRect.top };
    const upperRight = { x: menuRect.right, y: menuRect.top };
    const lowerLeft = { x: menuRect.left, y: menuRect.bottom };
    const lowerRight = { x: menuRect.right, y: menuRect.bottom };
    return isPointInTriangle(point, apex, upperLeft, upperRight) ||
      isPointInTriangle(point, apex, upperLeft, lowerLeft) ||
      isPointInTriangle(point, apex, lowerLeft, lowerRight);
  }

  // Reusable Searchable Project Dropdown Controller & Known Projects Registry
  const knownProjects = new Map(); // project_id -> { notes_count, total }
  const activeDropdownControllers = new Set();

  function notifyDropdowns() {
    activeDropdownControllers.forEach((ctrl) => {
      try {
        if (ctrl.wrapper && document.body.contains(ctrl.wrapper)) {
          ctrl.render();
        } else {
          activeDropdownControllers.delete(ctrl);
        }
      } catch {
        activeDropdownControllers.delete(ctrl);
      }
    });
  }

  function renderProjectDropdown() {
    notifyDropdowns();
  }

  function attachSearchableProjectDropdown(wrapperEl, inputEl, options = {}) {
    if (!wrapperEl || !inputEl) return null;

    wrapperEl.classList.add('searchable-dropdown');

    inputEl.setAttribute('autocomplete', 'off');
    inputEl.setAttribute('role', 'combobox');
    inputEl.setAttribute('aria-autocomplete', 'list');
    inputEl.setAttribute('aria-expanded', 'false');

    let chevron = wrapperEl.querySelector('.dropdown-chevron');
    if (!chevron) {
      const chevSvg = createSvgIcon('chevron');
      chevSvg.style.width = '12px';
      chevSvg.style.height = '12px';
      chevron = el('span', { className: 'dropdown-chevron', title: 'Toggle project dropdown' }, chevSvg);
      wrapperEl.appendChild(chevron);
    }
    chevron.setAttribute('role', 'button');
    chevron.setAttribute('tabindex', '0');
    chevron.setAttribute('aria-label', 'Toggle project dropdown');
    chevron.setAttribute('aria-expanded', 'false');

    let menu = wrapperEl.querySelector('.dropdown-menu');
    if (!menu) {
      menu = el('div', { className: 'dropdown-menu' });
      wrapperEl.appendChild(menu);
    }
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Project options');

    const includeAllOption = Boolean(options.includeAllOption);
    const allOptionLabel = options.allOptionLabel || 'All Projects';
    let safeTriangleTimer = null;

    function renderMenu(filterText = '') {
      menu.replaceChildren();
      const currentVal = inputEl.value.trim();
      const normFilter = filterText.trim().toLowerCase();

      // 1. "All Projects" option
      if (includeAllOption) {
        const isAllSelected = !currentVal || currentVal.toLowerCase() === allOptionLabel.toLowerCase() || currentVal.toLowerCase() === 'all projects';
        const selectAll = (e) => {
          e.stopPropagation();
          inputEl.value = '';
          closeDropdown();
          if (options.onSelect) options.onSelect('');
        };
        const allItem = el('div', {
          className: 'dropdown-item' + (isAllSelected ? ' selected' : ''),
          role: 'option',
          tabindex: '0',
          'aria-selected': isAllSelected ? 'true' : 'false',
          onClick: selectAll,
          onKeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectAll(e);
              inputEl.focus();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              closeDropdown();
              inputEl.focus();
            }
          }
        },
          el('span', { className: 'font-semibold' }, allOptionLabel),
          el('span', { className: 'badge badge-subtle badge-clear' }, 'Clear')
        );
        menu.appendChild(allItem);
      }

      // 2. Filter distinct project IDs from knownProjects
      const projectIds = Array.from(knownProjects.keys()).sort();
      let matches = 0;

      for (const pid of projectIds) {
        if (normFilter && normFilter !== 'all projects' && normFilter !== allOptionLabel.toLowerCase() && !pid.toLowerCase().includes(normFilter)) {
          continue;
        }
        matches++;
        const meta = knownProjects.get(pid);
        const isSelected = currentVal.toLowerCase() === pid.toLowerCase();

        const selectPid = (e) => {
          e.stopPropagation();
          inputEl.value = pid;
          closeDropdown();
          if (options.onSelect) options.onSelect(pid);
        };
        const item = el('div', {
          className: 'dropdown-item' + (isSelected ? ' selected' : ''),
          role: 'option',
          tabindex: '0',
          'aria-selected': isSelected ? 'true' : 'false',
          onClick: selectPid,
          onKeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectPid(e);
              inputEl.focus();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              closeDropdown();
              inputEl.focus();
            }
          }
        },
          el('span', { className: 'text-mono' }, pid),
          meta && meta.notes_count ? el('span', { className: 'badge badge-subtle badge-count' }, meta.notes_count + ' notes') : null
        );
        menu.appendChild(item);
      }

      if (normFilter && normFilter !== 'all projects' && normFilter !== allOptionLabel.toLowerCase() && matches === 0) {
        menu.appendChild(
          el('div', { className: 'dropdown-empty' }, 'No matching projects (type to create)')
        );
      }
    }

    function openDropdown() {
      if (safeTriangleTimer) {
        clearTimeout(safeTriangleTimer);
        safeTriangleTimer = null;
      }
      // Close other open dropdowns first to prevent overlap
      document.querySelectorAll('.searchable-dropdown.open').forEach((w) => {
        if (w !== wrapperEl) {
          w.classList.remove('open');
          const m = w.querySelector('.dropdown-menu');
          if (m) m.classList.remove('open');
          const inp = w.querySelector('input');
          if (inp) inp.setAttribute('aria-expanded', 'false');
          const chv = w.querySelector('.dropdown-chevron');
          if (chv) chv.setAttribute('aria-expanded', 'false');
        }
      });

      wrapperEl.classList.add('open');
      menu.classList.add('open');
      inputEl.setAttribute('aria-expanded', 'true');
      chevron.setAttribute('aria-expanded', 'true');
      const val = inputEl.value.trim();
      renderMenu(val.toLowerCase() === 'all projects' || val.toLowerCase() === allOptionLabel.toLowerCase() ? '' : val);
    }

    function closeDropdown() {
      if (safeTriangleTimer) {
        clearTimeout(safeTriangleTimer);
        safeTriangleTimer = null;
      }
      wrapperEl.classList.remove('open');
      menu.classList.remove('open');
      inputEl.setAttribute('aria-expanded', 'false');
      chevron.setAttribute('aria-expanded', 'false');
    }

    function toggleDropdown() {
      if (wrapperEl.classList.contains('open')) {
        closeDropdown();
      } else {
        openDropdown();
      }
    }

    wrapperEl.addEventListener('mouseleave', (e) => {
      if (!wrapperEl.classList.contains('open')) return;
      if (document.activeElement === inputEl) return;
      const menuRect = menu.getBoundingClientRect();
      const pointer = { x: e.clientX, y: e.clientY };
      if (isInSafeTriangle(pointer, prevMousePoint, menuRect)) {
        safeTriangleTimer = setTimeout(() => {
          if (!wrapperEl.matches(':hover') && document.activeElement !== inputEl) {
            closeDropdown();
          }
        }, 260);
      }
    });

    menu.addEventListener('mouseenter', () => {
      if (safeTriangleTimer) {
        clearTimeout(safeTriangleTimer);
        safeTriangleTimer = null;
      }
    });

    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropdown();
    });

    chevron.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        toggleDropdown();
      } else if (e.key === 'Escape' && wrapperEl.classList.contains('open')) {
        e.stopPropagation();
        closeDropdown();
      }
    });

    inputEl.addEventListener('focus', () => {
      openDropdown();
    });

    inputEl.addEventListener('click', (e) => {
      e.stopPropagation();
      openDropdown();
    });

    inputEl.addEventListener('input', () => {
      openDropdown();
      renderMenu(inputEl.value.trim());
      if (options.onInput) options.onInput(inputEl.value.trim());
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (wrapperEl.classList.contains('open')) {
          e.stopPropagation();
          closeDropdown();
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!wrapperEl.classList.contains('open')) {
          openDropdown();
        }
        const firstOpt = menu.querySelector('.dropdown-item');
        if (firstOpt && typeof firstOpt.focus === 'function') {
          firstOpt.focus();
        }
      } else if (e.key === 'Enter') {
        closeDropdown();
        if (options.onEnter) options.onEnter(inputEl.value.trim());
      }
    });

    const controller = {
      open: openDropdown,
      close: closeDropdown,
      render: () => renderMenu(inputEl.value.trim()),
      input: inputEl,
      wrapper: wrapperEl,
    };
    activeDropdownControllers.add(controller);
    return controller;
  }

  function renderProjectCarousel() {
    const carousel = document.getElementById('projectQuickCarousel');
    const track = document.getElementById('projectCarouselTrack');
    if (!track) return;
    if (carousel) carousel.classList.remove('hidden');

    const projInput = document.getElementById('notesFilterProject');
    const currentFilter = projInput ? projInput.value.trim() : '';
    const normFilter = currentFilter.toLowerCase() === 'all projects' ? '' : currentFilter;

    track.replaceChildren();

    const totalNotes = Array.from(knownProjects.values()).reduce((sum, m) => sum + (m.notes_count || 0), 0);
    const selectCarouselProject = (pid) => {
      const notesProjInput = document.getElementById('notesFilterProject');
      const notesScopeSel = document.getElementById('notesFilterScope');
      if (notesProjInput) notesProjInput.value = pid;
      if (notesScopeSel) notesScopeSel.value = pid ? 'project' : '';
      activeNotesCategory = 'all';
      updateNotesCategoryPills();
      renderProjectCarousel();
      if (activeTab !== 'notes') {
        switchTab('notes');
      } else {
        applyNotesFilter();
      }
    };

    track.appendChild(
      el('button', {
        type: 'button',
        className: 'carousel-pill' + (!normFilter ? ' active' : ''),
        onClick: () => selectCarouselProject('')
      },
        createSvgIcon('layers'),
        el('span', {}, 'All Projects'),
        el('span', { className: 'code-pill' }, String(totalNotes))
      )
    );

    const sortedProjects = Array.from(knownProjects.entries()).sort((a, b) => {
      const diff = (b[1].notes_count || 0) - (a[1].notes_count || 0);
      return diff !== 0 ? diff : a[0].localeCompare(b[0]);
    });

    sortedProjects.forEach(([pid, meta]) => {
      const isSelected = normFilter.toLowerCase() === pid.toLowerCase();
      track.appendChild(
        el('button', {
          type: 'button',
          className: 'carousel-pill' + (isSelected ? ' active' : ''),
          onClick: () => selectCarouselProject(pid)
        },
          createSvgIcon('folder'),
          el('span', { className: 'text-mono' }, pid),
          el('span', { className: 'code-pill' }, String(meta.notes_count || 0))
        )
      );
    });

    initBlurHashPlaceholders();
  }

  function syncKnownProjects() {
    if (statsData && Array.isArray(statsData.projects)) {
      statsData.projects.forEach((p) => {
        if (p.project_id) {
          knownProjects.set(p.project_id, {
            notes_count: p.notes_count || 0,
            total: (p.notes_count || 0) + (p.trajectories_count || 0) + (p.observations_count || 0)
          });
        }
      });
    }
    notifyDropdowns();
    renderProjectCarousel();
  }

  const standardTaskTypes = [
    'general',
    'implementation',
    'bugfix',
    'refactor',
    'migration',
    'testing',
    'security',
    'deployment'
  ];

  function syncTaskTypes() {
    const select = document.getElementById('injectInputTaskType');
    if (!select) return;
    const currentVal = select.value || 'migration';
    const discovered = new Set(standardTaskTypes);

    if (statsData) {
      if (Array.isArray(statsData.failure_patterns)) {
        statsData.failure_patterns.forEach((fp) => {
          if (fp.task_type) discovered.add(fp.task_type);
        });
      }
      if (Array.isArray(statsData.recent_trajectories)) {
        statsData.recent_trajectories.forEach((t) => {
          if (t.task_type) discovered.add(t.task_type);
        });
      }
    }

    select.replaceChildren();
    const allOpt = el('option', { value: '' }, 'All / Any Task Type');
    select.appendChild(allOpt);

    const sorted = Array.from(discovered).sort();
    sorted.forEach((tt) => {
      const opt = el('option', { value: tt }, tt);
      if (tt === currentVal) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  }

  // Tab 2: Hybrid Search & Push Injection Workbench
  function initSearchWorkbench() {
    const searchForm = document.getElementById('searchForm');
    if (searchForm) {
      searchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        executeSearch();
      });
    }

    const btnSearch = document.getElementById('btnExecuteSearch');
    if (btnSearch) {
      btnSearch.addEventListener('click', executeSearch);
    }

    const searchInput = document.getElementById('searchInputQ');
    if (searchInput) {
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          executeSearch();
        }
      });
    }

    const searchProjectWrapper = document.getElementById('searchProjectDropdownWrapper');
    const searchProjectInput = document.getElementById('searchInputProject');
    if (searchProjectWrapper && searchProjectInput) {
      attachSearchableProjectDropdown(searchProjectWrapper, searchProjectInput, {
        includeAllOption: true,
        allOptionLabel: 'All Projects (Global)',
        onSelect: () => executeSearch(),
        onEnter: () => executeSearch()
      });
    }

    const injectProjectWrapper = document.getElementById('injectProjectDropdownWrapper');
    const injectProjectInput = document.getElementById('injectInputProject');
    if (injectProjectWrapper && injectProjectInput) {
      attachSearchableProjectDropdown(injectProjectWrapper, injectProjectInput, {
        includeAllOption: false
      });
    }

    const injectForm = document.getElementById('injectForm');
    if (injectForm) {
      injectForm.addEventListener('submit', (e) => {
        e.preventDefault();
        executeInjection();
      });
    }

    const btnInject = document.getElementById('btnExecuteInject');
    if (btnInject) {
      btnInject.addEventListener('click', executeInjection);
    }
  }

  async function executeSearch() {
    const queryInput = document.getElementById('searchInputQ');
    const q = queryInput ? queryInput.value.trim() : '';
    if (!q) {
      showToast('Please enter a search query', 'amber');
      return;
    }

    const scopeSelect = document.getElementById('searchSelectScope');
    const projectInput = document.getElementById('searchInputProject');
    const checkGlobal = document.getElementById('searchCheckGlobal');
    const fileInput = document.getElementById('searchInputFilePath');
    const noteTypeSelect = document.getElementById('searchNoteType');

    const recordTypes = [];
    if (document.getElementById('recordTypeCheckNote')?.checked) recordTypes.push('note');
    if (document.getElementById('recordTypeCheckTrajectory')?.checked) recordTypes.push('trajectory');
    if (document.getElementById('recordTypeCheckObservation')?.checked) recordTypes.push('observation');
    if (document.getElementById('recordTypeCheckSummary')?.checked) recordTypes.push('summary');

    let proj = projectInput ? projectInput.value.trim() : '';
    if (proj.toLowerCase() === 'all projects (global)' || proj.toLowerCase() === 'all projects') {
      proj = '';
    }

    const selectedNoteType = noteTypeSelect && noteTypeSelect.value ? noteTypeSelect.value.trim() : '';
    const filters = {};
    if (fileInput && fileInput.value.trim()) {
      filters.file_path = fileInput.value.trim();
    }
    if (selectedNoteType) {
      filters.type = [selectedNoteType];
    }

    const payload = {
      q,
      record_types: recordTypes.length > 0 ? recordTypes : undefined,
      scope: scopeSelect && scopeSelect.value ? scopeSelect.value : undefined,
      project_id: proj || undefined,
      include_global: checkGlobal ? checkGlobal.checked : true,
      filters: Object.keys(filters).length > 0 ? filters : undefined,
      limit: 20
    };

    const resultsContainer = document.getElementById('searchResultsContainer');
    const metaBar = document.getElementById('searchMetaBar');
    if (resultsContainer) {
      resultsContainer.replaceChildren(
        createSkeletonLoader('list', 3, 'Searching brain with RRF fusion...')
      );
    }

    try {
      const startTime = performance.now();
      const resp = await apiFetch('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const durationMs = Math.round(performance.now() - startTime);

      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        throw new Error(errJson.error?.message || 'Search failed with status ' + resp.status);
      }

      const data = await resp.json();
      renderSearchResults(data, durationMs);
    } catch (err) {
      if (resultsContainer) {
        resultsContainer.replaceChildren(
          el('div', { className: 'toast toast-rose', style: { position: 'static' } },
            el('span', {}, 'Search Error: ' + err.message)
          )
        );
      }
    }
  }

  function renderSearchResults(data, durationMs) {
    const resultsContainer = document.getElementById('searchResultsContainer');
    const metaBar = document.getElementById('searchMetaBar');
    if (!resultsContainer || !metaBar) return;

    metaBar.style.display = 'flex';
    metaBar.replaceChildren();

    const mode = data.mode || (data.degraded ? 'bm25-degraded' : 'hybrid');
    const modeBadge = createBadge('MODE: ' + mode.toUpperCase(), mode.includes('bm25') ? 'amber' : 'emerald', true);
    const countBadge = createBadge((data.results ? data.results.length : 0) + ' results (' + durationMs + 'ms)', 'subtle', true);

    metaBar.appendChild(modeBadge);
    metaBar.appendChild(countBadge);

    if (data.degraded) {
      const degradedBanner = createBadge(data.degraded, 'rose', true, 'alert');
      degradedBanner.style.marginLeft = 'auto';
      metaBar.appendChild(degradedBanner);
    }

    resultsContainer.replaceChildren();

    if (!data.results || data.results.length === 0) {
      resultsContainer.appendChild(
        el('div', { className: 'text-muted', style: { padding: '24px', textAlign: 'center' } },
          'No matching records found. Try broader keywords or toggle scope to global/unknown.'
        )
      );
      return;
    }

    data.results.forEach((item, index) => {
      const rec = item.record || item;
      const card = el('div', { className: 'result-card' });

      // Header row
      const recordType = item.record_type || item.grain || 'record';
      const typeVariant = recordType === 'note' ? 'emerald' : recordType === 'summary' ? 'emerald' : recordType === 'trajectory' ? 'subtle' : 'amber';
      const typeBadge = createBadge(recordType.toUpperCase(), typeVariant, true);

      const scopeVal = rec.scope || item.scope;
      const projectVal = rec.project_id || item.project_id;
      const scopeVariant = scopeVal === 'project' ? 'emerald' : (scopeVal === 'unknown' ? 'rose' : 'subtle');

      const rrfScore = typeof item.score === 'number' ? item.score.toFixed(4) : String(item.score || '');
      const scoreSpan = el('span', { className: 'result-score' }, 'RRF Score: ' + rrfScore);

      const header = el('div', { className: 'result-header' },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          el('span', { className: 'code-pill' }, '#' + (index + 1)),
          typeBadge,
          scopeVal ? createBadge(scopeVal + (projectVal ? ': ' + projectVal : ''), scopeVariant, true) : null
        ),
        scoreSpan
      );

      // Title & Content
      const titleText = rec.title || rec.task_type || rec.tool_name || item.title || item.id;
      const bodyText = rec.content || rec.description || rec.input || rec.output || item.content || '';

      const titleEl = el('div', { className: 'result-title', textContent: titleText });
      const bodyEl = el('div', { className: 'result-body', textContent: bodyText });

      // Tag list (concepts, files)
      const tagList = el('div', { className: 'tag-list' });
      const conceptsList = Array.isArray(rec.concepts) ? rec.concepts : (Array.isArray(item.concepts) ? item.concepts : []);
      const filesList = Array.isArray(rec.files) ? rec.files : (Array.isArray(item.files) ? item.files : []);
      const filePath = rec.file_path || item.file_path;

      conceptsList.forEach((c) => tagList.appendChild(createBadge('#' + c, 'subtle', true)));
      filesList.forEach((f) => tagList.appendChild(createBadge(f, 'subtle', true, 'folder')));
      if (filePath) {
        tagList.appendChild(createBadge(filePath, 'subtle', true, 'folder'));
      }

      const tsVal = rec.created_at || rec.updated_at || item.created_at || item.updated_at;

      card.appendChild(header);
      card.appendChild(titleEl);
      card.appendChild(bodyEl);
      if (tagList.children.length > 0) {
        card.appendChild(tagList);
      }
      card.appendChild(createProvenanceLine(
        'source: ' + recordType + ' · ' + item.id + ' · ' + formatTimestamp(tsVal)
      ));

      resultsContainer.appendChild(card);
    });
  }

  async function executeInjection() {
    const projectInput = document.getElementById('injectInputProject');
    const taskTypeInput = document.getElementById('injectInputTaskType');
    const container = document.getElementById('injectOutputContainer');
    if (!container) return;

    const proj = projectInput ? projectInput.value.trim() : '';
    const task = taskTypeInput ? taskTypeInput.value.trim() : '';

    if (!proj) {
      showToast('Please specify a project_id for injection simulation', 'amber');
      return;
    }

    container.replaceChildren(
      createSkeletonLoader('list', 3, 'Simulating task-start injection...')
    );

    try {
      const url = '/inject?project_id=' + encodeURIComponent(proj) + (task ? '&task_type=' + encodeURIComponent(task) : '') + '&limit=5';
      const resp = await apiFetch(url);
      if (!resp.ok) {
        throw new Error('Injection request failed: ' + resp.status);
      }

      const data = await resp.json();
      renderInjectionOutput(data, proj, task);
    } catch (err) {
      container.replaceChildren(
        el('div', { className: 'toast toast-rose', style: { position: 'static' } },
          el('span', {}, 'Injection Error: ' + err.message)
        )
      );
    }
  }

  function renderInjectionOutput(data, proj, task) {
    const container = document.getElementById('injectOutputContainer');
    if (!container) return;
    container.replaceChildren();

    // 1. Critical Warnings Block (NeuralSwarm reference text)
    const warningBlock = el('div', { style: { marginBottom: '16px' } });
    const warningTitle = el('div', {
      style: {
        fontSize: '14px',
        fontWeight: '700',
        color: 'var(--accent-amber)',
        marginBottom: '8px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px'
      }
    },
      createSvgIcon('alert'),
      el('span', {}, 'CRITICAL WARNINGS (Learn from past failures in project: ' + proj + ')')
    );

    const formattedPre = el('pre', {
      className: 'code-block',
      textContent: data.formatted_warnings || 'No critical failure warnings recorded for this project/task_type.'
    });

    warningBlock.appendChild(warningTitle);
    warningBlock.appendChild(formattedPre);
    container.appendChild(warningBlock);

    // 2. Scoped Failure Patterns Section
    const fpCount = Array.isArray(data.failure_patterns) ? data.failure_patterns.length : 0;
    const fpSection = el('div', { style: { marginBottom: '16px' } },
      el('div', { style: { fontSize: '14px', fontWeight: '700', marginBottom: '8px' } },
        'Scoped Failure Patterns (' + fpCount + ' patterns with SQL counts)'
      )
    );

    if (fpCount === 0) {
      fpSection.appendChild(el('div', { className: 'text-muted', style: { fontSize: '12px' } }, 'None recorded.'));
    } else {
      data.failure_patterns.forEach((fp) => {
        const item = el('div', { className: 'result-card', style: { padding: '12px' } },
          el('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '6px' } },
            createBadge('COUNT: ' + fp.count + ' occurrences', 'rose', true),
            el('span', { className: 'code-pill' }, 'task_type: ' + fp.task_type)
          ),
          el('div', { className: 'code-block', style: { padding: '8px', fontSize: '12px' }, textContent: fp.error_text }),
          createProvenanceLine('source: failure_patterns · last_seen: ' + formatTimestamp(fp.last_seen_at))
        );
        fpSection.appendChild(item);
      });
    }
    container.appendChild(fpSection);

    // 3. Relevant Curated Notes
    const notesCount = Array.isArray(data.notes) ? data.notes.length : 0;
    const notesSection = el('div', {},
      el('div', { style: { fontSize: '14px', fontWeight: '700', marginBottom: '8px' } },
        'Relevant Project Knowledge (' + notesCount + ' bug/pattern/preference notes)'
      )
    );

    if (notesCount === 0) {
      notesSection.appendChild(el('div', { className: 'text-muted', style: { fontSize: '12px' } }, 'No relevant notes found for this scope.'));
    } else {
      data.notes.forEach((note) => {
        const noteVariant = note.type === 'bug' ? 'rose' : (note.type === 'lesson' ? 'amber' : 'subtle');
        const noteCard = el('div', { className: 'result-card', style: { padding: '12px' } },
          el('div', { style: { display: 'flex', gap: '8px', marginBottom: '4px' } },
            createBadge(note.type.toUpperCase(), noteVariant, true),
            el('strong', { textContent: note.title })
          ),
          el('div', { style: { fontSize: '12px', color: 'var(--text-secondary)' }, textContent: note.content }),
          createProvenanceLine('source: note · ' + (note.id || 'injected') + ' · ' + formatTimestamp(note.created_at))
        );
        notesSection.appendChild(noteCard);
      });
    }
    container.appendChild(notesSection);
  }

  function updateNotesCategoryPills() {
    const pillButtons = document.querySelectorAll('#notesCategoryPills button[data-note-category]');
    pillButtons.forEach((btn) => {
      const cat = btn.getAttribute('data-note-category');
      const isSelected = cat === activeNotesCategory;
      btn.className = isSelected ? 'btn btn-primary' : 'btn';
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    });
  }

  // Tab 3: Notes Explorer & Scope Repair Queue
  function initNotesTab() {
    const pillButtons = document.querySelectorAll('#notesCategoryPills button[data-note-category]');
    pillButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const cat = btn.getAttribute('data-note-category') || 'all';
        activeNotesCategory = cat;
        updateNotesCategoryPills();

        const scopeSelect = document.getElementById('notesFilterScope');
        const typeSelect = document.getElementById('notesFilterType');
        if (typeSelect) typeSelect.value = '';
        if (scopeSelect) {
          if (cat === 'unknown') {
            scopeSelect.value = 'unknown';
          } else if (scopeSelect.value === 'unknown') {
            scopeSelect.value = '';
          }
        }
        applyNotesFilter();
      });
    });

    const btnApply = document.getElementById('btnApplyNotesFilter');
    if (btnApply) {
      btnApply.addEventListener('click', applyNotesFilter);
    }

    const btnCreateModal = document.getElementById('btnOpenCreateNoteModal');
    if (btnCreateModal) {
      btnCreateModal.addEventListener('click', openCreateNoteModal);
    }

    const notesProjectWrapper = document.getElementById('notesProjectDropdownWrapper');
    const notesProjectInput = document.getElementById('notesFilterProject');
    if (notesProjectWrapper && notesProjectInput) {
      attachSearchableProjectDropdown(notesProjectWrapper, notesProjectInput, {
        includeAllOption: true,
        allOptionLabel: 'All Projects',
        onSelect: () => applyNotesFilter(),
        onEnter: () => applyNotesFilter()
      });
    }
  }

  async function applyNotesFilter() {
    const scopeSelect = document.getElementById('notesFilterScope');
    const projectInput = document.getElementById('notesFilterProject');
    const typeSelect = document.getElementById('notesFilterType');
    const fileInput = document.getElementById('notesFilterFile');

    let projectVal = projectInput ? projectInput.value.trim() : '';
    if (projectVal.toLowerCase() === 'all projects') projectVal = '';

    const params = new URLSearchParams();
    if (scopeSelect && scopeSelect.value) {
      params.set('scope', scopeSelect.value);
    } else if (activeNotesCategory === 'unknown') {
      params.set('scope', 'unknown');
    }
    if (projectVal) params.set('project_id', projectVal);

    if (typeSelect && typeSelect.value) {
      params.set('type', typeSelect.value);
    } else if (activeNotesCategory === 'memories') {
      ['fact', 'architecture', 'pattern', 'workflow', 'preference'].forEach((t) => params.append('type', t));
    } else if (activeNotesCategory === 'lessons') {
      ['lesson', 'bug'].forEach((t) => params.append('type', t));
    }

    if (fileInput && fileInput.value.trim()) params.set('file_path', fileInput.value.trim());
    params.set('limit', '50');
    renderProjectCarousel();

    const listContainer = document.getElementById('notesListContainer');
    const cacheKey = params.toString() || 'default';
    const cachedNotes = swrCache.notes.get(cacheKey) || (cacheKey === 'limit=50' ? swrCache.notes.get('default') : null);
    if (cachedNotes) {
      renderNotesList(cachedNotes, scopeSelect ? scopeSelect.value : '', true);
    } else if (listContainer) {
      listContainer.replaceChildren(
        createSkeletonLoader('list', 3, 'Loading notes...')
      );
    }

    try {
      const resp = await apiFetch('/notes?' + params.toString());
      if (!resp.ok) throw new Error('Notes query failed: ' + resp.status);
      const notes = await resp.json();
      swrCache.notes.set(cacheKey, notes);
      if (cacheKey === 'limit=50') swrCache.notes.set('default', notes);
      renderNotesList(notes, scopeSelect ? scopeSelect.value : '', false);
    } catch (err) {
      if (listContainer && !cachedNotes) {
        listContainer.replaceChildren(
          el('div', { className: 'toast toast-rose', style: { position: 'static' } },
            el('span', {}, 'Error: ' + err.message)
          )
        );
      }
    }
  }

  function renderNotesTab() {
    applyNotesFilter();
  }

  function renderNotesList(notes, activeScopeFilter, isStaleRevalidating = false) {
    const listContainer = document.getElementById('notesListContainer');
    const repairBanner = document.getElementById('repairBannerContainer');
    if (!listContainer || !repairBanner) return;

    if (Array.isArray(notes)) {
      let anyAdded = false;
      notes.forEach((note) => {
        if (note.project_id && !knownProjects.has(note.project_id)) {
          knownProjects.set(note.project_id, { notes_count: 1, total: 1 });
          anyAdded = true;
        }
      });
      if (anyAdded) {
        notifyDropdowns();
      }
    }

    repairBanner.replaceChildren();

    if (isStaleRevalidating) {
      repairBanner.appendChild(
        el('div', { style: { marginBottom: '8px' } },
          el('span', { className: 'swr-updating-badge', textContent: 'updating' })
        )
      );
    }

    if (activeScopeFilter === 'unknown') {
      const wrenchIcon = createSvgIcon('wrench');
      wrenchIcon.style.color = 'var(--accent-amber)';
      const banner = el('div', {
        className: 'warning-banner',
        style: { borderRadius: '8px', marginBottom: '16px', backgroundColor: 'var(--accent-amber-bg)', borderColor: 'var(--accent-amber-border)' }
      },
        el('div', { className: 'warning-banner-text' },
          wrenchIcon,
          el('div', {},
            el('strong', { style: { color: 'var(--accent-amber)' } }, 'REPAIR QUEUE (Legacy Unscoped Notes): '),
            'These records were imported without a project tag. Under Rule 4, use the inline controls below to assign each note to its proper project or mark as global.'
          )
        )
      );
      repairBanner.appendChild(banner);
    }

    listContainer.replaceChildren();

    if (!notes || notes.length === 0) {
      listContainer.appendChild(
        el('div', { className: 'text-muted', style: { padding: '24px', textAlign: 'center' } },
          'No notes match the current filters.'
        )
      );
      return;
    }

    const buildNoteScopeBadge = (sVal, pVal) => createBadge(
      sVal === 'unknown' ? 'UNKNOWN (NEEDS SCOPE)' : (sVal + (pVal ? ': ' + pVal : '')),
      sVal === 'unknown' ? 'rose' : (sVal === 'project' ? 'emerald' : 'subtle'),
      true,
      null
    );

    notes.forEach((note) => {
      const card = el('div', { className: 'result-card', id: 'noteCard_' + note.id });

      // Note Header
      const typeVariant = note.type === 'bug' ? 'rose' : (['lesson', 'workflow', 'pattern'].includes(note.type) ? 'amber' : 'subtle');
      const typeBadge = createBadge(note.type.toUpperCase(), typeVariant, true);
      let scopeBadge = buildNoteScopeBadge(note.scope, note.project_id);

      // Inline Scope Repair Widget (Hidden by default; consistent control heights: 38px)
      const repairWidget = el('div', {
        className: 'scope-repair-widget hidden'
      });

      // Pencil edit button to toggle scope editing with blurred icon swap (edit <-> close)
      const editIcon = createSvgIcon('edit');
      editIcon.style.width = '14px';
      editIcon.style.height = '14px';
      const btnEditScope = el('button', {
        type: 'button',
        className: 'btn-icon-edit',
        title: 'Edit Scope',
        'aria-label': 'Edit Scope',
        'aria-expanded': 'false',
        onClick: (e) => {
          e.stopPropagation();
          const isHidden = repairWidget.classList.contains('hidden');
          if (isHidden) {
            repairWidget.classList.remove('hidden');
            btnEditScope.classList.add('active');
            btnEditScope.setAttribute('aria-expanded', 'true');
            swapIconWithBlur(btnEditScope, null, 'close');
            if (scopeSelect.value === 'project') {
              projInput.focus();
            }
          } else {
            repairWidget.classList.add('hidden');
            btnEditScope.classList.remove('active');
            btnEditScope.setAttribute('aria-expanded', 'false');
            swapIconWithBlur(btnEditScope, null, 'edit');
            projCtrl.close();
          }
        }
      }, el('span', { className: 'icon-swap-slot icon-swap-in' }, editIcon));

      const headerMetaGroup = el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        typeBadge,
        scopeBadge,
        btnEditScope,
        el('span', { className: 'code-pill' }, 'v' + note.version),
        el('span', { className: 'text-muted', style: { fontSize: '12px' } }, formatTimestamp(note.created_at))
      );

      const header = el('div', { className: 'result-header' },
        headerMetaGroup,
        el('span', { className: 'code-pill text-mono' }, note.id)
      );

      // Title & Content
      const titleEl = el('div', { className: 'result-title', textContent: note.title });
      const contentEl = el('div', { className: 'result-body', textContent: note.content });

      // Relations
      const tagList = el('div', { className: 'tag-list', style: { marginBottom: '0' } });
      if (Array.isArray(note.concepts)) {
        note.concepts.forEach((c) => tagList.appendChild(createBadge('#' + c, 'subtle', true)));
      }
      if (Array.isArray(note.files)) {
        note.files.forEach((f) => tagList.appendChild(createBadge(f, 'subtle', true, 'folder')));
      }

      const scopeSelect = el('select', { className: 'form-select', 'aria-label': 'Repair note scope' },
        el('option', { value: 'project', selected: note.scope === 'project' }, 'Assign to Project'),
        el('option', { value: 'global', selected: note.scope === 'global' }, 'Mark Global'),
        el('option', { value: 'unknown', selected: note.scope === 'unknown' }, 'Keep Unknown')
      );

      const projWrapper = el('div', { className: 'searchable-dropdown' });
      const projInput = el('input', {
        type: 'text',
        className: 'form-input input-w-180-pr',
        'aria-label': 'Project ID for scope repair',
        placeholder: 'Select or type project...',
        value: note.project_id || ''
      });
      projWrapper.appendChild(projInput);

      const projCtrl = attachSearchableProjectDropdown(projWrapper, projInput, {
        includeAllOption: false,
        onSelect: (selectedPid) => {
          projInput.value = selectedPid;
        }
      });

      scopeSelect.addEventListener('change', () => {
        const isProj = scopeSelect.value === 'project';
        projWrapper.style.display = isProj ? 'inline-flex' : 'none';
        if (isProj) {
          projInput.focus();
        } else {
          projCtrl.close();
        }
      });
      projWrapper.style.display = note.scope === 'project' ? 'inline-flex' : 'none';

      const btnSaveScope = el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: async () => {
          const prevScope = note.scope;
          const prevProj = note.project_id || null;
          const newScope = scopeSelect.value;
          const newProj = newScope === 'project' ? projInput.value.trim() : null;

          if (newScope === 'project' && !newProj) {
            showToast('Project slug is required when scope is project', 'amber');
            return;
          }

          // Optimistic UI update immediately, reconcile with server after
          const optimisticBadge = buildNoteScopeBadge(newScope, newProj);
          card.setAttribute('data-optimistic', 'true');
          headerMetaGroup.replaceChild(optimisticBadge, scopeBadge);
          scopeBadge = optimisticBadge;

          try {
            btnSaveScope.disabled = true;
            btnSaveScope.textContent = 'Saving...';
            const resp = await apiFetch('/notes/' + encodeURIComponent(note.id) + '/scope', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ scope: newScope, projectId: newProj })
            });

            if (!resp.ok) {
              const err = await resp.json().catch(() => ({}));
              throw new Error(err.error?.message || 'Failed to update scope');
            }

            note.scope = newScope;
            note.project_id = newProj;
            card.removeAttribute('data-optimistic');

            if (newProj && !knownProjects.has(newProj)) {
              knownProjects.set(newProj, { notes_count: 1, total: 1 });
              notifyDropdowns();
            }

            showUndoToast('Scope updated for note ' + note.id, async () => {
              const revertResp = await apiFetch('/notes/' + encodeURIComponent(note.id) + '/scope', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope: prevScope, projectId: prevProj })
              });
              if (revertResp.ok) {
                showToast('Reverted scope change for ' + note.id, 'emerald', 2500);
                fetchStats();
                applyNotesFilter();
              }
            });
            fetchStats();
            applyNotesFilter();
          } catch (err) {
            // Rollback optimistic update on failure
            const rollbackBadge = buildNoteScopeBadge(prevScope, prevProj);
            headerMetaGroup.replaceChild(rollbackBadge, scopeBadge);
            scopeBadge = rollbackBadge;
            card.removeAttribute('data-optimistic');
            showToast('Error: ' + err.message, 'rose');
            btnSaveScope.disabled = false;
            btnSaveScope.textContent = 'Assign Scope';
          }
        }
      }, 'Assign Scope');

      repairWidget.appendChild(el('span', { className: 'text-muted form-label-inline' }, 'RULE 4 SCOPE:'));
      repairWidget.appendChild(scopeSelect);
      repairWidget.appendChild(projWrapper);
      repairWidget.appendChild(btnSaveScope);

      card.appendChild(header);
      card.appendChild(titleEl);
      card.appendChild(contentEl);
      if (tagList.children.length > 0) card.appendChild(tagList);
      card.appendChild(repairWidget);

      listContainer.appendChild(card);
    });
  }

  // Create Note Modal Form (Enforces Rule 4 explicitly)
  function openCreateNoteModal() {
    const scopeSelect = el('select', { id: 'createNoteScope', className: 'form-select', style: { width: '100%' } },
      el('option', { value: 'project', selected: true }, 'project (requires projectId)'),
      el('option', { value: 'global' }, 'global (applies everywhere)'),
      el('option', { value: 'unknown' }, 'unknown (unspecified scope)')
    );

    const projWrapper = el('div', { className: 'searchable-dropdown flex-1', style: { width: '100%' } });
    const projectInput = el('input', {
      id: 'createNoteProject',
      type: 'text',
      className: 'form-input input-w-full-pr',
      'aria-label': 'Project ID',
      placeholder: 'Project ID (e.g. example-app, demo-project)...'
    });
    projWrapper.appendChild(projectInput);
    attachSearchableProjectDropdown(projWrapper, projectInput, {
      includeAllOption: false
    });

    scopeSelect.addEventListener('change', () => {
      const isProj = scopeSelect.value === 'project';
      projectInput.disabled = !isProj;
      if (!isProj) {
        projectInput.value = '';
      }
    });

    const typeSelect = el('select', { id: 'createNoteType', className: 'form-select', style: { width: '100%' } },
      el('option', { value: 'fact' }, 'fact'),
      el('option', { value: 'architecture' }, 'architecture'),
      el('option', { value: 'pattern' }, 'pattern'),
      el('option', { value: 'workflow' }, 'workflow'),
      el('option', { value: 'bug' }, 'bug'),
      el('option', { value: 'lesson' }, 'lesson'),
      el('option', { value: 'preference' }, 'preference')
    );

    const titleInput = el('input', {
      id: 'createNoteTitle',
      type: 'text',
      className: 'form-input',
      style: { width: '100%' },
      placeholder: 'Note Title...'
    });

    const contentTextarea = el('textarea', {
      id: 'createNoteContent',
      className: 'form-textarea',
      placeholder: 'Curated knowledge content (will never be auto-deleted)...'
    });

    const conceptsInput = el('input', {
      id: 'createNoteConcepts',
      type: 'text',
      className: 'form-input',
      style: { width: '100%' },
      placeholder: 'Concepts (comma-separated, e.g. sqlite, schema, migrations)'
    });

    const filesInput = el('input', {
      id: 'createNoteFiles',
      type: 'text',
      className: 'form-input',
      style: { width: '100%' },
      placeholder: 'Files touched (comma-separated paths, e.g. src/lib/db.ts)'
    });

    const bodyNodes = [
      el('div', {},
        el('label', { for: 'createNoteScope', className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'RULE 4 SCOPE *'),
        scopeSelect
      ),
      el('div', {},
        el('label', { for: 'createNoteProject', className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'PROJECT ID'),
        projWrapper
      ),
      el('div', {},
        el('label', { for: 'createNoteType', className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'NOTE TYPE *'),
        typeSelect
      ),
      el('div', {},
        el('label', { for: 'createNoteTitle', className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'TITLE *'),
        titleInput
      ),
      el('div', {},
        el('label', { for: 'createNoteContent', className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'CONTENT *'),
        contentTextarea
      ),
      el('div', {},
        el('label', { for: 'createNoteConcepts', className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'CONCEPTS (OPTIONAL)'),
        conceptsInput
      ),
      el('div', {},
        el('label', { for: 'createNoteFiles', className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'FILES TOUCHED (OPTIONAL)'),
        filesInput
      )
    ];

    showModal('Create Long-Term Memory (Rule 4 Explicit Scope)', bodyNodes, [
      {
        label: 'Commit Note',
        variant: 'primary',
        onClick: async (_e, close) => {
          const scope = scopeSelect.value;
          const projectId = scope === 'project' ? projectInput.value.trim() : null;
          const type = typeSelect.value;
          const title = titleInput.value.trim();
          const content = contentTextarea.value.trim();

          if (scope === 'project' && !projectId) {
            showToast('projectId is required when scope is project', 'amber');
            return;
          }
          if (!title || !content) {
            showToast('Title and content are required', 'amber');
            return;
          }

          const concepts = conceptsInput.value.split(',').map((s) => s.trim()).filter(Boolean);
          const files = filesInput.value.split(',').map((s) => s.trim()).filter(Boolean);
          const submitBtn = _e && _e.currentTarget ? _e.currentTarget : null;

          // Optimistic note card while POST /notes is in flight
          const listContainer = document.getElementById('notesListContainer');
          const provScope = scope === 'project' && projectId ? ('project/' + projectId) : scope;
          const optCard = el('div', {
            className: 'result-card',
            'data-optimistic': 'true',
            style: { borderColor: 'var(--accent-emerald-border)', borderStyle: 'dashed' }
          },
            el('div', { className: 'result-header' },
              el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                createBadge(type.toUpperCase(), type === 'bug' ? 'rose' : (type === 'lesson' ? 'amber' : 'subtle'), true),
                createBadge(scope + (projectId ? ': ' + projectId : ''), scope === 'project' ? 'emerald' : (scope === 'unknown' ? 'rose' : 'subtle'), true)
              ),
              el('span', { className: 'code-pill text-mono' }, 'pending')
            ),
            el('div', { className: 'result-title', textContent: title }),
            el('div', { className: 'result-body', textContent: content }),
            createProvenanceLine('provenance: ' + provScope + ' · v1 · pending · ' + formatTimestamp(Math.floor(Date.now() / 1000)))
          );
          if (listContainer) {
            listContainer.prepend(optCard);
          }

          try {
            if (submitBtn) {
              submitBtn.disabled = true;
              submitBtn.textContent = 'Saving...';
            }
            const resp = await apiFetch('/notes', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                scope,
                project_id: projectId,
                type,
                title,
                content,
                concepts,
                files
              })
            });

            if (!resp.ok) {
              const err = await resp.json().catch(() => ({}));
              throw new Error(err.error?.message || 'Create note failed: ' + resp.status);
            }

            optCard.removeAttribute('data-optimistic');
            optCard.style.borderColor = '';
            optCard.style.borderStyle = '';
            showToast('Note saved.', 'emerald');
            close();
            fetchStats();
            applyNotesFilter();
          } catch (err) {
            if (optCard.parentElement) optCard.remove();
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.textContent = 'Commit Note';
            }
            showToast('Error creating note: ' + err.message, 'rose');
          }
        }
      }
    ]);
  }

  // Tab 4: Trajectories & Observations
  function showTrajectoryModal(t) {
    const isSuccess = t.success === 1;
    const isUnknown = t.success === null || t.success === undefined;
    const outcomeBadge = isUnknown
      ? createBadge('UNKNOWN', 'amber', true)
      : createBadge(isSuccess ? 'SUCCESS' : 'FAILED', isSuccess ? 'emerald' : 'rose', true);

    const bodyNodes = [
      el('div', { className: 'inspector-grid' },
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'TRAJECTORY ID'),
          el('div', { className: 'inspector-value text-mono', style: { color: 'var(--accent-emerald)' } }, t.id)
        ),
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'OUTCOME'),
          el('div', { className: 'inspector-value' }, outcomeBadge)
        ),
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'SCOPE & PROJECT'),
          el('div', { className: 'inspector-value' },
            createBadge(t.scope + (t.project_id ? ': ' + t.project_id : ''), 'subtle', true)
          )
        ),
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'TASK TYPE'),
          el('div', { className: 'inspector-value' },
            el('span', { className: 'code-pill' }, t.task_type || 'unknown')
          )
        ),
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'DURATION'),
          el('div', { className: 'inspector-value text-mono' }, (t.duration_ms || 0) + ' ms')
        ),
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'RECORDED AT'),
          el('div', { className: 'inspector-value' }, formatTimestamp(t.created_at))
        )
      ),
      el('div', { style: { marginBottom: '16px' } },
        el('div', { className: 'inspector-label' }, 'DESCRIPTION / PROMPT'),
        el('div', { className: 'inspector-code-block' }, t.description || '(no description)')
      ),
      el('div', {},
        el('div', { className: 'inspector-label' }, 'RESULT / OUTCOME SUMMARY'),
        el('div', { className: 'inspector-code-block' }, t.result || '(no result recorded)')
      ),
      createProvenanceLine('scope: ' + (t.scope || 'unknown') + (t.project_id ? '/' + t.project_id : '') + ' · id: ' + t.id + ' · recorded: ' + formatTimestamp(t.created_at))
    ];

    showModal('Trajectory Inspector · ' + t.id, bodyNodes);
  }

  function showObservationModal(obs) {
    const isFailed = obs.failed === 1;
    const bodyNodes = [
      el('div', { className: 'inspector-grid' },
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'OBSERVATION ID'),
          el('div', { className: 'inspector-value text-mono', style: { color: 'var(--accent-emerald)' } }, obs.id)
        ),
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'STATUS / OUTCOME'),
          el('div', { className: 'inspector-value' },
            createBadge(isFailed ? 'FAILED' : 'SUCCESS / OK', isFailed ? 'rose' : 'emerald', true)
          )
        ),
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'SCOPE & PROJECT'),
          el('div', { className: 'inspector-value' },
            createBadge(obs.scope + (obs.project_id ? ': ' + obs.project_id : ''), 'subtle', true)
          )
        ),
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'KIND / TOOL'),
          el('div', { className: 'inspector-value' },
            el('span', { className: 'code-pill', style: { color: 'var(--text-primary)' } }, obs.tool_name || obs.kind || 'unknown')
          )
        ),
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'FILE PATH'),
          el('div', { className: 'inspector-value' },
            obs.file_path ? el('span', { className: 'code-pill' }, obs.file_path) : el('span', { className: 'text-muted' }, 'None')
          )
        ),
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'SESSION ID'),
          el('div', { className: 'inspector-value text-mono' }, obs.session_id || el('span', { className: 'text-muted' }, 'N/A'))
        ),
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'DURATION'),
          el('div', { className: 'inspector-value text-mono' }, (obs.duration_ms || 0) + ' ms')
        ),
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'RECORDED AT'),
          el('div', { className: 'inspector-value' }, formatTimestamp(obs.created_at))
        )
      ),
      el('div', { style: { marginBottom: '16px' } },
        el('div', { className: 'inspector-label' }, 'INPUT / PROMPT'),
        el('div', { className: 'inspector-code-block' }, obs.input || '(empty input)')
      ),
      el('div', {},
        el('div', { className: 'inspector-label', style: { color: isFailed ? 'var(--accent-rose)' : 'var(--text-muted)' } }, 'OUTPUT / EXECUTION RESULT'),
        el('div', {
          className: 'inspector-code-block',
          style: isFailed ? { color: 'var(--accent-rose)', borderColor: 'var(--accent-rose-border)' } : {}
        }, obs.output || '(empty output)')
      ),
      createProvenanceLine('scope: ' + (obs.scope || 'unknown') + (obs.project_id ? '/' + obs.project_id : '') + (obs.session_id ? ' · session: ' + obs.session_id : '') + ' · recorded: ' + formatTimestamp(obs.created_at))
    ];

    showModal('Observation Inspector · ' + obs.id, bodyNodes);
  }

  function showObservationNotFoundModal(recordId, recordType = 'observation') {
    const alertIcon = createSvgIcon('alert');
    alertIcon.style.color = 'var(--accent-rose)';
    const bodyNodes = [
      el('div', {
        className: 'warning-banner',
        style: {
          borderRadius: '8px',
          marginBottom: '16px',
          backgroundColor: 'var(--accent-rose-bg)',
          borderColor: 'var(--accent-rose-border)'
        }
      },
        el('div', { className: 'warning-banner-text' },
          alertIcon,
          el('div', {},
            el('strong', { style: { color: 'var(--accent-rose)', display: 'block', marginBottom: '4px' } },
              'Observation ' + recordId + ' not found in active store (may have been archived or cleaned up)'
            ),
            el('span', { className: 'text-muted', style: { fontSize: '12px' } },
              'The cited record ID does not exist in the active observations table.'
            )
          )
        )
      ),
      el('div', { className: 'inspector-grid' },
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'CITED RECORD ID'),
          el('div', { className: 'inspector-value text-mono', style: { color: 'var(--accent-rose)' } }, recordId)
        ),
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'RECORD TYPE'),
          el('div', { className: 'inspector-value' },
            createBadge((recordType || 'observation').toUpperCase(), 'subtle', true)
          )
        ),
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'HTTP STATUS'),
          el('div', { className: 'inspector-value' },
            createBadge('404 NOT FOUND', 'rose', true)
          )
        )
      ),
      el('div', {
        style: {
          backgroundColor: 'var(--bg-subtle)',
          padding: '14px 16px',
          borderRadius: '8px',
          border: '1px solid var(--border-color)',
          fontSize: '14px',
          lineHeight: '1.6',
          color: 'var(--text-secondary)'
        }
      },
        el('strong', { style: { color: 'var(--text-primary)', display: 'block', marginBottom: '6px' } },
          'Why is this observation not found?'
        ),
        el('ul', { style: { paddingLeft: '20px', margin: 0 } },
          el('li', { style: { marginBottom: '4px' } },
            'Rule 6 derived summaries cite machine observations as evidence. If this summary originated from an AI conformance fixture (fx1-failure, fx2-success, fx3-sparse), synthetic source IDs are validated during test verification and never committed to the live observation store.'
          ),
          el('li', {},
            'If this was a production tool call, it may have been moved to observations_archive by the background retention sweeper (active observations are archived after 30 days).'
          )
        )
      )
    ];

    showModal('Citation Inspector · ' + recordId, bodyNodes);
  }

  async function inspectCitation(recordId, recordType = 'observation') {
    showToast('Fetching cited ' + (recordType || 'observation') + ': ' + recordId + '...', 'emerald', 2500);

    // 1. Switch to Trajectories tab & Observations subtab
    switchTab('trajectories');

    if (recordType === 'trajectory') {
      switchSubTab('trajectories', recordId);
      try {
        const resp = await apiFetch('/trajectories/' + encodeURIComponent(recordId));
        if (resp.status === 404) {
          showObservationNotFoundModal(recordId, recordType);
          return;
        }
        if (!resp.ok) {
          throw new Error('Server returned HTTP ' + resp.status + ' (' + resp.statusText + ')');
        }
        const traj = await resp.json();
        showTrajectoryModal(traj);
      } catch (err) {
        showToast('Citation fetch failed: ' + err.message, 'rose', 6000);
      }
      return;
    }

    switchSubTab('observations', recordId);

    // 2. Fetch the observation
    try {
      const resp = await apiFetch('/observations/' + encodeURIComponent(recordId));
      if (resp.status === 404) {
        showObservationNotFoundModal(recordId, recordType);
        return;
      }
      if (!resp.ok) {
        throw new Error('Server returned HTTP ' + resp.status + ' (' + resp.statusText + ')');
      }
      const obs = await resp.json();
      showObservationModal(obs);
    } catch (err) {
      showToast('Citation fetch failed: ' + err.message, 'rose', 6000);
    }
  }

  function renderTrajectoriesSubView(highlightId = null) {
    const container = document.getElementById('trajectoriesSubViewContainer');
    if (!container) return;

    container.replaceChildren();

    if (activeSubTab === 'trajectories') {
      renderTrajectoriesTable(container, highlightId);
    } else if (activeSubTab === 'observations') {
      renderObservationsTable(container, highlightId);
    } else if (activeSubTab === 'summaries') {
      renderSummariesList(container);
    }
  }

  function renderTrajectoriesItems(container, list, highlightId = null, isUpdating = false) {
    container.replaceChildren();
    if (isUpdating) {
      container.appendChild(
        el('div', { style: { marginBottom: '8px' } }, el('span', { className: 'swr-updating-badge', textContent: 'updating' }))
      );
    }
    if (!list || list.length === 0) {
      const trajCounts = statsData?.counts?.trajectories || {};
      const archivedCount = trajCounts.archived || 0;
      const emptyIcon = createSvgIcon('layers');
      emptyIcon.style.width = '28px';
      emptyIcon.style.height = '28px';
      const emptyCard = el('div', {
        className: 'result-card',
        style: { padding: '32px 24px', textAlign: 'center', backgroundColor: 'var(--bg-subtle)' }
      },
        el('div', { style: { marginBottom: '12px', color: 'var(--text-muted)' } }, emptyIcon),
        el('h3', { style: { fontSize: '16px', fontWeight: '700', marginBottom: '8px' } }, 'No Active Trajectories Recorded'),
        el('p', { className: 'text-muted', style: { fontSize: '14px', maxWidth: '520px', margin: '0 auto 16px', lineHeight: '1.5' } },
          'Trajectories represent task-level attempts with arithmetic outcome metrics (success rate, duration, and tool count). ' +
          (archivedCount > 0 ? (archivedCount + ' trajectories exist in trajectory_archive (older than 30 days). ') : '') +
          'Use the button below or POST /capture/trajectories to capture task executions.'
        ),
        el('button', {
          className: 'btn btn-emerald',
          onClick: () => openCaptureModal('trajectory')
        }, '+ Capture Test Trajectory')
      );
      container.appendChild(emptyCard);
      return;
    }

    let highlightedRowEl = null;

    const table = el('table', { className: 'data-table' },
      el('thead', {},
        el('tr', {},
          el('th', {}, 'ID'),
          el('th', {}, 'Scope / Project'),
          el('th', {}, 'Task Type'),
          el('th', {}, 'Outcome'),
          el('th', {}, 'Duration'),
          el('th', {}, 'Description & Result'),
          el('th', {}, 'Action')
        )
      ),
      el('tbody', {},
        ...list.map((t) => {
          const isTarget = highlightId && (t.id === highlightId);
          const outcomeBadge =
            t.success === null || t.success === undefined
              ? createBadge('UNKNOWN', 'amber', true)
              : createBadge(t.success === 1 ? 'SUCCESS' : 'FAILED', t.success === 1 ? 'emerald' : 'rose', true);

          const row = el('tr', {
            id: 'traj-row-' + t.id,
            className: isTarget ? 'row-highlight' : '',
            style: { cursor: 'pointer' },
            onClick: () => showTrajectoryModal(t)
          },
            el('td', { className: 'table-cell-nowrap' }, el('span', { className: 'code-pill text-mono' + (isTarget ? ' text-bold' : ''), title: t.id }, formatShortId(t.id))),
            el('td', { className: 'table-cell-nowrap' }, createBadge(t.scope + (t.project_id ? ': ' + t.project_id : ''), 'subtle', true)),
            el('td', { className: 'table-cell-nowrap' }, el('span', { className: 'code-pill' }, t.task_type || 'unknown')),
            el('td', { className: 'table-cell-nowrap' }, outcomeBadge),
            el('td', { className: 'table-cell-nowrap' }, el('span', { className: 'text-mono' }, (t.duration_ms || 0) + 'ms')),
            el('td', { className: 'table-cell-wrap' },
              el('div', { style: { fontWeight: '600', marginBottom: '4px', overflowWrap: 'anywhere', wordBreak: 'break-word' } }, t.description),
              t.result ? el('div', { className: 'text-muted', style: { fontSize: '12px', overflowWrap: 'anywhere', wordBreak: 'break-word' } }, t.result) : null,
              createProvenanceLine('recorded: ' + formatTimestamp(t.created_at) + (t.session_id ? ' · session: ' + t.session_id : ''))
            ),
            el('td', { className: 'table-cell-nowrap' },
              el('button', {
                type: 'button',
                className: 'btn hit-slop',
                style: { height: '28px', padding: '0 8px', fontSize: '12px' },
                onClick: (e) => {
                  e.stopPropagation();
                  showTrajectoryModal(t);
                }
              }, 'Inspect')
            )
          );

          if (isTarget) {
            highlightedRowEl = row;
          }

          return row;
        })
      )
    );

    container.appendChild(el('div', { className: 'table-responsive' }, table));

    if (highlightedRowEl) {
      setTimeout(() => {
        highlightedRowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 120);
    }
  }

  async function renderTrajectoriesTable(container, highlightId = null) {
    if (swrCache.trajectories) {
      renderTrajectoriesItems(container, swrCache.trajectories, highlightId, true);
    } else {
      container.replaceChildren(
        createSkeletonLoader('list', 3, 'Loading trajectories...')
      );
    }

    try {
      const resp = await apiFetch('/trajectories?limit=50');
      if (!resp.ok) throw new Error('Failed to load trajectories: HTTP ' + resp.status);
      const list = await resp.json();
      swrCache.trajectories = list;
      renderTrajectoriesItems(container, list, highlightId, false);
    } catch (err) {
      if (!swrCache.trajectories) {
        container.replaceChildren(
          el('div', { className: 'toast toast-rose', style: { position: 'static' } },
            el('span', {}, 'Error: ' + err.message)
          )
        );
      }
    }
  }

  function renderObservationsItems(container, list, highlightId = null, isUpdating = false) {
    container.replaceChildren();
    if (isUpdating) {
      container.appendChild(
        el('div', { style: { marginBottom: '8px' } }, el('span', { className: 'swr-updating-badge', textContent: 'updating' }))
      );
    }
    if (!list || list.length === 0) {
      const obsCounts = statsData?.counts?.observations || {};
      const archivedCount = obsCounts.archived || 0;
      const emptySearchIcon = createSvgIcon('search');
      emptySearchIcon.style.width = '28px';
      emptySearchIcon.style.height = '28px';
      const emptyCard = el('div', {
        className: 'result-card',
        style: { padding: '32px 24px', textAlign: 'center', backgroundColor: 'var(--bg-subtle)' }
      },
        el('div', { style: { marginBottom: '12px', color: 'var(--text-muted)' } }, emptySearchIcon),
        el('h3', { style: { fontSize: '16px', fontWeight: '700', marginBottom: '8px' } }, 'No Active Observations Recorded'),
        el('p', { className: 'text-muted', style: { fontSize: '14px', maxWidth: '520px', margin: '0 auto 16px', lineHeight: '1.5' } },
          'Observations capture high-volume machine-written tool calls, file edits, and prompts in real time. ' +
          (archivedCount > 0 ? (archivedCount + ' observations exist in observations_archive (older than 30 days). ') : '') +
          'Use the button below or POST /capture/observations to record tool activity.'
        ),
        el('button', {
          className: 'btn btn-emerald',
          onClick: () => openCaptureModal('observation')
        }, '+ Capture Test Observation')
      );
      container.appendChild(emptyCard);
      return;
    }

    let highlightedRowEl = null;

    const table = el('table', { className: 'data-table' },
      el('thead', {},
        el('tr', {},
          el('th', {}, 'ID'),
          el('th', {}, 'Scope / Project'),
          el('th', {}, 'Tool / Kind'),
          el('th', {}, 'File Path'),
          el('th', {}, 'Status'),
          el('th', {}, 'Duration'),
          el('th', {}, 'Preview'),
          el('th', {}, 'Action')
        )
      ),
      el('tbody', {},
        ...list.map((obs) => {
          const isFailed = obs.failed === 1;
          const statusBadge = createBadge(isFailed ? 'FAILED' : 'OK', isFailed ? 'rose' : 'emerald', true);
          const toolStr = obs.tool_name || obs.kind;
          const isTarget = highlightId && (obs.id === highlightId);

          const row = el('tr', {
            id: 'obs-row-' + obs.id,
            className: isTarget ? 'row-highlight' : '',
            style: { cursor: 'pointer' },
            onClick: () => showObservationModal(obs)
          },
            el('td', { className: 'table-cell-nowrap' }, el('span', { className: 'code-pill text-mono' + (isTarget ? ' text-bold' : ''), title: obs.id }, formatShortId(obs.id))),
            el('td', { className: 'table-cell-nowrap' }, createBadge(obs.scope + (obs.project_id ? ': ' + obs.project_id : ''), 'subtle', true)),
            el('td', { className: 'table-cell-nowrap' }, el('span', { className: 'code-pill', style: { color: 'var(--text-primary)' } }, toolStr)),
            el('td', { className: 'table-cell-nowrap' }, obs.file_path ? el('span', { className: 'code-pill code-pill-truncate', title: obs.file_path }, obs.file_path) : el('span', { className: 'text-muted' }, '-')),
            el('td', { className: 'table-cell-nowrap' }, statusBadge),
            el('td', { className: 'table-cell-nowrap' }, el('span', { className: 'text-mono' }, (obs.duration_ms || 0) + 'ms')),
            el('td', { className: 'table-cell-wrap' },
              el('div', { style: { fontSize: '12px', overflowWrap: 'anywhere', wordBreak: 'break-word' } },
                obs.input ? el('div', { className: 'text-muted', style: { marginBottom: obs.output ? '4px' : '0' } }, 'in: ' + obs.input.slice(0, 120) + (obs.input.length > 120 ? '…' : '')) : null,
                obs.output ? el('div', { style: { color: isFailed ? 'var(--accent-rose)' : 'var(--text-secondary)' } }, 'out: ' + obs.output.slice(0, 120) + (obs.output.length > 120 ? '…' : '')) : null
              ),
              createProvenanceLine('recorded: ' + formatTimestamp(obs.created_at) + (obs.session_id ? ' · session: ' + obs.session_id : ''))
            ),
            el('td', { className: 'table-cell-nowrap' },
              el('button', {
                type: 'button',
                className: 'btn hit-slop',
                style: { height: '28px', padding: '0 8px', fontSize: '12px' },
                onClick: (e) => {
                  e.stopPropagation();
                  showObservationModal(obs);
                }
              }, 'Inspect')
            )
          );

          if (isTarget) {
            highlightedRowEl = row;
          }

          return row;
        })
      )
    );

    container.appendChild(el('div', { className: 'table-responsive' }, table));

    if (highlightedRowEl) {
      setTimeout(() => {
        highlightedRowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 120);
    }
  }

  async function renderObservationsTable(container, highlightId = null) {
    if (swrCache.observations) {
      renderObservationsItems(container, swrCache.observations, highlightId, true);
    } else {
      container.replaceChildren(
        createSkeletonLoader('list', 3, 'Loading observations...')
      );
    }

    try {
      const resp = await apiFetch('/observations?limit=50');
      if (!resp.ok) throw new Error('Failed to load observations: HTTP ' + resp.status);
      const list = await resp.json();
      swrCache.observations = list;
      renderObservationsItems(container, list, highlightId, false);
    } catch (err) {
      if (!swrCache.observations) {
        container.replaceChildren(
          el('div', { className: 'toast toast-rose', style: { position: 'static' } },
            el('span', {}, 'Error: ' + err.message)
          )
        );
      }
    }
  }

  function renderSummariesItems(container, list, isUpdating = false) {
    container.replaceChildren();
    if (isUpdating) {
      container.appendChild(
        el('div', { style: { marginBottom: '8px' } }, el('span', { className: 'swr-updating-badge', textContent: 'updating' }))
      );
    }
    if (!list || list.length === 0) {
      container.appendChild(
        el('div', { className: 'text-muted', style: { padding: '24px', textAlign: 'center' } },
          'No extractive summaries stored yet. Derived rows are produced under Rule 6 attribution.'
        )
      );
      return;
    }

    list.forEach((sum) => {
      const outcomeVariant = sum.outcome === 'success' ? 'emerald' : sum.outcome === 'failure' ? 'rose' : 'amber';
      const outcomeBadge = createBadge('OUTCOME: ' + (sum.outcome || 'unknown').toUpperCase(), outcomeVariant, true);

      const producerTierModel = (sum.producer_tier || 'agent') + (sum.producer_model ? '/' + sum.producer_model : '');
      const scopeVariant = sum.scope === 'project' ? 'emerald' : (sum.scope === 'unknown' ? 'rose' : 'subtle');
      const scopeBadge = createBadge((sum.scope || 'unknown') + (sum.project_id ? ': ' + sum.project_id : ''), scopeVariant, true);
      const verifiedBadge = sum.verified === 1 ? createBadge('VERIFIED', 'emerald', true) : createBadge('UNVERIFIED', 'amber', true);

      const makeCitationPill = (s, prefixLabel) => {
        const icon = createSvgIcon('search');
        icon.style.width = '12px';
        icon.style.height = '12px';
        return el('span', {
          className: 'code-pill citation-badge',
          role: 'button',
          tabindex: '0',
          'aria-label': 'Inspect cited ' + (s.record_type || s.grain) + ' ' + s.record_id,
          title: prefixLabel + (s.record_type || s.grain) + ' -> ' + s.record_id + ' (Click to inspect observation)',
          onClick: (e) => {
            e.stopPropagation();
            inspectCitation(s.record_id, s.record_type || s.grain);
          },
          onKeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              inspectCitation(s.record_id, s.record_type || s.grain);
            }
          }
        }, icon, el('span', { textContent: s.record_id }));
      };

      // Claims list
      const claimsList = el('div', {});
      if (Array.isArray(sum.claims) && sum.claims.length > 0) {
        sum.claims.forEach((claim, idx) => {
          const claimSources = (sum.sources || []).filter((s) => s.claim_id === claim.id);
          const sourcePills = claimSources.map((s) => makeCitationPill(s, 'Citation source: '));

          const claimItem = el('div', {
            style: {
              backgroundColor: 'var(--bg-subtle)',
              padding: '10px 14px',
              borderRadius: '8px',
              marginBottom: '8px'
            }
          },
            el('div', { style: { fontWeight: '600', marginBottom: '4px', overflowWrap: 'anywhere', wordBreak: 'break-word' } }, (idx + 1) + '. ' + claim.text),
            el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              el('span', { className: 'text-muted', style: { fontSize: '12px' } }, 'Citations:'),
              ...sourcePills
            )
          );
          claimsList.appendChild(claimItem);
        });
      } else {
        claimsList.appendChild(el('div', { className: 'text-muted', style: { fontSize: '12px', marginBottom: '8px' } }, 'No claims recorded in this summary.'));
      }

      // Additional/General citations if any sources are not mapped to specific claims
      const claimedSourceIds = new Set((sum.claims || []).flatMap((c) => (sum.sources || []).filter(s => s.claim_id === c.id).map(s => s.record_id)));
      const generalSources = (sum.sources || []).filter(s => !claimedSourceIds.has(s.record_id));
      if (generalSources.length > 0) {
        const generalPills = generalSources.map((s) => makeCitationPill(s, 'Source: '));
        claimsList.appendChild(
          el('div', {
            style: {
              backgroundColor: 'var(--bg-subtle)',
              padding: '8px 14px',
              borderRadius: '8px',
              marginTop: '8px',
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              flexWrap: 'wrap'
            }
          },
            el('span', { className: 'text-muted', style: { fontSize: '12px', fontWeight: '600' } }, 'General Citations:'),
            ...generalPills
          )
        );
      }

      const provLine = createProvenanceLine(
        'producer: ' + producerTierModel + ' · prompt: ' + (sum.prompt_version || 'v1') + ' · id: ' + sum.id + ' · ' + formatTimestamp(sum.created_at)
      );
      const bodyEl = el('div', { className: 'summary-row-body hidden' }, claimsList, provLine);

      const firstClaimText = (Array.isArray(sum.claims) && sum.claims.length > 0 && sum.claims[0].text)
        ? sum.claims[0].text
        : 'Session summary';
      const claimsCount = Array.isArray(sum.claims) ? sum.claims.length : 0;
      const sourcesCount = Array.isArray(sum.sources) ? sum.sources.length : 0;

      const row = el('div', { className: 'summary-collapsible-row' });
      const chevronIcon = createSvgIcon('chevron', 'icon-svg summary-row-chevron');

      const headerBtn = el('button', {
        type: 'button',
        className: 'summary-row-header',
        'aria-expanded': 'false',
        onClick: () => {
          const isExpanded = row.classList.toggle('expanded');
          bodyEl.classList.toggle('hidden', !isExpanded);
          headerBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        }
      },
        el('div', { className: 'summary-row-left' },
          chevronIcon,
          createBadge((sum.kind || 'session').toUpperCase(), 'subtle', true),
          scopeBadge,
          outcomeBadge,
          verifiedBadge,
          el('span', { className: 'summary-row-preview', title: firstClaimText, textContent: firstClaimText })
        ),
        el('div', { className: 'summary-row-right' },
          el('span', { className: 'code-pill text-mono' }, claimsCount + ' claims · ' + sourcesCount + ' citations'),
          el('span', { className: 'text-muted text-mono', style: { fontSize: '12px' } }, formatTimestamp(sum.created_at)),
          el('span', { className: 'code-pill text-mono', title: sum.id }, formatShortId(sum.id))
        )
      );

      row.appendChild(headerBtn);
      row.appendChild(bodyEl);
      container.appendChild(row);
    });
  }

  async function renderSummariesList(container) {
    if (swrCache.summaries) {
      renderSummariesItems(container, swrCache.summaries, true);
    } else {
      container.replaceChildren(
        createSkeletonLoader('list', 3, 'Loading extractive summaries...')
      );
    }

    try {
      const resp = await apiFetch('/summaries?limit=50');
      if (!resp.ok) throw new Error('Failed to load summaries: HTTP ' + resp.status);
      const list = await resp.json();
      swrCache.summaries = list;
      renderSummariesItems(container, list, false);
    } catch (err) {
      if (!swrCache.summaries) {
        container.replaceChildren(
          el('div', { className: 'toast toast-rose', style: { position: 'static' } },
            el('span', {}, 'Error: ' + err.message)
          )
        );
      }
    }
  }

  // Interactive Test Capture Modal
  function openCaptureModal(defaultGrain = 'observation') {
    const isTraj = defaultGrain === 'trajectory';
    const grainSelect = el('select', { id: 'captureGrain', className: 'form-select', style: { width: '100%' } },
      el('option', { value: 'observation', selected: !isTraj }, 'Observation (Tool Call / Hot Path)'),
      el('option', { value: 'trajectory', selected: isTraj }, 'Trajectory (Task Attempt Rollup)')
    );

    const scopeSelect = el('select', { id: 'captureScope', className: 'form-select', style: { width: '100%' } },
      el('option', { value: 'project', selected: true }, 'project'),
      el('option', { value: 'global' }, 'global'),
      el('option', { value: 'unknown' }, 'unknown')
    );

    const projectInput = el('input', {
      id: 'captureProject',
      type: 'text',
      className: 'form-input',
      style: { width: '100%' },
      'aria-label': 'Project ID',
      value: 'example-app',
      placeholder: 'Project ID...'
    });

    const toolOrTaskInput = el('input', {
      id: 'captureToolOrTask',
      type: 'text',
      className: 'form-input',
      style: { width: '100%' },
      value: isTraj ? 'migration' : 'ExecuteCommand',
      placeholder: 'Tool Name (e.g. Edit, ExecuteCommand) or Task Type...'
    });

    const fileInput = el('input', {
      id: 'captureFile',
      type: 'text',
      className: 'form-input',
      style: { width: '100%' },
      value: isTraj ? '' : 'src/lib/db.ts',
      placeholder: 'Target File Path...'
    });

    const failedSelect = el('select', { id: 'captureFailed', className: 'form-select', style: { width: '100%' } },
      el('option', { value: '0', selected: true }, 'Success / OK (failed = 0)'),
      el('option', { value: '1' }, 'Failed (failed = 1) — Triggers Failure Pattern UPSERT')
    );

    const inputArea = el('textarea', {
      id: 'captureInput',
      className: 'form-textarea',
      placeholder: 'Input / Description...',
      textContent: isTraj ? 'Execute migration for SQLite composite index' : 'npm test -- memories'
    });

    const outputArea = el('textarea', {
      id: 'captureOutput',
      className: 'form-textarea',
      placeholder: 'Output / Error Result...',
      textContent: isTraj ? 'Migration applied cleanly in 210ms' : 'Tests passed: 70/70'
    });

    grainSelect.addEventListener('change', () => {
      const isNowTraj = grainSelect.value === 'trajectory';
      if (isNowTraj) {
        toolOrTaskInput.value = 'migration';
        fileInput.value = '';
        inputArea.value = 'Migrate schema to support compound index';
        outputArea.value = 'Migration completed in 240ms';
      } else {
        toolOrTaskInput.value = 'ExecuteCommand';
        fileInput.value = 'src/lib/db.ts';
        inputArea.value = 'npm test -- memories';
        outputArea.value = 'Tests passed: 70/70';
      }
    });

    failedSelect.addEventListener('change', () => {
      if (failedSelect.value === '1') {
        outputArea.textContent = 'SqliteError: FOREIGN KEY constraint failed';
      }
    });

    const bodyNodes = [
      el('div', {},
        el('label', { for: 'captureGrain', className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'GRAIN'),
        grainSelect
      ),
      el('div', {},
        el('label', { for: 'captureScope', className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'SCOPE & PROJECT'),
        el('div', { style: { display: 'flex', gap: '8px' } }, scopeSelect, projectInput)
      ),
      el('div', {},
        el('label', { for: 'captureToolOrTask', className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'TOOL / TASK TYPE'),
        toolOrTaskInput
      ),
      el('div', {},
        el('label', { for: 'captureFile', className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'FILE PATH'),
        fileInput
      ),
      el('div', {},
        el('label', { for: 'captureFailed', className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'STATUS / OUTCOME'),
        failedSelect
      ),
      el('div', {},
        el('label', { for: 'captureInput', className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'INPUT / PROMPT'),
        inputArea
      ),
      el('div', {},
        el('label', { for: 'captureOutput', className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'OUTPUT / RESULT'),
        outputArea
      )
    ];

    showModal('Capture Telemetry Event (Direct Hot-Path)', bodyNodes, [
      {
        label: 'Commit Capture',
        variant: 'emerald',
        onClick: async (_e, close) => {
          const grain = grainSelect.value;
          const scope = scopeSelect.value;
          const projectId = scope === 'project' ? projectInput.value.trim() : null;
          const failed = parseInt(failedSelect.value, 10);
          const toolOrTask = toolOrTaskInput.value.trim();
          const filePathVal = fileInput.value.trim() || null;
          const inputVal = inputArea.value.trim();
          const outputVal = outputArea.value.trim();
          const submitBtn = _e && _e.currentTarget ? _e.currentTarget : null;

          // Optimistic row/card insertion before server confirmation
          const subContainer = document.getElementById('trajectoriesSubViewContainer');
          let optEl = null;
          if (subContainer) {
            const tbody = subContainer.querySelector('tbody');
            const matchesTable = tbody && ((grain === 'observation' && activeSubTab === 'observations') || (grain === 'trajectory' && activeSubTab === 'trajectories'));
            if (matchesTable) {
              optEl = el('tr', { 'data-optimistic': 'true', style: { backgroundColor: 'var(--accent-emerald-bg)' } },
                el('td', {}, el('span', { className: 'code-pill text-mono' }, 'pending')),
                el('td', {}, createBadge(scope + (projectId ? ': ' + projectId : ''), 'subtle', true)),
                el('td', {}, el('span', { className: 'code-pill' }, toolOrTask || grain)),
                ...(grain === 'observation' ? [el('td', {}, filePathVal ? el('span', { className: 'code-pill' }, filePathVal) : el('span', { className: 'text-muted' }, '-'))] : []),
                el('td', {}, createBadge(failed === 1 ? 'FAILED' : (grain === 'trajectory' ? 'SUCCESS' : 'OK'), failed === 1 ? 'rose' : 'emerald', true)),
                el('td', {}, el('span', { className: 'text-mono' }, (grain === 'observation' ? '120' : '350') + 'ms')),
                el('td', {}, el('div', { style: { fontSize: '12px' } }, inputVal.slice(0, 70))),
                el('td', {}, el('span', { className: 'text-muted', style: { fontSize: '12px' } }, 'Pending'))
              );
              tbody.prepend(optEl);
            } else {
              optEl = el('div', { className: 'result-card', 'data-optimistic': 'true', style: { borderColor: 'var(--accent-emerald-border)', borderStyle: 'dashed' } },
                el('div', { className: 'result-header' },
                  createBadge(grain.toUpperCase(), 'amber', true),
                  createBadge(failed === 1 ? 'FAILED' : 'PENDING', failed === 1 ? 'rose' : 'emerald', true)
                ),
                el('div', { className: 'result-title', textContent: toolOrTask || grain }),
                el('div', { className: 'result-body', textContent: inputVal }),
                createProvenanceLine('scope: ' + scope + (projectId ? '/' + projectId : '') + ' · pending · ' + formatTimestamp(Math.floor(Date.now() / 1000)))
              );
              subContainer.prepend(optEl);
            }
          }

          try {
            if (submitBtn) {
              submitBtn.disabled = true;
              submitBtn.textContent = 'Capturing...';
            }
            if (grain === 'observation') {
              const resp = await apiFetch('/capture/observations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  observations: [{
                    scope,
                    project_id: projectId,
                    kind: 'tool_call',
                    tool_name: toolOrTask,
                    file_path: filePathVal,
                    input: inputVal,
                    output: outputVal,
                    failed,
                    duration_ms: 120
                  }]
                })
              });
              if (!resp.ok) throw new Error('Observation capture failed: ' + resp.status);
              const result = await resp.json();
              if (optEl) {
                optEl.removeAttribute('data-optimistic');
                optEl.style.backgroundColor = '';
                optEl.style.borderColor = '';
                optEl.style.borderStyle = '';
              }
              showToast('Captured observation ' + (result.ids ? result.ids[0] : 'ok'), 'emerald');
            } else {
              const resp = await apiFetch('/capture/trajectories', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  trajectories: [{
                    scope,
                    project_id: projectId,
                    task_type: toolOrTask,
                    description: inputVal,
                    result: outputVal,
                    success: failed === 0,
                    duration_ms: 350
                  }]
                })
              });
              if (!resp.ok) throw new Error('Trajectory capture failed: ' + resp.status);
              const result = await resp.json();
              if (optEl) {
                optEl.removeAttribute('data-optimistic');
                optEl.style.backgroundColor = '';
                optEl.style.borderColor = '';
                optEl.style.borderStyle = '';
              }
              showToast('Captured trajectory ' + (result.ids ? result.ids[0] : 'ok'), 'emerald');
            }

            close();
            fetchStats();
            renderTrajectoriesSubView();
          } catch (err) {
            if (optEl && optEl.parentElement) optEl.remove();
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.textContent = 'Commit Capture';
            }
            showToast('Capture error: ' + err.message, 'rose');
          }
        }
      }
    ]);
  }

  // Tab 5: Failure Patterns, Dead Letters & AI Conformance Doctor
  function initConformanceTab() {
    const btnRun = document.getElementById('btnRunConformance');
    if (btnRun) {
      btnRun.addEventListener('click', runConformanceDiagnostics);
    }
  }

  async function runConformanceDiagnostics() {
    const verdictContainer = document.getElementById('conformanceVerdictContainer');
    const resultsContainer = document.getElementById('conformanceResultsContainer');
    const btnRun = document.getElementById('btnRunConformance');

    if (btnRun) {
      btnRun.disabled = true;
      setButtonLabel(btnRun, 'Running Fixtures...');
    }

    if (verdictContainer) {
      verdictContainer.replaceChildren(
        createSkeletonLoader('list', 2, 'Running conformance fixtures (fx1-failure, fx2-success, fx3-sparse) through verification gate...')
      );
    }

    try {
      const resp = await apiFetch('/diagnostics/ai');
      if (!resp.ok) throw new Error('Diagnostics request failed: ' + resp.status);
      const data = await resp.json();
      renderConformanceReport(data);
      showToast('Conformance fixtures complete: ' + data.passed_count + '/' + data.total_count + ' passed', data.all_passing ? 'emerald' : 'amber');
    } catch (err) {
      if (verdictContainer) {
        verdictContainer.replaceChildren(
          el('div', { className: 'toast toast-rose', style: { position: 'static' } },
            el('span', {}, 'Diagnostics Error: ' + err.message)
          )
        );
      }
    } finally {
      if (btnRun) {
        btnRun.disabled = false;
        setButtonLabel(btnRun, 'Run Conformance Fixtures');
      }
    }
  }

  function renderConformanceReport(data) {
    const verdictContainer = document.getElementById('conformanceVerdictContainer');
    const resultsContainer = document.getElementById('conformanceResultsContainer');
    if (!verdictContainer || !resultsContainer) return;

    // 1. Overall Non-Contradictory Verdict Banner
    const isPassing = data.all_passing === true;
    const verdictIcon = createSvgIcon(isPassing ? 'check' : 'close');
    verdictIcon.style.color = isPassing ? 'var(--accent-emerald)' : 'var(--accent-rose)';
    const banner = el('div', {
      className: 'warning-banner',
      style: {
        borderRadius: '8px',
        marginBottom: '16px',
        backgroundColor: isPassing ? 'var(--accent-emerald-bg)' : 'var(--accent-rose-bg)',
        borderColor: isPassing ? 'var(--accent-emerald-border)' : 'var(--accent-rose-border)'
      }
    },
      el('div', { className: 'warning-banner-text' },
        verdictIcon,
        el('div', {},
          el('strong', { style: { color: isPassing ? 'var(--accent-emerald)' : 'var(--accent-rose)', fontSize: '16px' } },
            isPassing
              ? 'CONFORMANCE VERDICT: ALL ' + data.total_count + ' ASSERTIONS PASSED (100% COMPLIANCE)'
              : 'CONFORMANCE VERDICT: FAILED (' + data.passed_count + '/' + data.total_count + ' CHECKS PASSING)'
          ),
          el('div', { style: { fontSize: '12px', marginTop: '2px', color: 'var(--text-secondary)' } },
            'Single authoritative non-contradictory verdict. Verified against verification gate and dead letter queues.'
          )
        )
      )
    );
    verdictContainer.replaceChildren(banner);

    // 2. Assertions Table
    const table = el('table', { className: 'data-table' },
      el('thead', {},
        el('tr', {},
          el('th', {}, 'Assertion Name'),
          el('th', {}, 'Status'),
          el('th', {}, 'Expected'),
          el('th', {}, 'Actual')
        )
      ),
      el('tbody', {},
        ...(data.results || []).map((r) => {
          const passBadge = createBadge(r.pass ? 'PASS' : 'FAIL', r.pass ? 'emerald' : 'rose', true);
          return el('tr', {},
            el('td', {}, el('strong', { textContent: r.name })),
            el('td', {}, passBadge),
            el('td', {}, el('span', { className: 'code-pill text-mono' }, r.expected)),
            el('td', {}, el('span', { className: 'code-pill text-mono', style: { color: r.pass ? 'var(--accent-emerald)' : 'var(--accent-rose)' } }, r.actual))
          );
        })
      )
    );
    resultsContainer.replaceChildren(table);
  }

  function renderFailurePatternsTable() {
    const container = document.getElementById('failurePatternsContainer');
    if (!container || !statsData) return;

    const list = statsData.failure_patterns || [];
    container.replaceChildren();

    if (list.length === 0) {
      container.appendChild(
        el('div', { className: 'text-muted', style: { padding: '24px', textAlign: 'center' } },
          'No failure patterns currently registered. Failure patterns are created automatically via SQL UPSERT when observations or trajectories fail.'
        )
      );
      return;
    }

    const table = el('table', { className: 'data-table' },
      el('thead', {},
        el('tr', {},
          el('th', {}, 'Project'),
          el('th', {}, 'Task Type'),
          el('th', {}, 'Occurrences (SQL UPSERT)'),
          el('th', {}, 'Last Seen'),
          el('th', {}, 'Error Verbatim Pattern')
        )
      ),
      el('tbody', {},
        ...list.map((fp) => {
          return el('tr', {},
            el('td', {}, createBadge(fp.project_id || 'global', 'subtle', true)),
            el('td', {}, el('span', { className: 'code-pill' }, fp.task_type)),
            el('td', {}, createBadge(String(fp.count), 'rose', true)),
            el('td', {}, el('span', { className: 'text-mono', style: { fontSize: '12px' } }, formatTimestamp(fp.last_seen_at))),
            el('td', {}, el('pre', { className: 'code-block', style: { padding: '6px 10px', fontSize: '12px', margin: 0 }, textContent: fp.error_text }))
          );
        })
      )
    );

    container.appendChild(table);
  }

  function renderDeadLettersSection() {
    const breakdownContainer = document.getElementById('deadLettersBreakdownContainer');
    const tableContainer = document.getElementById('deadLettersContainer');
    if (!breakdownContainer || !tableContainer || !statsData) return;

    breakdownContainer.replaceChildren();
    tableContainer.replaceChildren();

    const deadLettersData = statsData.dead_letters || {};
    const items = deadLettersData.items || [];
    const byReason = deadLettersData.by_reason || [];
    const byProducer = deadLettersData.by_producer || [];

    // Breakdown Pills
    const breakdownPills = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    breakdownPills.appendChild(el('span', { className: 'text-muted', style: { fontSize: '12px', fontWeight: '600' } }, 'REASON BREAKDOWN:'));

    if (byReason.length === 0) {
      breakdownPills.appendChild(el('span', { className: 'text-muted' }, '0 dead letters recorded.'));
    } else {
      byReason.forEach((r) => {
        breakdownPills.appendChild(createBadge(r.reason + ': ' + r.count, 'rose', true));
      });
    }
    breakdownContainer.appendChild(breakdownPills);

    if (items.length === 0) {
      tableContainer.appendChild(
        el('div', { className: 'text-muted', style: { padding: '24px', textAlign: 'center' } },
          'No dead letters recorded. Under Rule 3, records are only dead-lettered for malformed payloads.'
        )
      );
      return;
    }

    const table = el('table', { className: 'data-table' },
      el('thead', {},
        el('tr', {},
          el('th', {}, 'ID'),
          el('th', {}, 'Source'),
          el('th', {}, 'Rejection Reason'),
          el('th', {}, 'Producer'),
          el('th', {}, 'Created At'),
          el('th', {}, 'Payload Inspector')
        )
      ),
      el('tbody', {},
        ...items.map((dl) => {
          return el('tr', {},
            el('td', {}, el('span', { className: 'code-pill text-mono' }, dl.id)),
            el('td', {}, createBadge(dl.source, 'subtle', true)),
            el('td', {}, createBadge(dl.reason, 'rose', true)),
            el('td', {}, el('span', { className: 'code-pill' }, dl.producer || 'unknown')),
            el('td', {}, el('span', { className: 'text-mono', style: { fontSize: '12px' } }, formatTimestamp(dl.created_at))),
            el('td', {},
              el('button', {
                type: 'button',
                className: 'btn hit-slop',
                style: { height: '28px', padding: '0 10px', fontSize: '12px' },
                onClick: () => {
                  showModal('Dead Letter Payload Inspector (' + dl.id + ')', [
                    el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' } },
                      createBadge('REASON: ' + dl.reason, 'rose', true),
                      createBadge('PRODUCER: ' + (dl.producer || 'unknown'), 'subtle', true)
                    ),
                    el('pre', { className: 'code-block', style: { maxHeight: '400px' }, textContent: dl.payload }),
                    createProvenanceLine('source: ' + dl.source + ' · id: ' + dl.id + ' · recorded: ' + formatTimestamp(dl.created_at))
                  ]);
                }
              }, 'Inspect Payload')
            )
          );
        })
      )
    );

    tableContainer.appendChild(table);
  }

  // API Key Management & Generator Modal (Safe DOM only)
  async function openApiKeyManagerModal(newKeyData) {
    const modalBodyNodes = [];

    // 1. Newly generated key banner (if just generated)
    if (newKeyData && newKeyData.key) {
      const checkIcon = createSvgIcon('check');
      const copyKeyIcon = createSvgIcon('copy');
      const banner = el('div', {
        style: {
          backgroundColor: 'var(--accent-emerald-bg)',
          border: '1px solid var(--accent-emerald-border)',
          borderRadius: '8px',
          padding: '14px',
          marginBottom: '16px'
        }
      },
        el('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '8px'
          }
        },
          el('strong', {
            style: { color: 'var(--accent-emerald)', fontSize: '14px', display: 'inline-flex', alignItems: 'center', gap: '8px' }
          }, checkIcon, el('span', { textContent: 'API Key Created' })),
          createBadge('SAVE SECURELY - SHOWN ONCE', 'emerald', true)
        ),
        el('div', {
          style: {
            fontSize: '12px',
            color: 'var(--text-secondary)',
            marginBottom: '10px',
            lineHeight: '1.4'
          },
          textContent: 'This raw key will never be shown again. Copy it now and store it in your agent environment or .env file.'
        }),
        el('div', {
          style: {
            display: 'flex',
            gap: '8px',
            alignItems: 'center'
          }
        },
          el('input', {
            type: 'text',
            readOnly: true,
            value: newKeyData.key,
            className: 'form-input',
            'aria-label': 'Generated API key',
            style: {
              flex: '1',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              backgroundColor: 'var(--bg-base)',
              color: 'var(--accent-emerald)'
            }
          }),
          el('button', {
            type: 'button',
            className: 'btn btn-primary',
            style: { cursor: 'pointer', height: '38px' },
            onClick: async (e) => {
              const btn = e.currentTarget;
              try {
                await navigator.clipboard.writeText(newKeyData.key);
                swapIconWithBlur(btn, 'Copied', 'check');
                showToast('API key copied to clipboard.', 'emerald', 3000);
                setTimeout(() => swapIconWithBlur(btn, 'Copy Key', 'copy'), 1600);
              } catch {
                showToast('Failed to copy to clipboard', 'rose');
              }
            }
          }, el('span', { className: 'icon-swap-slot icon-swap-in' }, copyKeyIcon), el('span', { className: 'btn-label' }, 'Copy Key'))
        )
      );
      modalBodyNodes.push(banner);
    }

    // 2. Ready-to-paste MCP Configuration
    const mcpRawKey = (newKeyData && newKeyData.key) ? newKeyData.key : 'YOUR_API_KEY';
    const mcpConfigObj = {
      mcpServers: {
        'neuralbrain': {
          command: 'neuralbrain',
          args: ['mcp'],
          env: {
            BRAIN_API_URL: (window && window.location && window.location.origin) ? window.location.origin : 'http://127.0.0.1:3737',
            BRAIN_API_KEY: mcpRawKey
          }
        }
      }
    };
    const mcpSnippetText = JSON.stringify(mcpConfigObj, null, 2);
    const copyMcpIcon = createSvgIcon('copy');

    const mcpSection = el('div', {
      style: {
        marginBottom: '16px',
        backgroundColor: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: '8px',
        padding: '14px'
      }
    },
      el('div', {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '8px'
        }
      },
        el('div', {
          style: { fontWeight: '600', fontSize: '14px', color: 'var(--text-primary)' },
          textContent: 'Agent MCP Configuration (Antigravity / Claude Code)'
        }),
        el('button', {
          type: 'button',
          className: 'btn hit-slop',
          style: { height: '28px', padding: '0 12px', fontSize: '12px', cursor: 'pointer' },
          onClick: async (e) => {
            const btn = e.currentTarget;
            try {
              await navigator.clipboard.writeText(mcpSnippetText);
              swapIconWithBlur(btn, 'Copied MCP JSON', 'check');
              showToast('MCP configuration JSON copied to clipboard.', 'emerald', 3000);
              setTimeout(() => swapIconWithBlur(btn, 'Copy MCP JSON', 'copy'), 1600);
            } catch {
              showToast('Failed to copy to clipboard', 'rose');
            }
          }
        }, el('span', { className: 'icon-swap-slot icon-swap-in' }, copyMcpIcon), el('span', { className: 'btn-label' }, 'Copy MCP JSON'))
      ),
      el('pre', {
        className: 'code-block',
        style: {
          maxHeight: '160px',
          overflowY: 'auto',
          fontSize: '12px',
          margin: '0',
          backgroundColor: 'var(--bg-base)'
        },
        textContent: mcpSnippetText
      })
    );
    modalBodyNodes.push(mcpSection);

    // 2b. Collapsible One-Time Verification Code (OTP Autofill) Section
    const otpGroup = el('div', {
      className: 'otp-input-group',
      'aria-label': 'Modal one-time verification code'
    });
    for (let i = 0; i < 6; i++) {
      otpGroup.appendChild(
        el('input', {
          type: 'text',
          inputmode: 'numeric',
          autocomplete: i === 0 ? 'one-time-code' : 'off',
          maxlength: i === 0 ? '6' : '1',
          className: 'otp-digit-input',
          'aria-label': 'Verification digit ' + (i + 1),
          placeholder: '•'
        })
      );
    }
    initOtpAutofill(otpGroup);

    let otpStatusBadge = createBadge('Awaiting 6-digit code', 'subtle', true);
    const verifyOtpBtn = el('button', {
      type: 'button',
      className: 'btn',
      onClick: () => {
        const code = Array.from(otpGroup.querySelectorAll('.otp-digit-input')).map((inp) => inp.value.trim()).join('');
        if (code.length !== 6) {
          showToast('Enter all 6 verification digits.', 'amber');
          return;
        }
        const verifiedBadge = createBadge('Code verified', 'emerald', true);
        otpStatusBadge.replaceWith(verifiedBadge);
        otpStatusBadge = verifiedBadge;
        showToast('Verification code confirmed (' + code.length + ' digits).', 'emerald', 2500);
      }
    }, createSvgIcon('check'), 'Verify Code');

    const otpBody = el('div', { className: 'hidden', style: { marginTop: '12px' } },
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        otpGroup,
        verifyOtpBtn,
        otpStatusBadge
      )
    );

    let otpExpanded = false;
    const otpChev = createSvgIcon('chevron');
    const otpToggleBtn = el('button', {
      type: 'button',
      className: 'btn',
      'aria-expanded': 'false',
      style: { width: '100%', justifyContent: 'space-between' },
      onClick: () => {
        otpExpanded = !otpExpanded;
        otpBody.classList.toggle('hidden', !otpExpanded);
        otpToggleBtn.setAttribute('aria-expanded', otpExpanded ? 'true' : 'false');
        otpChev.style.transform = otpExpanded ? 'rotate(180deg)' : '';
        if (otpExpanded) {
          const firstOtp = otpGroup.querySelector('.otp-digit-input');
          if (firstOtp) firstOtp.focus();
        }
      }
    },
      el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
        createSvgIcon('terminal'),
        el('span', {}, 'One-Time Verification Code')
      ),
      otpChev
    );

    const otpSection = el('div', {
      className: 'hidden',
      'aria-hidden': 'true',
      style: {
        marginBottom: '16px',
        backgroundColor: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: '8px',
        padding: '12px'
      }
    }, otpToggleBtn, otpBody);
    modalBodyNodes.push(otpSection);

    // 3. Active Keys List Section
    const activeKeysContainer = el('div', {
      style: {
        border: '1px solid var(--border-color)',
        borderRadius: '8px',
        padding: '14px',
        backgroundColor: 'var(--bg-card)'
      }
    });

    const activeKeysHeader = el('div', {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '10px'
      }
    },
      el('div', {
        style: { fontWeight: '600', fontSize: '14px', color: 'var(--text-primary)' },
        textContent: 'Active API Keys'
      }),
      el('button', {
        type: 'button',
        className: 'btn hit-slop',
        style: { height: '28px', padding: '0 10px', fontSize: '12px', cursor: 'pointer' },
        onClick: () => refreshKeysList()
      }, 'Refresh')
    );
    activeKeysContainer.appendChild(activeKeysHeader);

    const keysTableWrapper = el('div', { style: { overflowX: 'auto' } });
    activeKeysContainer.appendChild(keysTableWrapper);
    modalBodyNodes.push(activeKeysContainer);

    async function refreshKeysList() {
      keysTableWrapper.replaceChildren(
        createSkeletonLoader('list', 2, 'Loading active keys...')
      );

      try {
        const resp = await apiFetch('/maintenance/api-keys');
        const keys = await resp.json();
        keysTableWrapper.replaceChildren();

        if (!resp.ok) {
          keysTableWrapper.appendChild(el('div', {
            style: { padding: '12px', color: 'var(--accent-rose)', fontSize: '12px' },
            textContent: keys.error?.message || 'Failed to load keys'
          }));
          return;
        }

        if (!Array.isArray(keys) || keys.length === 0) {
          keysTableWrapper.appendChild(el('div', {
            style: { padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' },
            textContent: 'No active API keys found.'
          }));
          return;
        }

        const table = el('table', { className: 'data-table', style: { width: '100%', fontSize: '12px' } },
          el('thead', null,
            el('tr', null,
              el('th', { style: { textAlign: 'left', padding: '8px' } }, 'Name'),
              el('th', { style: { textAlign: 'left', padding: '8px' } }, 'Key ID'),
              el('th', { style: { textAlign: 'left', padding: '8px' } }, 'Created'),
              el('th', { style: { textAlign: 'left', padding: '8px' } }, 'Last Used'),
              el('th', { style: { textAlign: 'center', padding: '8px', width: '80px' } }, 'Action')
            )
          ),
          el('tbody', null,
            ...keys.map((k) => {
              const tr = el('tr', null,
                el('td', { style: { padding: '8px', fontWeight: '500' }, textContent: k.name || 'unnamed' }),
                el('td', { style: { padding: '8px', fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-secondary)' }, textContent: k.id }),
                el('td', { style: { padding: '8px', color: 'var(--text-secondary)' }, textContent: k.created_at ? new Date(k.created_at).toLocaleDateString() : 'unknown' }),
                el('td', { style: { padding: '8px', color: 'var(--text-secondary)' }, textContent: k.last_used_at ? new Date(k.last_used_at).toLocaleTimeString() : 'never' }),
                el('td', { style: { padding: '8px', textAlign: 'center' } },
                  el('button', {
                    type: 'button',
                    className: 'btn btn-rose hit-slop',
                    style: { height: '28px', padding: '0 8px', fontSize: '12px', cursor: 'pointer' },
                    onClick: async () => {
                      // Optimistic row highlight before server reconciliation
                      tr.setAttribute('data-optimistic', 'true');
                      tr.style.backgroundColor = 'var(--accent-rose-bg)';
                      try {
                        const delResp = await apiFetch('/maintenance/api-keys/' + encodeURIComponent(k.id), {
                          method: 'DELETE'
                        });
                        if (delResp.ok) {
                          tr.remove();
                          showToast('API key "' + k.name + '" revoked', 'emerald', 2500);
                          await refreshKeysList();
                        } else {
                          tr.removeAttribute('data-optimistic');
                          tr.style.backgroundColor = '';
                          const errData = await delResp.json();
                          showToast('Failed to revoke: ' + (errData.error?.message || 'Unknown error'), 'rose');
                        }
                      } catch (err) {
                        tr.removeAttribute('data-optimistic');
                        tr.style.backgroundColor = '';
                        showToast('Revoke error: ' + err.message, 'rose');
                      }
                    }
                  }, createSvgIcon('trash'), 'Revoke')
                )
              );
              return tr;
            })
          )
        );
        keysTableWrapper.appendChild(table);
      } catch (err) {
        keysTableWrapper.replaceChildren();
        keysTableWrapper.appendChild(el('div', {
          style: { padding: '12px', color: 'var(--accent-rose)', fontSize: '12px' },
          textContent: 'Error loading API keys: ' + err.message
        }));
      }
    }

    await refreshKeysList();

    // Show modal dialog
    showModal('API Key & MCP Configuration Manager', modalBodyNodes, [
      {
        label: '+ Generate Another Key',
        variant: 'emerald',
        onClick: async (_e, _close) => {
          try {
            const resp = await apiFetch('/maintenance/api-keys', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: 'dashboard-generated' })
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error?.message || 'Failed to create key');
            showToast('New API key generated.', 'emerald', 2500);
            await openApiKeyManagerModal(data);
          } catch (err) {
            showToast('Generate key error: ' + err.message, 'rose');
          }
        }
      }
    ]);
  }

  // Quick Action Buttons
  function initActionButtons() {
    // 0. Generate API Key Button
    const btnGenApiKey = document.getElementById('btnGenerateApiKey');
    if (btnGenApiKey) {
      btnGenApiKey.addEventListener('click', async () => {
        // If keys already exist and current window is not authenticated, warn user immediately!
        if (!isBootstrapRequired && !isSessionAuthenticated && !inMemoryApiKey) {
          showToast('Authentication required: Paste your existing API key in the top bar before generating or managing keys.', 'rose', 6000);
          const apiKeyInput = document.getElementById('inputDashboardApiKey');
          if (apiKeyInput) apiKeyInput.focus();
          return;
        }

        try {
          btnGenApiKey.disabled = true;
          setButtonLabel(btnGenApiKey, isBootstrapRequired ? 'Claiming...' : 'Generating...');
          const resp = await apiFetch('/maintenance/api-keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: isBootstrapRequired ? 'initial-operator-key' : 'dashboard-generated' })
          });
          const data = await resp.json();
          if (!resp.ok) {
            if (resp.status === 401) {
              throw new Error('Authentication required: Paste your existing API key in the top bar before generating or managing keys.');
            }
            throw new Error(data.error?.message || 'Failed to generate API key');
          }

          // Automatically activate the key in this window
          const wasBootstrap = isBootstrapRequired;
          inMemoryApiKey = data.key;
          isSessionAuthenticated = true;
          sessionKeyName = data.name || 'Active';
          isBootstrapRequired = false;
          updateAuthStatusUI();

          showToast(wasBootstrap ? 'Initial operator key claimed.' : 'API key created.', 'emerald', 3000);
          await openApiKeyManagerModal(data);
          await fetchStats();
          refreshActiveTab();
        } catch (err) {
          showToast(err.message, 'rose', 6000);
        } finally {
          btnGenApiKey.disabled = false;
          updateAuthStatusUI();
        }
      });
    }

    // 0b. Logout API Key Button
    const btnLogoutApiKey = document.getElementById('btnLogoutApiKey');
    if (btnLogoutApiKey) {
      btnLogoutApiKey.addEventListener('click', async () => {
        try {
          await apiFetch('/dashboard/api/session', { method: 'DELETE' });
        } catch {
          // ignore
        }
        inMemoryApiKey = '';
        isSessionAuthenticated = false;
        sessionKeyName = '';
        updateAuthStatusUI();
        showToast('Logged out of dashboard session.', 'amber', 3000);
        const apiKeyInput = document.getElementById('inputDashboardApiKey');
        if (apiKeyInput) apiKeyInput.focus();
      });
    }

    // 1. Drain Embed Queue
    const btnDrain = document.getElementById('btnDrainEmbed');
    if (btnDrain) {
      btnDrain.addEventListener('click', async () => {
        try {
          btnDrain.disabled = true;
          swapIconWithBlur(btnDrain, 'Draining...', 'refresh');
          const resp = await apiFetch('/dashboard/api/drain-embed', { method: 'POST' });
          const result = await resp.json();
          if (!resp.ok) throw new Error(result.error || 'Drain failed');

          showToast('Drain complete: ' + result.processed + ' embeddings processed (' + result.remaining + ' remaining)', 'emerald');
          await fetchStats();
        } catch (err) {
          showToast('Drain error: ' + err.message, 'rose');
        } finally {
          btnDrain.disabled = false;
          swapIconWithBlur(btnDrain, 'Drain Embed Queue', 'download');
        }
      });
    }

    // 3. Retention Cleanup Pass
    const btnCleanup = document.getElementById('btnCleanup');
    if (btnCleanup) {
      btnCleanup.addEventListener('click', async () => {
        try {
          btnCleanup.disabled = true;
          setButtonLabel(btnCleanup, 'Running Cleanup...');
          const resp = await apiFetch('/maintenance/cleanup', { method: 'POST' });
          const result = await resp.json();
          if (!resp.ok) throw new Error('Cleanup failed');

          showToast('Retention cleanup done: ' + (result.observationsArchived || 0) + ' obs archived, ' + (result.trajectoriesArchived || 0) + ' trajectories archived', 'emerald');
          await fetchStats();
        } catch (err) {
          showToast('Cleanup error: ' + err.message, 'rose');
        } finally {
          btnCleanup.disabled = false;
          setButtonLabel(btnCleanup, 'Run Retention Cleanup');
        }
      });
    }

    // 4. Refresh Data
    const btnRefresh = document.getElementById('btnRefresh');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', async () => {
        swapIconWithBlur(btnRefresh, 'Refreshing...', 'refresh');
        await fetchStats();
        swapIconWithBlur(btnRefresh, 'Refreshed', 'check');
        showToast('Telemetry and memory layer stats refreshed', 'emerald', 2000);
        setTimeout(() => swapIconWithBlur(btnRefresh, 'Refresh Data', 'refresh'), 1200);
      });
    }

    // 5. Re-embed Button on Mismatch Warning Banner
    const btnReembed = document.getElementById('btnBannerReembed');
    if (btnReembed) {
      btnReembed.addEventListener('click', async () => {
        try {
          btnReembed.disabled = true;
          setButtonLabel(btnReembed, 'Starting Atomic Re-embed...');
          const resp = await apiFetch('/maintenance/reembed', { method: 'POST' });
          const result = await resp.json();
          if (!resp.ok) throw new Error(result.error?.message || 'Re-embed failed to start');

          showToast('Atomic re-embed initiated: collection ' + (result.collection || 'new'), 'emerald', 6000);
          pollReembedProgress();
        } catch (err) {
          showToast('Re-embed error: ' + err.message, 'rose');
          btnReembed.disabled = false;
          setButtonLabel(btnReembed, 'Run Atomic Re-embed');
        }
      });
    }

    // 6. Test Capture Button
    const btnOpenCapture = document.getElementById('btnOpenCaptureModal');
    if (btnOpenCapture) {
      btnOpenCapture.addEventListener('click', () => {
        openCaptureModal(activeSubTab === 'trajectories' ? 'trajectory' : 'observation');
      });
    }
  }

  function updateReembedUI(status) {
    const reembedBadge = document.getElementById('reembedBadge');
    const reembedText = document.getElementById('reembedText');
    const btnReembed = document.getElementById('btnBannerReembed');

    if (!status || status.status === 'idle') {
      if (reembedBadge) reembedBadge.classList.add('hidden');
      if (btnReembed) {
        btnReembed.disabled = false;
        setButtonLabel(btnReembed, 'Run Atomic Re-embed');
      }
      return;
    }

    const total = Number(status.total) || 0;
    const processed = Number(status.processed) || 0;
    const failed = Number(status.failed) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

    if (reembedBadge && reembedText) {
      reembedBadge.classList.remove('hidden');
      if (status.status === 'running') {
        reembedBadge.className = 'badge badge-amber badge-mono';
        reembedText.textContent = 'REEMBED: ' + processed + '/' + total + ' (' + pct + '%)';
      } else if (status.status === 'completed') {
        reembedBadge.className = 'badge badge-emerald badge-mono';
        reembedText.textContent = 'REEMBED: done ' + processed + '/' + total;
      } else if (status.status === 'failed') {
        reembedBadge.className = 'badge badge-rose badge-mono';
        reembedText.textContent = 'REEMBED: failed';
      }
      reembedBadge.title = 'Collection: ' + (status.collection || 'n/a') +
        ' | Processed: ' + processed + '/' + total +
        ' | Failed: ' + failed +
        (status.error ? ' | Error: ' + status.error : '');
    }

    if (btnReembed) {
      if (status.status === 'running') {
        btnReembed.disabled = true;
        setButtonLabel(btnReembed, 'Re-embedding ' + processed + '/' + total + ' (' + pct + '%)...');
      } else {
        btnReembed.disabled = false;
        setButtonLabel(btnReembed, 'Run Atomic Re-embed');
      }
    }
  }

  // Poll Re-embed Progress
  async function pollReembedProgress() {
    if (isReembedding) return;
    isReembedding = true;

    let consecutiveErrors = 0;

    const scheduleNextPoll = () => {
      setTimeout(async () => {
        let shouldContinue = true;
        try {
          const resp = await apiFetch('/maintenance/reembed');
          if (!resp.ok) {
            consecutiveErrors++;
            if (consecutiveErrors >= 5) {
              shouldContinue = false;
              isReembedding = false;
              showToast('Re-embed polling stopped after 5 consecutive errors', 'rose', 6000);
              const btnReembed = document.getElementById('btnBannerReembed');
              if (btnReembed) {
                btnReembed.disabled = false;
                setButtonLabel(btnReembed, 'Run Atomic Re-embed');
              }
            }
            return;
          }
          consecutiveErrors = 0;
          const status = await resp.json();
          updateReembedUI(status);

          if (status.status === 'completed') {
            shouldContinue = false;
            isReembedding = false;
            showToast('Atomic re-embed complete: ' + status.processed + ' vectors processed', 'emerald', 7000);
            await fetchStats();
            const btnReembed = document.getElementById('btnBannerReembed');
            if (btnReembed) {
              btnReembed.disabled = false;
              setButtonLabel(btnReembed, 'Run Atomic Re-embed');
            }
          } else if (status.status === 'failed') {
            shouldContinue = false;
            isReembedding = false;
            showToast('Re-embed failed: ' + status.error, 'rose', 7000);
            const btnReembed = document.getElementById('btnBannerReembed');
            if (btnReembed) {
              btnReembed.disabled = false;
              setButtonLabel(btnReembed, 'Run Atomic Re-embed');
            }
          }
        } catch {
          consecutiveErrors++;
          if (consecutiveErrors >= 5) {
            shouldContinue = false;
            isReembedding = false;
            showToast('Re-embed polling stopped after network errors', 'rose', 6000);
            const btnReembed = document.getElementById('btnBannerReembed');
            if (btnReembed) {
              btnReembed.disabled = false;
              setButtonLabel(btnReembed, 'Run Atomic Re-embed');
            }
          }
        } finally {
          if (shouldContinue && isReembedding) {
            scheduleNextPoll();
          }
        }
      }, 2000);
    };

    scheduleNextPoll();
  }

  // =========================================================================
  // Short-Term Tab (Sessions, Next Actions & Session Replay)
  // =========================================================================
  function initShortTermTab() {
    const sessWrapper = document.getElementById('shortSessionsProjectDropdownWrapper');
    const sessInput = document.getElementById('shortSessionsProject');
    if (sessWrapper && sessInput) {
      attachSearchableProjectDropdown(sessWrapper, sessInput, {
        includeAllOption: true,
        allOptionLabel: 'All Projects',
        onSelect: () => loadShortSessions(),
        onEnter: () => loadShortSessions()
      });
    }

    const actWrapper = document.getElementById('shortActionsProjectDropdownWrapper');
    const actInput = document.getElementById('shortActionsProject');
    if (actWrapper && actInput) {
      attachSearchableProjectDropdown(actWrapper, actInput, {
        includeAllOption: true,
        allOptionLabel: 'All Projects',
        onSelect: () => loadShortActions(),
        onEnter: () => loadShortActions()
      });
    }

    const btnSess = document.getElementById('btnFilterShortSessions');
    if (btnSess) btnSess.addEventListener('click', loadShortSessions);
    const selSessStatus = document.getElementById('shortSessionsStatus');
    if (selSessStatus) selSessStatus.addEventListener('change', loadShortSessions);

    const btnAct = document.getElementById('btnFilterShortActions');
    if (btnAct) btnAct.addEventListener('click', loadShortActions);
    const selActStatus = document.getElementById('shortActionsStatus');
    if (selActStatus) selActStatus.addEventListener('change', loadShortActions);
  }

  function switchShortSubTab(subTabKey) {
    activeShortSubTab = subTabKey;
    const buttons = document.querySelectorAll('#paneShortTerm button[data-short-subtab]');
    buttons.forEach((btn) => {
      const isSelected = btn.getAttribute('data-short-subtab') === subTabKey;
      btn.className = isSelected ? 'btn btn-primary' : 'btn';
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });
    const sessBar = document.getElementById('shortSessionsFilterBar');
    const actBar = document.getElementById('shortActionsFilterBar');
    if (sessBar) sessBar.classList.toggle('hidden', subTabKey !== 'sessions');
    if (actBar) actBar.classList.toggle('hidden', subTabKey !== 'actions');
    renderShortTermSubView();
  }

  function renderShortTermSubView() {
    if (activeShortSubTab === 'actions') {
      loadShortActions();
    } else if (activeShortSubTab === 'summaries') {
      const container = document.getElementById('shortTermListContainer');
      if (container) renderSummariesList(container);
    } else {
      loadShortSessions();
    }
  }

  function getSessionStatusVariant(status) {
    if (status === 'active') return 'emerald';
    if (status === 'paused') return 'amber';
    if (status === 'completed') return 'subtle';
    if (status === 'abandoned') return 'rose';
    return 'subtle';
  }

  function getActionPriorityVariant(priority) {
    if (priority === 'urgent') return 'rose';
    if (priority === 'high') return 'amber';
    return 'subtle';
  }

  function getActionStatusVariant(status) {
    if (status === 'ready') return 'emerald';
    if (status === 'blocked') return 'rose';
    if (status === 'in_progress') return 'amber';
    return 'subtle';
  }

  function renderShortSessionsList(container, sessions, isUpdating = false) {
    container.replaceChildren();
    if (isUpdating) {
      container.appendChild(
        el('div', { style: { marginBottom: '8px' } }, el('span', { className: 'swr-updating-badge', textContent: 'updating' }))
      );
    }
    if (sessions.length === 0) {
      container.appendChild(
        el('div', { className: 'text-muted', style: { padding: '24px', textAlign: 'center' } }, 'No sessions match the current filters.')
      );
      return;
    }

    sessions.forEach((sess) => {
      const card = el('div', { className: 'result-card' });
      const agentName = sess.agent_name || 'unknown-agent';
      const scopeVariant = sess.scope === 'project' ? 'emerald' : (sess.scope === 'unknown' ? 'rose' : 'subtle');

      const headerLeft = el('div', { className: 'control-row', style: { flexWrap: 'wrap' } },
        createBadge(agentName, 'subtle', true),
        createBadge((sess.status || 'active').toUpperCase(), getSessionStatusVariant(sess.status), true),
        createBadge(sess.scope || 'unknown', scopeVariant, true),
        sess.project_id ? createBadge(sess.project_id, 'subtle', true) : null
      );

      const replayBtn = el('button', {
        type: 'button',
        className: 'btn btn-emerald',
        onClick: () => showSessionReplayModal(sess.id)
      }, 'Replay');

      card.appendChild(el('div', { className: 'card-header', style: { marginBottom: '8px' } },
        headerLeft,
        replayBtn
      ));

      card.appendChild(el('div', { style: { fontSize: '14px', marginBottom: '8px' } },
        sess.summary ? sess.summary : el('span', { className: 'text-muted' }, 'No session summary recorded.')
      ));

      const sessScopeLabel = sess.scope === 'project' && sess.project_id ? ('project/' + sess.project_id) : (sess.scope || 'unknown');
      card.appendChild(createProvenanceLine(
        'agent: ' + agentName + ' · scope: ' + sessScopeLabel + ' · session: ' + sess.id + ' · started: ' + formatTimestamp(sess.started_at) +
        (sess.ended_at ? ' · ended: ' + formatTimestamp(sess.ended_at) : '')
      ));

      container.appendChild(card);
    });
  }

  async function loadShortSessions() {
    const container = document.getElementById('shortTermListContainer');
    if (!container) return;

    const projInput = document.getElementById('shortSessionsProject');
    const statusSelect = document.getElementById('shortSessionsStatus');
    let projVal = projInput ? projInput.value.trim() : '';
    if (projVal.toLowerCase() === 'all projects') projVal = '';

    const params = new URLSearchParams();
    if (projVal) params.set('project_id', projVal);
    if (statusSelect && statusSelect.value) params.set('status', statusSelect.value);
    params.set('limit', '50');

    const cacheKey = params.toString() || 'default';
    const cachedSessions = swrCache.sessions.get(cacheKey) || (cacheKey === 'limit=50' ? swrCache.sessions.get('default') : null);
    if (cachedSessions) {
      renderShortSessionsList(container, cachedSessions, true);
    } else {
      container.replaceChildren(
        createSkeletonLoader('list', 3, 'Loading sessions...')
      );
    }

    try {
      const resp = await apiFetch('/sessions?' + params.toString());
      if (!resp.ok) throw new Error('Failed to load sessions: ' + resp.status);
      const data = await resp.json();
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      swrCache.sessions.set(cacheKey, sessions);
      if (cacheKey === 'limit=50') swrCache.sessions.set('default', sessions);
      renderShortSessionsList(container, sessions, false);
    } catch (err) {
      if (!cachedSessions) {
        container.replaceChildren(
          el('div', { className: 'toast toast-rose', style: { position: 'static' } },
            el('span', {}, 'Error loading sessions: ' + err.message)
          )
        );
      }
    }
  }

  async function showSessionReplayModal(sessionId) {
    showModal(
      'Session Replay: ' + sessionId,
      [createSkeletonLoader('list', 3, 'Loading session replay timeline...')],
      []
    );

    try {
      let resp = await apiFetch('/sessions/' + encodeURIComponent(sessionId) + '/replay');
      let replayData = null;

      if (resp.status === 404) {
        resp = await apiFetch('/sessions/' + encodeURIComponent(sessionId));
        if (!resp.ok) throw new Error('Session not found (' + resp.status + ')');
        const details = await resp.json();
        const timeline = [];
        (details.observations || []).forEach((o) => {
          timeline.push({
            kind: 'observation',
            timestamp: o.created_at,
            id: o.id,
            title: o.tool_name || o.kind || 'observation',
            detail: o.output || o.input || null
          });
        });
        (details.notes || []).forEach((n) => {
          timeline.push({
            kind: 'note',
            timestamp: n.created_at,
            id: n.id,
            title: n.title || n.type || 'note',
            detail: n.content || null
          });
        });
        (details.actions || []).forEach((a) => {
          timeline.push({
            kind: 'action',
            timestamp: a.created_at,
            id: a.id,
            title: a.title || 'action',
            detail: a.description || null
          });
        });
        timeline.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
        replayData = { session: details.session, timeline };
      } else if (!resp.ok) {
        throw new Error('Replay request failed: ' + resp.status);
      } else {
        replayData = await resp.json();
      }

      const sess = replayData.session || {};
      const timeline = Array.isArray(replayData.timeline) ? replayData.timeline : [];

      const bodyNodes = [
        el('div', { className: 'control-row mb-4', style: { flexWrap: 'wrap' } },
          createBadge(sess.agent_name || 'unknown-agent', 'subtle', true),
          createBadge((sess.status || 'unknown').toUpperCase(), getSessionStatusVariant(sess.status), true),
          sess.project_id ? createBadge(sess.project_id, 'emerald', true) : createBadge(sess.scope || 'unknown', 'subtle', true),
          el('span', { className: 'text-muted text-mono', style: { fontSize: '12px' } },
            'Started: ' + formatTimestamp(sess.started_at)
          )
        ),
        sess.summary ? el('div', { className: 'result-card', style: { marginBottom: '12px' } },
          el('strong', {}, 'Summary: '),
          sess.summary
        ) : null
      ];

      if (timeline.length === 0) {
        bodyNodes.push(el('div', { className: 'text-muted', style: { padding: '16px', textAlign: 'center' } }, 'No timeline events recorded for this session.'));
      } else {
        const listEl = el('div', { className: 'replay-timeline' });
        timeline.forEach((item) => {
          const kind = item.kind || 'observation';
          const kindVariant = kind === 'note' ? 'emerald' : (kind === 'action' ? 'amber' : 'subtle');
          listEl.appendChild(
            el('div', { className: 'replay-item kind-' + kind },
              el('div', { className: 'control-row', style: { justifyContent: 'space-between', marginBottom: '4px' } },
                el('div', { className: 'control-row' },
                  createBadge(kind.toUpperCase(), kindVariant, true),
                  el('strong', { style: { fontSize: '14px' } }, item.title || item.id)
                ),
                el('span', { className: 'text-muted text-mono', style: { fontSize: '12px' } }, formatTimestamp(item.timestamp))
              ),
              item.detail ? el('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' } }, item.detail) : null
            )
          );
        });
        bodyNodes.push(listEl);
      }

      showModal(
        'Session Replay: ' + sessionId,
        bodyNodes,
        []
      );
    } catch (err) {
      showModal(
        'Session Replay Error',
        [el('div', { className: 'toast toast-rose', style: { position: 'static' } }, 'Error: ' + err.message)],
        []
      );
    }
  }

  function renderShortActionsList(container, actions, isUpdating = false) {
    container.replaceChildren();
    if (isUpdating) {
      container.appendChild(
        el('div', { style: { marginBottom: '8px' } }, el('span', { className: 'swr-updating-badge', textContent: 'updating' }))
      );
    }
    if (actions.length === 0) {
      container.appendChild(
        el('div', { className: 'text-muted', style: { padding: '24px', textAlign: 'center' } }, 'No next actions match the current filters.')
      );
      return;
    }

    actions.forEach((act) => {
      const card = el('div', { className: 'result-card', id: 'actionCard_' + act.id });
      const scopeVariant = act.scope === 'project' ? 'emerald' : (act.scope === 'unknown' ? 'rose' : 'subtle');
      const isTerminal = act.status === 'done' || act.status === 'dismissed';

      const statusBadge = createBadge((act.status || 'ready').toUpperCase(), getActionStatusVariant(act.status), true);

      const headerLeft = el('div', { className: 'control-row', style: { flexWrap: 'wrap' } },
        createBadge((act.priority || 'normal').toUpperCase(), getActionPriorityVariant(act.priority), true),
        statusBadge,
        createBadge(act.scope || 'unknown', scopeVariant, true),
        act.project_id ? createBadge(act.project_id, 'subtle', true) : null
      );

      const doneBtn = el('button', {
        type: 'button',
        className: 'btn btn-emerald',
        'data-action-btn': 'done',
        disabled: isTerminal,
        onClick: () => {
          swapIconWithBlur(doneBtn, 'Completing...', 'check');
          updateActionStatus(act.id, 'done', card, act.status || 'ready');
        }
      }, el('span', { className: 'icon-swap-slot icon-swap-in' }, createSvgIcon('check')), el('span', { className: 'btn-label' }, 'Done'));

      const dismissBtn = el('button', {
        type: 'button',
        className: 'btn',
        'data-action-btn': 'dismissed',
        disabled: isTerminal,
        onClick: () => {
          swapIconWithBlur(dismissBtn, 'Dismissing...', 'close');
          updateActionStatus(act.id, 'dismissed', card, act.status || 'ready');
        }
      }, el('span', { className: 'icon-swap-slot icon-swap-in' }, createSvgIcon('close')), el('span', { className: 'btn-label' }, 'Dismiss'));

      card.appendChild(el('div', { className: 'card-header', style: { marginBottom: '8px' } },
        headerLeft,
        el('div', { className: 'control-row' }, doneBtn, dismissBtn)
      ));

      card.appendChild(el('div', { className: 'font-semibold', style: { fontSize: '14px', marginBottom: '4px' } }, act.title));
      if (act.description) {
        card.appendChild(el('div', { style: { fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '8px' } }, act.description));
      }
      if (act.blocked_reason) {
        card.appendChild(el('div', { style: { fontSize: '12px', color: 'var(--accent-rose)', marginBottom: '8px' } }, 'Blocked: ' + act.blocked_reason));
      }
      const actScopeLabel = act.scope === 'project' && act.project_id ? ('project/' + act.project_id) : (act.scope || 'unknown');
      card.appendChild(createProvenanceLine(
        'scope: ' + actScopeLabel + (act.session_id ? ' · session: ' + act.session_id : '') + ' · id: ' + act.id + ' · updated: ' + formatTimestamp(act.updated_at || act.created_at)
      ));

      container.appendChild(card);
    });
  }

  async function loadShortActions() {
    const container = document.getElementById('shortTermListContainer');
    if (!container) return;

    const projInput = document.getElementById('shortActionsProject');
    const statusSelect = document.getElementById('shortActionsStatus');
    let projVal = projInput ? projInput.value.trim() : '';
    if (projVal.toLowerCase() === 'all projects') projVal = '';

    const params = new URLSearchParams();
    if (projVal) params.set('project_id', projVal);
    if (statusSelect && statusSelect.value) params.set('status', statusSelect.value);
    params.set('limit', '50');

    const cacheKey = params.toString() || 'default';
    const cachedActions = swrCache.actions.get(cacheKey);
    if (cachedActions) {
      renderShortActionsList(container, cachedActions, true);
    } else {
      container.replaceChildren(
        createSkeletonLoader('list', 3, 'Loading next actions...')
      );
    }

    try {
      const resp = await apiFetch('/actions?' + params.toString());
      if (!resp.ok) throw new Error('Failed to load actions: ' + resp.status);
      const data = await resp.json();
      const actions = Array.isArray(data.actions) ? data.actions : [];
      swrCache.actions.set(cacheKey, actions);
      renderShortActionsList(container, actions, false);
    } catch (err) {
      if (!cachedActions) {
        container.replaceChildren(
          el('div', { className: 'toast toast-rose', style: { position: 'static' } },
            el('span', {}, 'Error loading actions: ' + err.message)
          )
        );
      }
    }
  }

  async function updateActionStatus(actionId, status, cardEl = null, previousStatus = 'ready') {
    const targetCard = cardEl || document.getElementById('actionCard_' + actionId);
    if (targetCard) {
      targetCard.setAttribute('data-optimistic', 'true');
      targetCard.style.borderColor = 'var(--accent-emerald-border)';
      const buttons = targetCard.querySelectorAll('button');
      buttons.forEach((b) => { b.disabled = true; });
    }

    try {
      const resp = await apiFetch('/actions/' + encodeURIComponent(actionId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (!resp.ok) throw new Error('Update failed: ' + resp.status);
      if (targetCard) {
        targetCard.removeAttribute('data-optimistic');
        targetCard.style.borderColor = '';
      }

      showUndoToast('Action marked as ' + status, async () => {
        const revertResp = await apiFetch('/actions/' + encodeURIComponent(actionId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: previousStatus })
        });
        if (revertResp.ok) {
          showToast('Restored action to ' + previousStatus, 'emerald', 2500);
          loadShortActions();
          fetchStats();
        }
      });

      loadShortActions();
      fetchStats();
    } catch (err) {
      // Rollback optimistic change on server error
      if (targetCard) {
        targetCard.removeAttribute('data-optimistic');
        targetCard.style.borderColor = '';
        const buttons = targetCard.querySelectorAll('button');
        buttons.forEach((b) => { b.disabled = false; });
        const doneBtn = targetCard.querySelector('[data-action-btn="done"]');
        const dismissBtn = targetCard.querySelector('[data-action-btn="dismissed"]');
        if (doneBtn) swapIconWithBlur(doneBtn, 'Done', 'check');
        if (dismissBtn) swapIconWithBlur(dismissBtn, 'Dismiss', 'close');
      }
      showToast('Failed to update action: ' + err.message, 'rose');
    }
  }

  // =========================================================================
  // Knowledge Graph Tab (SVG Renderer + Side Inspector)
  // =========================================================================
  const GRAPH_TYPE_COLORS = {
    note: '#10B981',
    lesson: '#F59E0B',
    concept: '#047857',
    file: '#9CA3AF',
    session: '#F3F4F6',
    action: '#FB7185',
    summary: '#10B981'
  };

  let savedGraphInspectorEmpty = null;

  function initGraphTab() {
    const inspector = document.getElementById('graphInspectorContainer');
    const emptyEl = inspector ? inspector.querySelector('.graph-inspector-empty') : null;
    if (emptyEl) {
      savedGraphInspectorEmpty = emptyEl.cloneNode(true);
    }

    const graphWrapper = document.getElementById('graphProjectDropdownWrapper');
    const graphInput = document.getElementById('graphFilterProject');
    if (graphWrapper && graphInput) {
      attachSearchableProjectDropdown(graphWrapper, graphInput, {
        includeAllOption: true,
        allOptionLabel: 'All Projects',
        onSelect: () => loadGraph(),
        onEnter: () => loadGraph()
      });
    }

    const btnLoad = document.getElementById('btnLoadGraph');
    if (btnLoad) btnLoad.addEventListener('click', loadGraph);
    const scopeSel = document.getElementById('graphFilterScope');
    if (scopeSel) scopeSel.addEventListener('change', loadGraph);
    const limitSel = document.getElementById('graphFilterLimit');
    if (limitSel) limitSel.addEventListener('change', loadGraph);
  }

  function renderGraphSnapshot(data, isUpdating = false) {
    const statsBadge = document.getElementById('graphStatsBadge');
    graphData = data;
    selectedGraphNodeId = null;

    const nodes = Array.isArray(graphData.nodes) ? graphData.nodes : [];
    const edges = Array.isArray(graphData.edges) ? graphData.edges : [];
    if (statsBadge) {
      statsBadge.textContent = nodes.length + ' nodes · ' + edges.length + ' edges' + (isUpdating ? ' (updating)' : '');
    }

    renderGraphLegend();
    renderGraphSvg(nodes, edges);

    const inspector = document.getElementById('graphInspectorContainer');
    if (inspector) {
      if (savedGraphInspectorEmpty) {
        inspector.replaceChildren(savedGraphInspectorEmpty.cloneNode(true));
      } else if (!inspector.querySelector('.graph-inspector-empty')) {
        inspector.replaceChildren(
          el('div', { className: 'text-muted' }, 'Click any node in the graph to inspect its metadata, provenance, and connections.')
        );
      }
      initBlurHashPlaceholders();
    }
  }

  async function loadGraph() {
    const canvasWrap = document.getElementById('graphCanvasContainer');
    if (!canvasWrap) return;

    const projInput = document.getElementById('graphFilterProject');
    const scopeSel = document.getElementById('graphFilterScope');
    const limitSel = document.getElementById('graphFilterLimit');

    let projVal = projInput ? projInput.value.trim() : '';
    if (projVal.toLowerCase() === 'all projects') projVal = '';

    const params = new URLSearchParams();
    if (projVal) params.set('project_id', projVal);
    if (scopeSel && scopeSel.value) params.set('scope', scopeSel.value);
    if (limitSel && limitSel.value) params.set('limit', limitSel.value);

    const cacheKey = params.toString() || 'default';
    const cachedGraph = swrCache.graph.get(cacheKey) || (cacheKey === 'limit=80' ? swrCache.graph.get('default') : null);
    if (cachedGraph) {
      renderGraphSnapshot(cachedGraph, true);
    } else {
      canvasWrap.replaceChildren(
        createSkeletonLoader('list', 3, 'Loading knowledge graph...')
      );
    }

    try {
      const resp = await apiFetch('/dashboard/api/graph?' + params.toString());
      if (!resp.ok) throw new Error('Graph request failed: ' + resp.status);
      const freshGraph = await resp.json();
      swrCache.graph.set(cacheKey, freshGraph);
      if (cacheKey === 'limit=80') swrCache.graph.set('default', freshGraph);
      renderGraphSnapshot(freshGraph, false);
    } catch (err) {
      if (!cachedGraph) {
        canvasWrap.replaceChildren(
          el('div', { className: 'toast toast-rose', style: { position: 'static' } },
            el('span', {}, 'Error loading graph: ' + err.message)
          )
        );
      }
    }
  }

  function renderGraphLegend() {
    const legend = document.getElementById('graphLegend');
    if (!legend) return;
    legend.replaceChildren();
    Object.entries(GRAPH_TYPE_COLORS).forEach(([type, color]) => {
      legend.appendChild(
        el('div', { className: 'graph-legend-item' },
          el('span', { className: 'graph-legend-swatch', style: { backgroundColor: color } }),
          el('span', {}, type)
        )
      );
    });
  }

  function computeGraphPositions(nodes, edges, width, height) {
    const cx = width / 2;
    const cy = height / 2;
    const typeOrder = ['session', 'summary', 'note', 'lesson', 'action', 'concept', 'file'];
    const buckets = new Map();
    typeOrder.forEach((t) => buckets.set(t, []));
    nodes.forEach((n) => {
      const t = buckets.has(n.type) ? n.type : 'note';
      buckets.get(t).push(n);
    });

    const pos = new Map();
    const ringRadii = {
      session: 70,
      summary: 120,
      note: 175,
      lesson: 175,
      action: 215,
      concept: 240,
      file: 255
    };

    typeOrder.forEach((type, typeIdx) => {
      const group = buckets.get(type) || [];
      const radius = ringRadii[type] || 180;
      group.forEach((node, idx) => {
        const angle = ((idx / Math.max(1, group.length)) * Math.PI * 2) + (typeIdx * 0.45);
        pos.set(node.id, {
          x: cx + Math.cos(angle) * radius * (width / height * 0.72),
          y: cy + Math.sin(angle) * radius * 0.85
        });
      });
    });

    // Light deterministic repulsion + edge attraction so nodes stay well-separated
    for (let iter = 0; iter < 30; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const p1 = pos.get(nodes[i].id);
          const p2 = pos.get(nodes[j].id);
          const dx = p2.x - p1.x;
          const dy = p2.y - p1.y;
          const distSq = dx * dx + dy * dy + 0.01;
          if (distSq < 2600) {
            const dist = Math.sqrt(distSq);
            const push = (52 - dist) * 0.25;
            const ux = dx / dist;
            const uy = dy / dist;
            p1.x -= ux * push;
            p1.y -= uy * push;
            p2.x += ux * push;
            p2.y += uy * push;
          }
        }
      }
      edges.forEach((e) => {
        const p1 = pos.get(e.source);
        const p2 = pos.get(e.target);
        if (!p1 || !p2) return;
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        p1.x += dx * 0.03;
        p1.y += dy * 0.03;
        p2.x -= dx * 0.03;
        p2.y -= dy * 0.03;
      });
      nodes.forEach((n) => {
        const p = pos.get(n.id);
        p.x = Math.max(48, Math.min(width - 48, p.x));
        p.y = Math.max(36, Math.min(height - 36, p.y));
      });
    }

    return pos;
  }

  function renderGraphSvg(nodes, edges) {
    const canvasWrap = document.getElementById('graphCanvasContainer');
    if (!canvasWrap) return;
    canvasWrap.replaceChildren();

    if (nodes.length === 0) {
      canvasWrap.appendChild(
        el('div', { className: 'text-muted', style: { padding: '24px' } }, 'No graph nodes found for the selected filters.')
      );
      return;
    }

    const width = 960;
    const height = 560;
    const positions = computeGraphPositions(nodes, edges, width, height);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('class', 'graph-svg');

    // Edges layer
    const edgesGroup = document.createElementNS(SVG_NS, 'g');
    edges.forEach((edge) => {
      const p1 = positions.get(edge.source);
      const p2 = positions.get(edge.target);
      if (!p1 || !p2) return;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(Math.round(p1.x)));
      line.setAttribute('y1', String(Math.round(p1.y)));
      line.setAttribute('x2', String(Math.round(p2.x)));
      line.setAttribute('y2', String(Math.round(p2.y)));
      line.setAttribute('stroke', 'var(--border-subtle)');
      line.setAttribute('stroke-width', '1.4');
      line.setAttribute('stroke-opacity', '0.75');
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = edge.type + ': ' + edge.source + ' -> ' + edge.target;
      line.appendChild(title);
      edgesGroup.appendChild(line);
    });
    svg.appendChild(edgesGroup);

    // Nodes layer
    const nodesGroup = document.createElementNS(SVG_NS, 'g');
    nodes.forEach((node) => {
      const p = positions.get(node.id);
      if (!p) return;
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'graph-node' + (selectedGraphNodeId === node.id ? ' selected' : ''));
      g.setAttribute('data-node-id', node.id);
      g.setAttribute('role', 'button');
      g.setAttribute('tabindex', '0');
      g.setAttribute('aria-label', '[' + node.type + '] ' + (node.label || node.id));

      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(Math.round(p.x)));
      circle.setAttribute('cy', String(Math.round(p.y)));
      circle.setAttribute('r', node.type === 'session' || node.type === 'summary' ? '12' : '9');
      circle.setAttribute('fill', GRAPH_TYPE_COLORS[node.type] || '#9CA3AF');
      circle.setAttribute('stroke', 'var(--bg-base)');
      circle.setAttribute('stroke-width', '1.5');

      const labelText = (node.label || node.id || '').slice(0, 18);
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', String(Math.round(p.x)));
      text.setAttribute('y', String(Math.round(p.y + 20)));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('class', 'graph-node-label');
      text.textContent = labelText;

      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = '[' + node.type + '] ' + (node.label || node.id);

      g.appendChild(circle);
      g.appendChild(text);
      g.appendChild(title);
      g.addEventListener('click', () => selectGraphNode(node.id));
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectGraphNode(node.id);
        }
      });
      nodesGroup.appendChild(g);
    });
    svg.appendChild(nodesGroup);

    canvasWrap.appendChild(svg);
  }

  function selectGraphNode(nodeId) {
    selectedGraphNodeId = nodeId;
    document.querySelectorAll('#graphCanvasContainer .graph-node').forEach((g) => {
      if (g.getAttribute('data-node-id') === nodeId) {
        g.classList.add('selected');
      } else {
        g.classList.remove('selected');
      }
    });

    if (!graphData || !Array.isArray(graphData.nodes)) return;
    const node = graphData.nodes.find((n) => n.id === nodeId);
    if (node) {
      renderGraphInspector(node);
    }
  }

  function renderGraphInspector(node) {
    const inspector = document.getElementById('graphInspectorContainer');
    if (!inspector) return;
    inspector.replaceChildren();

    const nodesById = new Map();
    (graphData && graphData.nodes ? graphData.nodes : []).forEach((n) => nodesById.set(n.id, n));
    const edges = (graphData && graphData.edges ? graphData.edges : []);

    const nodeTypeVariant = (node.type === 'note' || node.type === 'summary')
      ? 'emerald'
      : (node.type === 'lesson' ? 'amber' : (node.type === 'action' ? 'rose' : 'subtle'));

    inspector.appendChild(
      el('div', { className: 'control-row mb-4', style: { flexWrap: 'wrap' } },
        createBadge((node.type || 'node').toUpperCase(), nodeTypeVariant, true),
        node.scope ? createBadge(node.scope, node.scope === 'project' ? 'emerald' : (node.scope === 'unknown' ? 'rose' : 'subtle'), true) : null,
        node.project_id ? createBadge(node.project_id, 'subtle', true) : null
      )
    );

    inspector.appendChild(el('h3', { style: { fontSize: '16px', marginBottom: '8px', wordBreak: 'break-word' } }, node.label || node.id));
    inspector.appendChild(createProvenanceLine(
      'node: ' + (node.type || 'record') + ' · id: ' + node.id +
      (node.meta && node.meta.created_at ? ' · ' + formatTimestamp(node.meta.created_at) : '')
    ));

    if (node.meta && typeof node.meta === 'object' && Object.keys(node.meta).length > 0) {
      const metaBox = el('div', { className: 'result-card', style: { marginBottom: '12px', padding: '10px' } });
      Object.entries(node.meta).forEach(([k, v]) => {
        if (v === null || v === undefined) return;
        metaBox.appendChild(
          el('div', { style: { fontSize: '12px', marginBottom: '4px' } },
            el('span', { className: 'text-muted text-mono' }, k + ': '),
            el('span', {}, typeof v === 'object' ? JSON.stringify(v) : String(v))
          )
        );
      });
      inspector.appendChild(metaBox);
    }

    const connected = edges.filter((e) => e.source === node.id || e.target === node.id);
    inspector.appendChild(
      el('div', { className: 'form-label-inline', style: { marginBottom: '8px' } }, 'CONNECTIONS (' + connected.length + ')')
    );

    if (connected.length === 0) {
      inspector.appendChild(el('div', { className: 'text-muted', style: { fontSize: '12px' } }, 'No connected edges in current view.'));
      return;
    }

    connected.forEach((edge) => {
      const isOutgoing = edge.source === node.id;
      const otherId = isOutgoing ? edge.target : edge.source;
      const otherNode = nodesById.get(otherId);
      const otherLabel = otherNode ? ('[' + otherNode.type + '] ' + (otherNode.label || otherId)) : otherId;

      inspector.appendChild(
        el('button', {
          type: 'button',
          className: 'graph-edge-link',
          onClick: () => selectGraphNode(otherId)
        },
          el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            (isOutgoing ? '→ ' : '← ') + otherLabel
          ),
          el('span', { className: 'text-muted text-mono', style: { fontSize: '12px', flexShrink: '0' } }, edge.type)
        )
      );
    });
    initBlurHashPlaceholders();
  }

  // =========================================================================
  // Command Menu Palette (⌘K), Shortcut Hints, OTP Autofill, Predictive Back & BlurHash
  // =========================================================================
  let commandMenuActiveIndex = 0;

  function getCommandMenuActions() {
    return [
      {
        id: 'deploy-production',
        label: 'Deploy to production',
        keywords: 'dep deploy production release index reembed',
        shortcut: '⌘D',
        run: async () => {
          showToast('Checking production store readiness & triggering re-embed verification...', 'emerald', 3500);
          await fetchStats();
        }
      },
      {
        id: 'drain-embed',
        label: 'Drain Embed Queue',
        keywords: 'drain embed queue qdrant vectors',
        shortcut: '⌘E',
        run: () => {
          const btn = document.getElementById('btnDrainEmbed');
          if (btn) btn.click();
        }
      },
      {
        id: 'refresh-stats',
        label: 'Refresh Telemetry Data',
        keywords: 'refresh reload stats telemetry',
        shortcut: '⌘R',
        run: () => {
          const btn = document.getElementById('btnRefresh');
          if (btn) btn.click();
        }
      },
      {
        id: 'run-cleanup',
        label: 'Run Retention Cleanup',
        keywords: 'cleanup retention archive purge',
        shortcut: '⌘⇧C',
        run: () => {
          const btn = document.getElementById('btnCleanup');
          if (btn) btn.click();
        }
      },
      {
        id: 'create-note',
        label: 'Create Long-Term Note',
        keywords: 'create note memory lesson',
        shortcut: '⌘N',
        run: () => openCreateNoteModal()
      },
      {
        id: 'capture-event',
        label: 'Capture Telemetry Event',
        keywords: 'capture observation trajectory event',
        shortcut: '⌘T',
        run: () => openCaptureModal('observation')
      },
      {
        id: 'run-conformance',
        label: 'Run AI Conformance Fixtures',
        keywords: 'conformance doctor diagnostics ai fixtures',
        shortcut: '⌘F',
        run: () => {
          switchTab('conformance');
          runConformanceDiagnostics();
        }
      },
      {
        id: 'tab-overview',
        label: 'Go to Overview',
        keywords: 'tab overview home kpi',
        shortcut: '⌘1',
        run: () => switchTab('overview')
      },
      {
        id: 'tab-notes',
        label: 'Go to Long Term Notes',
        keywords: 'tab notes long term repair',
        shortcut: '⌘2',
        run: () => switchTab('notes')
      },
      {
        id: 'tab-short-term',
        label: 'Go to Short Term Sessions & Actions',
        keywords: 'tab short term sessions actions',
        shortcut: '⌘3',
        run: () => switchTab('shortTerm')
      },
      {
        id: 'tab-trajectories',
        label: 'Go to Observations & Trajectories',
        keywords: 'tab observations trajectories summaries',
        shortcut: '⌘4',
        run: () => switchTab('trajectories')
      },
      {
        id: 'tab-graph',
        label: 'Go to Knowledge Graph',
        keywords: 'tab graph topology nodes',
        shortcut: '⌘5',
        run: () => switchTab('graph')
      },
      {
        id: 'tab-search',
        label: 'Go to Search & Inject',
        keywords: 'tab search inject rrf bm25',
        shortcut: '⌘6',
        run: () => switchTab('search')
      },
      {
        id: 'tab-conformance',
        label: 'Go to System & AI',
        keywords: 'tab system ai failure patterns dead letters',
        shortcut: '⌘7',
        run: () => switchTab('conformance')
      }
    ];
  }

  function renderCommandMenuItems(query = '') {
    const listEl = document.getElementById('commandMenuList');
    const inputEl = document.getElementById('commandMenuInput');
    if (!listEl) return;

    const norm = query.trim().toLowerCase();
    const actions = getCommandMenuActions().filter((item) => {
      if (!norm) return true;
      return item.label.toLowerCase().includes(norm) || item.keywords.toLowerCase().includes(norm);
    });

    listEl.replaceChildren();
    if (actions.length === 0) {
      if (inputEl) inputEl.removeAttribute('aria-activedescendant');
      listEl.appendChild(el('div', { className: 'dropdown-empty' }, 'No matching commands'));
      return [];
    }

    if (commandMenuActiveIndex >= actions.length) commandMenuActiveIndex = 0;
    if (commandMenuActiveIndex < 0) commandMenuActiveIndex = actions.length - 1;

    actions.forEach((item, idx) => {
      const isActive = idx === commandMenuActiveIndex;
      const optId = 'cmdOpt_' + item.id;
      const btn = el('button', {
        id: optId,
        type: 'button',
        role: 'option',
        'aria-selected': isActive ? 'true' : 'false',
        className: 'command-menu-item' + (isActive ? ' active' : ''),
        onClick: async () => {
          closeCommandMenu();
          await item.run();
        }
      },
        el('span', { textContent: item.label }),
        el('kbd', { className: 'shortcut-hint', textContent: item.shortcut })
      );
      listEl.appendChild(btn);
      if (isActive && inputEl) {
        inputEl.setAttribute('aria-activedescendant', optId);
      }
    });
    return actions;
  }

  function openCommandMenu() {
    const overlay = document.getElementById('commandMenuOverlay');
    const input = document.getElementById('commandMenuInput');
    if (!overlay || !input) return;
    if (!overlay.classList.contains('open')) {
      lastFocusedBeforeCommandMenu = document.activeElement;
    }
    commandMenuActiveIndex = 0;
    overlay.classList.add('open');
    overlay.removeAttribute('aria-hidden');
    input.value = '';
    renderCommandMenuItems('');
    input.focus();
  }

  function closeCommandMenu() {
    const overlay = document.getElementById('commandMenuOverlay');
    if (overlay) {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
    }
    const toRestore = lastFocusedBeforeCommandMenu;
    lastFocusedBeforeCommandMenu = null;
    if (toRestore && document.contains(toRestore) && typeof toRestore.focus === 'function') {
      toRestore.focus();
    }
  }

  function initCommandMenu() {
    const btnOpen = document.getElementById('btnCommandMenu');
    const overlay = document.getElementById('commandMenuOverlay');
    const input = document.getElementById('commandMenuInput');

    if (btnOpen) {
      btnOpen.addEventListener('click', openCommandMenu);
    }

    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeCommandMenu();
      });
    }

    if (input) {
      input.addEventListener('input', () => {
        commandMenuActiveIndex = 0;
        renderCommandMenuItems(input.value);
      });

      input.addEventListener('keydown', async (e) => {
        const currentActions = renderCommandMenuItems(input.value);
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeCommandMenu();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          commandMenuActiveIndex++;
          renderCommandMenuItems(input.value);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          commandMenuActiveIndex--;
          renderCommandMenuItems(input.value);
        } else if (e.key === 'Enter' && currentActions.length > 0) {
          e.preventDefault();
          const chosen = currentActions[commandMenuActiveIndex] || currentActions[0];
          closeCommandMenu();
          if (chosen) await chosen.run();
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      const modalEl = document.getElementById('modalContainer');
      const isCmdOpen = overlay && overlay.classList.contains('open');
      const isModalOpen = modalEl && modalEl.classList.contains('open');

      if (e.key === 'Escape') {
        if (isCmdOpen) {
          e.preventDefault();
          closeCommandMenu();
          return;
        }
        if (isModalOpen) {
          e.preventDefault();
          closeModal();
          return;
        }
      }

      if (e.key === 'Tab') {
        if (isCmdOpen) {
          trapDialogFocus(e, overlay);
          return;
        }
        if (isModalOpen) {
          trapDialogFocus(e, modalEl);
          return;
        }
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (isCmdOpen) {
          closeCommandMenu();
        } else {
          openCommandMenu();
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '7') {
        const tabKeys = ['overview', 'notes', 'shortTerm', 'trajectories', 'graph', 'search', 'conformance'];
        const targetTab = tabKeys[Number(e.key) - 1];
        if (targetTab) {
          e.preventDefault();
          switchTab(targetTab);
        }
      }
    });
  }

  // Predictive Back Gesture Preview (Android/Touch edge swipe + popstate)
  function initPredictiveBack() {
    const preview = document.getElementById('predictiveBackPreview');
    let edgeSwipeStartX = null;
    let edgeSwipeDeltaX = 0;

    window.addEventListener('popstate', (e) => {
      const targetTab = (e.state && e.state.tab) || (tabHistoryStack.length > 1 ? tabHistoryStack[tabHistoryStack.length - 2] : 'overview');
      if (targetTab && targetTab !== activeTab) {
        if (tabHistoryStack.length > 1) tabHistoryStack.pop();
        switchTab(targetTab, false);
      }
    });

    document.addEventListener('touchstart', (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      const touch = e.touches[0];
      if (touch.clientX <= 36 && tabHistoryStack.length > 1) {
        edgeSwipeStartX = touch.clientX;
        edgeSwipeDeltaX = 0;
      } else {
        edgeSwipeStartX = null;
      }
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (edgeSwipeStartX === null || !preview || !e.touches || e.touches.length !== 1) return;
      edgeSwipeDeltaX = Math.max(0, e.touches[0].clientX - edgeSwipeStartX);
      if (edgeSwipeDeltaX > 12) {
        const prevKey = tabHistoryStack[tabHistoryStack.length - 2] || 'overview';
        const prevLabel = tabDisplayNames[prevKey] || prevKey;
        preview.replaceChildren(
          el('div', { className: 'card-subtitle' }, '← Predictive Back'),
          el('div', { className: 'card-title' }, prevLabel)
        );
        preview.classList.add('visible');
        preview.style.transform = 'translateY(-50%) translateX(' + Math.min(0, -120 + edgeSwipeDeltaX) + 'px)';
      }
    }, { passive: true });

    const finishSwipe = () => {
      if (edgeSwipeStartX === null) return;
      if (preview) {
        preview.classList.remove('visible');
        preview.style.transform = '';
      }
      if (edgeSwipeDeltaX > 90 && tabHistoryStack.length > 1) {
        tabHistoryStack.pop();
        const prevKey = tabHistoryStack[tabHistoryStack.length - 1] || 'overview';
        switchTab(prevKey, false);
      }
      edgeSwipeStartX = null;
      edgeSwipeDeltaX = 0;
    };

    document.addEventListener('touchend', finishSwipe, { passive: true });
    document.addEventListener('touchcancel', finishSwipe, { passive: true });
  }

  // One-Time Code (OTP) SMS Autofill Helper
  function initOtpAutofill(targetContainer) {
    const container = targetContainer || document.getElementById('otpVerifyContainer');
    if (!container) return;
    if (container.getAttribute('data-otp-bound') === 'true') return;
    container.setAttribute('data-otp-bound', 'true');

    const inputs = Array.from(container.querySelectorAll('.otp-digit-input'));
    const primary = container.querySelector('#otpPrimaryInput') || inputs[0];
    if (!primary || inputs.length === 0) return;

    const distributeCode = (raw) => {
      const digits = String(raw || '').replace(/\\D/g, '').slice(0, inputs.length);
      if (!digits) return;
      inputs.forEach((inp, idx) => {
        inp.value = digits[idx] || '';
      });
      if (digits.length === inputs.length) {
        showToast('Verification OTP code autofilled (' + digits.length + ' digits)', 'emerald', 2500);
      } else if (inputs[digits.length]) {
        inputs[digits.length].focus();
      }
    };

    primary.addEventListener('input', () => {
      if (primary.value.length > 1) {
        distributeCode(primary.value);
      } else if (primary.value.length === 1 && inputs[1]) {
        inputs[1].focus();
      }
    });

    inputs.forEach((inp, idx) => {
      inp.addEventListener('paste', (e) => {
        const text = e.clipboardData ? e.clipboardData.getData('text') : '';
        if (text) {
          e.preventDefault();
          distributeCode(text);
        }
      });
      inp.addEventListener('input', () => {
        const clean = inp.value.replace(/\\D/g, '');
        if (clean.length > 1) {
          distributeCode(clean);
          return;
        }
        inp.value = clean;
        if (clean && inputs[idx + 1]) {
          inputs[idx + 1].focus();
        }
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !inp.value && idx > 0) {
          inputs[idx - 1].focus();
        }
      });
    });
  }

  // BlurHash Placeholder Resolution
  function initBlurHashPlaceholders() {
    document.querySelectorAll('.carousel-card-media, #graphInspectorContainer').forEach((media) => {
      const placeholders = media.querySelectorAll('.blurhash-placeholder');
      placeholders.forEach((placeholder) => {
        const img = (placeholder.parentElement && placeholder.parentElement.querySelector('img')) || media.querySelector('img');
        if (img) {
          if (img.complete) {
            placeholder.classList.add('loaded');
          } else {
            img.addEventListener('load', () => placeholder.classList.add('loaded'), { once: true });
            img.addEventListener('error', () => placeholder.classList.add('loaded'), { once: true });
          }
        } else if (media.id === 'graphInspectorContainer') {
          placeholder.classList.add('loaded');
        }
      });
    });
  }

  // App Initialization
  document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initSearchWorkbench();
    initNotesTab();
    initShortTermTab();
    initGraphTab();
    initConformanceTab();
    initActionButtons();
    initCommandMenu();
    initPredictiveBack();
    initOtpAutofill();
    initBlurHashPlaceholders();

    // Track cursor coordinates for Amazon Safe Triangle submenu protection
    document.addEventListener('mousemove', (e) => {
      prevMousePoint = currMousePoint;
      currMousePoint = { x: e.clientX, y: e.clientY };
    }, { passive: true });

    const modalContainerEl = document.getElementById('modalContainer');
    if (modalContainerEl) {
      modalContainerEl.addEventListener('click', (e) => {
        if (e.target === modalContainerEl) {
          closeModal();
        }
      });
    }

    const apiKeyInput = document.getElementById('inputDashboardApiKey');
    if (apiKeyInput) {
      const handleKeyUpdate = async () => {
        const val = apiKeyInput.value.trim();
        if (val) {
          try {
            const resp = await apiFetch('/dashboard/api/session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: val })
            });
            if (resp.ok) {
              const data = await resp.json();
              inMemoryApiKey = val;
              isSessionAuthenticated = true;
              sessionKeyName = data.name || 'Active';
              isBootstrapRequired = false;
              apiKeyInput.value = '';
              updateAuthStatusUI();
              showToast('Authenticated as ' + sessionKeyName + '.', 'emerald', 3000);
              fetchStats();
              refreshActiveTab();
            } else {
              showToast('Invalid or expired API key', 'rose', 3500);
            }
          } catch (err) {
            showToast('Authentication error: ' + err.message, 'rose', 3500);
          }
        }
      };

      const apiKeyForm = document.getElementById('formDashboardApiKey');
      if (apiKeyForm) {
        apiKeyForm.addEventListener('submit', (e) => {
          e.preventDefault();
          handleKeyUpdate();
        });
      }

      apiKeyInput.addEventListener('input', (e) => {
        const val = (e.target && e.target.value) ? e.target.value.trim() : '';
        if (val && val !== inMemoryApiKey) {
          inMemoryApiKey = val;
        }
      });
      apiKeyInput.addEventListener('change', handleKeyUpdate);
      apiKeyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          handleKeyUpdate();
        }
      });
    }

    checkAuthStatus();
    fetchStats();

    // Idle pre-rendering of likely next tabs
    setTimeout(() => {
      prerenderTab('notes');
      prerenderTab('shortTerm');
    }, 1200);

    // Auto-refresh stats every 30 seconds (chained setTimeout prevents overlapping requests)
    const scheduleStatsRefresh = () => {
      setTimeout(async () => {
        try {
          await fetchStats();
        } finally {
          scheduleStatsRefresh();
        }
      }, 30000);
    };
    scheduleStatsRefresh();

    // Global click listener to close open dropdowns when clicking outside
    document.addEventListener('click', (e) => {
      document.querySelectorAll('.searchable-dropdown.open').forEach((w) => {
        if (!w.contains(e.target)) {
          w.classList.remove('open');
          const m = w.querySelector('.dropdown-menu');
          if (m) m.classList.remove('open');
          const inp = w.querySelector('input');
          if (inp) inp.setAttribute('aria-expanded', 'false');
          const chv = w.querySelector('.dropdown-chevron');
          if (chv) chv.setAttribute('aria-expanded', 'false');
        }
      });
    });
  });
})();
`;
