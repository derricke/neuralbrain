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

  // In-memory authentication state (zero localStorage per SecureCoder rules)
  let inMemoryApiKey = '';
  let isBootstrapRequired = false;
  let isSessionAuthenticated = false;
  let sessionKeyName = '';

  async function apiFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (inMemoryApiKey && !headers.has('Authorization')) {
      headers.set('Authorization', 'Bearer ' + inMemoryApiKey);
    }
    if (!headers.has('X-Requested-With')) {
      headers.set('X-Requested-With', 'XMLHttpRequest');
    }
    const resp = await fetch(url, { credentials: 'same-origin', ...options, headers });
    if (resp.status === 401 && !url.includes('/dashboard/api/session')) {
      isSessionAuthenticated = false;
      updateAuthStatusUI();
    }
    return resp;
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
        btnGenApiKey.textContent = '+ Claim First API Key';
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
        btnGenApiKey.textContent = '+ Generate API Key';
        btnGenApiKey.className = 'btn btn-emerald';
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
        btnSubmit.textContent = 'Apply';
      }
      if (btnGenApiKey) {
        btnGenApiKey.textContent = '+ Generate API Key';
        btnGenApiKey.className = 'btn btn-emerald';
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

  // Safe Badge Helper
  function createBadge(text, variant = 'subtle', isMono = false) {
    const b = el('span', { className: 'badge badge-' + variant + (isMono ? ' badge-mono' : '') },
      el('span', { className: 'badge-dot' }),
      text
    );
    return b;
  }

  // Toast Notification System (replaces native alert/confirm)
  function showToast(message, variant = 'emerald', durationMs = 4500) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = el('div', { className: 'toast toast-' + variant });
    const textSpan = el('span', { textContent: message });
    const closeBtn = el('button', {
      className: 'toast-close-btn',
      title: 'Dismiss',
      onClick: () => toast.remove()
    }, '×');

    toast.appendChild(textSpan);
    toast.appendChild(closeBtn);
    container.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement) {
        toast.remove();
      }
    }, durationMs);
  }

  // Modal Dialog System (replaces native alert/confirm/prompt)
  function showModal(title, bodyNodes, footerButtons = []) {
    const container = document.getElementById('modalContainer');
    if (!container) return;

    container.replaceChildren();

    const dialog = el('div', { className: 'modal-dialog' });

    // Header
    const header = el('div', { className: 'modal-header' },
      el('h3', { className: 'modal-title', textContent: title }),
      el('button', {
        className: 'btn',
        style: { height: '32px', width: '32px', padding: '0' },
        onClick: closeModal
      }, '✕')
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
    const defaultCancel = el('button', { className: 'btn', onClick: closeModal }, 'Cancel');
    footer.appendChild(defaultCancel);

    for (const btnDef of footerButtons) {
      const btn = el('button', {
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

    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(footer);

    container.appendChild(dialog);
    container.classList.add('open');
    container.style.display = 'flex';
  }

  function closeModal() {
    const container = document.getElementById('modalContainer');
    if (container) {
      container.classList.remove('open');
      container.style.display = 'none';
      container.replaceChildren();
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
      if (/^\d+(\.\d+)?$/.test(trimmed)) {
        d = new Date(Number(trimmed) * 1000);
      } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(trimmed)) {
        const normalized = trimmed.replace(' ', 'T');
        d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : normalized + 'Z');
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

  // Tab Navigation Handling
  function initTabs() {
    const tabButtons = document.querySelectorAll('.nav-tab-btn');
    tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tabKey = btn.getAttribute('data-tab');
        if (!tabKey) return;
        switchTab(tabKey);
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

  function switchTab(tabKey) {
    activeTab = tabKey;
    document.querySelectorAll('.nav-tab-btn').forEach((btn) => {
      if (btn.getAttribute('data-tab') === tabKey) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    document.querySelectorAll('.tab-pane').forEach((pane) => {
      pane.classList.remove('active');
    });

    const targetPane = document.getElementById('pane' + tabKey.charAt(0).toUpperCase() + tabKey.slice(1));
    if (targetPane) {
      targetPane.classList.add('active');
    }

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
      if (btn.getAttribute('data-subtab') === subTabKey) {
        btn.className = 'btn btn-primary';
      } else {
        btn.className = 'btn';
      }
    });
    renderTrajectoriesSubView(highlightId);
  }

  // Fetch Full Dashboard Stats Snapshot
  let isFetchingStats = false;
  async function fetchStats() {
    if (isFetchingStats) return;
    isFetchingStats = true;
    try {
      const resp = await apiFetch('/dashboard/api/stats');
      if (resp.status === 401) {
        isSessionAuthenticated = false;
        updateAuthStatusUI();
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
      syncKnownProjects();
      syncTaskTypes();
      renderHeaderAndOverview();
    } catch (err) {
      showToast('Error fetching dashboard stats: ' + err.message, 'rose');
    } finally {
      isFetchingStats = false;
    }
  }

  // Render Header & Tab 1 Overview
  function renderHeaderAndOverview() {
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
        healthText.textContent = 'HEALTH: OK';
      } else {
        healthBadge.className = 'badge badge-rose';
        healthText.textContent = 'HEALTH: DEGRADED';
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
        storeMetaBadge.className = 'badge badge-cyan badge-mono';
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

    // 3. Tab Badge for Repair Queue
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
          el('span', { className: 'badge ' + (activeSessions > 0 ? 'badge-emerald' : 'badge-subtle') + ' badge-mono' }, activeSessions + ' active sessions'),
          el('span', { className: 'badge ' + (readyActions > 0 ? 'badge-amber' : 'badge-subtle') + ' badge-mono' }, readyActions + ' ready next actions')
        ]
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
          el('span', { className: 'badge badge-cyan badge-mono' }, memoriesCount + ' memories'),
          el('span', { className: 'badge badge-amber badge-mono' }, lessonsCount + ' lessons')
        ]
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
          el('span', { className: 'badge badge-emerald badge-mono' }, notesProject + ' project'),
          el('span', { className: 'badge badge-cyan badge-mono' }, notesGlobal + ' global'),
          el('span', { className: 'badge ' + (notesUnknown > 0 ? 'badge-rose' : 'badge-subtle') + ' badge-mono' }, notesUnknown + ' unknown')
        ]
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
          el('span', { className: 'badge badge-emerald badge-mono' }, trajSuccess + ' success'),
          el('span', { className: 'badge ' + (trajFailed > 0 ? 'badge-rose' : 'badge-subtle') + ' badge-mono' }, trajFailed + ' failed'),
          el('span', { className: 'badge badge-subtle badge-mono' }, trajArchived + ' archived')
        ]
      ));

      // Card 3: Observations
      const obsTotal = counts.observations ? counts.observations.total : 0;
      const obsFailed = counts.observations ? counts.observations.failed : 0;
      const obsArchived = counts.observations ? counts.observations.archived : 0;

      kpiGrid.appendChild(createKpiCard(
        'Observations (Hot-Path)',
        obsTotal,
        [
          el('span', { className: 'badge ' + (obsFailed > 0 ? 'badge-amber' : 'badge-subtle') + ' badge-mono' }, obsFailed + ' failed'),
          el('span', { className: 'badge badge-subtle badge-mono' }, obsArchived + ' archived')
        ]
      ));

      // Card 4: Summaries
      const sumTotal = counts.summaries ? counts.summaries.total : 0;
      const sumVerified = counts.summaries ? counts.summaries.verified : 0;
      const sumExpired = counts.summaries ? counts.summaries.sources_expired : 0;

      kpiGrid.appendChild(createKpiCard(
        'Extractive Summaries',
        sumTotal,
        [
          el('span', { className: 'badge badge-emerald badge-mono' }, sumVerified + ' verified'),
          el('span', { className: 'badge ' + (sumExpired > 0 ? 'badge-amber' : 'badge-subtle') + ' badge-mono' }, sumExpired + ' src expired')
        ]
      ));

      // Card 5: Failure Patterns
      const fpCount = counts.failure_patterns || 0;
      kpiGrid.appendChild(createKpiCard(
        'Failure Patterns',
        fpCount,
        [el('span', { className: 'badge badge-amber badge-mono' }, 'Atomic SQL UPSERT')]
      ));

      // Card 6: Embed Queue
      const eqPending = health.embed_queue_pending || 0;
      const eqStats = health.embed_queue_stats || {};
      const eqBadges = [
        el('span', { className: 'badge ' + (eqPending > 0 ? 'badge-amber' : 'badge-subtle') + ' badge-mono' }, eqPending + ' pending'),
        el('span', { className: 'badge badge-subtle badge-mono' }, (eqStats.done || 0) + ' indexed'),
        el('span', { className: 'badge ' + ((eqStats.failed || 0) > 0 ? 'badge-rose' : 'badge-subtle') + ' badge-mono' }, (eqStats.failed || 0) + ' failed')
      ];
      if (reembedStatus && reembedStatus.status !== 'idle') {
        const total = reembedStatus.total || 0;
        const processed = reembedStatus.processed || 0;
        const badgeCls = reembedStatus.status === 'running'
          ? 'badge-amber'
          : reembedStatus.status === 'completed'
            ? 'badge-emerald'
            : 'badge-rose';
        const label = reembedStatus.status === 'failed'
          ? 'reembed: failed'
          : 'reembed: ' + processed + '/' + total;
        eqBadges.push(el('span', { className: 'badge ' + badgeCls + ' badge-mono' }, label));
      }
      kpiGrid.appendChild(createKpiCard(
        'Embed Queue (Live)',
        eqPending,
        eqBadges
      ));

      // Card 7: Dead Letters
      const dlCount = counts.dead_letters || 0;
      kpiGrid.appendChild(createKpiCard(
        'Dead Letters (Malformed)',
        dlCount,
        [el('span', { className: 'badge ' + (dlCount > 0 ? 'badge-rose' : 'badge-subtle') + ' badge-mono' }, 'Rule 3: 0 volume drops')]
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
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });

      const maxCount = Math.max(...statsData.type_distribution.map((t) => t.count), 1);

      statsData.type_distribution.forEach((item) => {
        const pct = ((item.count / maxCount) * 100).toFixed(0);
        const row = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          el('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '13px' } },
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

      const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px' } },
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
                el('strong', { className: 'text-mono', style: { color: 'var(--accent-cyan)' } }, proj.project_id)
              ),
              el('td', {}, el('span', { className: 'code-pill' }, String(proj.notes_count))),
              el('td', {}, el('span', { className: 'code-pill' }, String(proj.trajectories_count))),
              el('td', {}, el('span', { className: 'code-pill' }, String(proj.observations_count))),
              el('td', {}, el('span', { className: 'badge badge-subtle badge-mono' }, String(totalGrains))),
              el('td', {},
                el('button', {
                  className: 'btn',
                  style: { height: '30px', padding: '0 10px', fontSize: '12px' },
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

  function createKpiCard(label, value, breakdownNodes = []) {
    const card = el('div', { className: 'kpi-card' });
    const top = el('div', { className: 'kpi-top' },
      el('span', { className: 'kpi-label', textContent: label })
    );
    const val = el('div', { className: 'kpi-value', textContent: String(value) });
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
      el('div', { style: { fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' } }, title),
      el('div', { style: { fontSize: '18px', fontWeight: '700', color: '#fff', margin: '4px 0' } }, value),
      el('div', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, sub)
    );
  }

  function getTypeColor(type) {
    switch (type) {
      case 'bug': return 'var(--accent-rose)';
      case 'pattern': return 'var(--accent-cyan)';
      case 'architecture': return 'var(--accent-purple)';
      case 'preference': return 'var(--accent-amber)';
      case 'workflow': return '#3b82f6';
      case 'fact':
      default: return 'var(--accent-emerald)';
    }
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
      chevron = el('span', { className: 'dropdown-chevron', title: 'Toggle project dropdown' }, '▼');
      wrapperEl.appendChild(chevron);
    }

    let menu = wrapperEl.querySelector('.dropdown-menu');
    if (!menu) {
      menu = el('div', { className: 'dropdown-menu' });
      wrapperEl.appendChild(menu);
    }

    const includeAllOption = Boolean(options.includeAllOption);
    const allOptionLabel = options.allOptionLabel || 'All Projects';

    function renderMenu(filterText = '') {
      menu.replaceChildren();
      const currentVal = inputEl.value.trim();
      const normFilter = filterText.trim().toLowerCase();

      // 1. "All Projects" option
      if (includeAllOption) {
        const isAllSelected = !currentVal || currentVal.toLowerCase() === allOptionLabel.toLowerCase() || currentVal.toLowerCase() === 'all projects';
        const allItem = el('div', {
          className: 'dropdown-item' + (isAllSelected ? ' selected' : ''),
          onClick: (e) => {
            e.stopPropagation();
            inputEl.value = '';
            closeDropdown();
            if (options.onSelect) options.onSelect('');
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

        const item = el('div', {
          className: 'dropdown-item' + (isSelected ? ' selected' : ''),
          onClick: (e) => {
            e.stopPropagation();
            inputEl.value = pid;
            closeDropdown();
            if (options.onSelect) options.onSelect(pid);
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
      // Close other open dropdowns first to prevent overlap
      document.querySelectorAll('.searchable-dropdown.open').forEach((w) => {
        if (w !== wrapperEl) {
          w.classList.remove('open');
          const m = w.querySelector('.dropdown-menu');
          if (m) m.classList.remove('open');
          const inp = w.querySelector('input');
          if (inp) inp.setAttribute('aria-expanded', 'false');
        }
      });

      wrapperEl.classList.add('open');
      menu.classList.add('open');
      inputEl.setAttribute('aria-expanded', 'true');
      const val = inputEl.value.trim();
      renderMenu(val.toLowerCase() === 'all projects' || val.toLowerCase() === allOptionLabel.toLowerCase() ? '' : val);
    }

    function closeDropdown() {
      wrapperEl.classList.remove('open');
      menu.classList.remove('open');
      inputEl.setAttribute('aria-expanded', 'false');
    }

    function toggleDropdown() {
      if (wrapperEl.classList.contains('open')) {
        closeDropdown();
      } else {
        openDropdown();
      }
    }

    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropdown();
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
        closeDropdown();
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

    const grains = [];
    if (document.getElementById('grainCheckNote')?.checked) grains.push('note');
    if (document.getElementById('grainCheckTrajectory')?.checked) grains.push('trajectory');
    if (document.getElementById('grainCheckObservation')?.checked) grains.push('observation');
    if (document.getElementById('grainCheckSummary')?.checked) grains.push('summary');

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
      grains: grains.length > 0 ? grains : undefined,
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
        el('div', { className: 'text-muted', style: { padding: '20px', textAlign: 'center' } }, 'Searching brain with RRF fusion...')
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
    const countBadge = createBadge((data.results ? data.results.length : 0) + ' results (' + durationMs + 'ms)', 'cyan', true);

    metaBar.appendChild(modeBadge);
    metaBar.appendChild(countBadge);

    if (data.degraded) {
      const degradedBanner = el('div', {
        className: 'badge badge-rose badge-mono',
        style: { marginLeft: 'auto' }
      }, '⚠️ ' + data.degraded);
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
      const card = el('div', { className: 'result-card' });

      // Header row
      const grainVariant = item.grain === 'note' ? 'cyan' : item.grain === 'summary' ? 'purple' : item.grain === 'trajectory' ? 'emerald' : 'amber';
      const grainBadge = createBadge(item.grain.toUpperCase(), grainVariant, true);

      const rrfScore = typeof item.score === 'number' ? item.score.toFixed(4) : String(item.score || '');
      const scoreSpan = el('span', { className: 'result-score' }, 'RRF Score: ' + rrfScore);

      const header = el('div', { className: 'result-header' },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          el('span', { className: 'code-pill' }, '#' + (index + 1)),
          grainBadge,
          item.scope ? createBadge(item.scope + (item.project_id ? ': ' + item.project_id : ''), 'subtle', true) : null
        ),
        scoreSpan
      );

      // Title & Content
      let titleText = item.title || item.task_type || item.tool_name || item.id;
      let bodyText = item.content || item.description || item.input || item.output || '';

      const titleEl = el('div', { className: 'result-title', textContent: titleText });
      const bodyEl = el('div', { className: 'result-body', textContent: bodyText });

      // Tag list (concepts, files)
      const tagList = el('div', { className: 'tag-list' });
      if (Array.isArray(item.concepts)) {
        item.concepts.forEach((c) => tagList.appendChild(createBadge('#' + c, 'subtle', true)));
      }
      if (Array.isArray(item.files)) {
        item.files.forEach((f) => tagList.appendChild(createBadge('📁 ' + f, 'subtle', true)));
      }
      if (item.file_path) {
        tagList.appendChild(createBadge('📁 ' + item.file_path, 'subtle', true));
      }

      card.appendChild(header);
      card.appendChild(titleEl);
      card.appendChild(bodyEl);
      if (tagList.children.length > 0) {
        card.appendChild(tagList);
      }

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
      el('div', { className: 'text-muted', style: { padding: '20px', textAlign: 'center' } }, 'Simulating task-start injection...')
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
        fontSize: '13px',
        fontWeight: '700',
        color: '#fbbf24',
        marginBottom: '8px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px'
      }
    }, '⚠️ CRITICAL WARNINGS (Learn from past failures in project: ' + proj + ')');

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
      el('div', { style: { fontSize: '13px', fontWeight: '700', marginBottom: '8px' } },
        'Scoped Failure Patterns (' + fpCount + ' patterns with SQL counts)'
      )
    );

    if (fpCount === 0) {
      fpSection.appendChild(el('div', { className: 'text-muted', style: { fontSize: '12px' } }, 'None recorded.'));
    } else {
      data.failure_patterns.forEach((fp) => {
        const item = el('div', { className: 'result-card', style: { padding: '12px' } },
          el('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '6px' } },
            el('span', { className: 'badge badge-rose badge-mono' }, 'COUNT: ' + fp.count + ' occurrences'),
            el('span', { className: 'code-pill' }, 'task_type: ' + fp.task_type)
          ),
          el('div', { className: 'code-block', style: { padding: '8px', fontSize: '11px' }, textContent: fp.error_text })
        );
        fpSection.appendChild(item);
      });
    }
    container.appendChild(fpSection);

    // 3. Relevant Curated Notes
    const notesCount = Array.isArray(data.notes) ? data.notes.length : 0;
    const notesSection = el('div', {},
      el('div', { style: { fontSize: '13px', fontWeight: '700', marginBottom: '8px' } },
        'Relevant Project Knowledge (' + notesCount + ' bug/pattern/preference notes)'
      )
    );

    if (notesCount === 0) {
      notesSection.appendChild(el('div', { className: 'text-muted', style: { fontSize: '12px' } }, 'No relevant notes found for this scope.'));
    } else {
      data.notes.forEach((note) => {
        const noteCard = el('div', { className: 'result-card', style: { padding: '12px' } },
          el('div', { style: { display: 'flex', gap: '8px', marginBottom: '4px' } },
            createBadge(note.type.toUpperCase(), 'amber', true),
            el('strong', { textContent: note.title })
          ),
          el('div', { style: { fontSize: '12px', color: 'var(--text-secondary)' }, textContent: note.content })
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
      btn.className = cat === activeNotesCategory ? 'btn btn-primary' : 'btn';
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

    const listContainer = document.getElementById('notesListContainer');
    if (listContainer) {
      listContainer.replaceChildren(
        el('div', { className: 'text-muted', style: { padding: '24px', textAlign: 'center' } }, 'Loading notes...')
      );
    }

    try {
      const resp = await apiFetch('/notes?' + params.toString());
      if (!resp.ok) throw new Error('Notes query failed: ' + resp.status);
      const notes = await resp.json();
      renderNotesList(notes, scopeSelect ? scopeSelect.value : '');
    } catch (err) {
      if (listContainer) {
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

  function renderNotesList(notes, activeScopeFilter) {
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

    if (activeScopeFilter === 'unknown') {
      const banner = el('div', {
        className: 'warning-banner',
        style: { borderRadius: '8px', marginBottom: '16px', backgroundColor: 'rgba(245, 158, 11, 0.15)', borderColor: 'var(--accent-amber-border)' }
      },
        el('div', { className: 'warning-banner-text' },
          el('span', { style: { fontSize: '18px' } }, '🛠️'),
          el('div', {},
            el('strong', { style: { color: '#fcd34d' } }, 'REPAIR QUEUE (Legacy Unscoped Notes): '),
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

    notes.forEach((note) => {
      const card = el('div', { className: 'result-card', id: 'noteCard_' + note.id });

      // Note Header
      const typeBadge = createBadge(note.type.toUpperCase(), 'amber', true);
      const isUnknown = note.scope === 'unknown';
      const scopeBadge = createBadge(
        isUnknown ? '⚠️ UNKNOWN (NEEDS SCOPE)' : (note.scope + (note.project_id ? ': ' + note.project_id : '')),
        isUnknown ? 'rose' : (note.scope === 'global' ? 'cyan' : 'emerald'),
        true
      );

      // Inline Scope Repair Widget (Hidden by default; consistent control heights: 38px)
      const repairWidget = el('div', {
        className: 'scope-repair-widget hidden'
      });

      // Pencil edit button to toggle scope editing
      const btnEditScope = el('button', {
        className: 'btn-icon-edit',
        title: 'Edit Scope',
        'aria-label': 'Edit Scope',
        onClick: (e) => {
          e.stopPropagation();
          const isHidden = repairWidget.classList.contains('hidden');
          if (isHidden) {
            repairWidget.classList.remove('hidden');
            btnEditScope.classList.add('active');
            if (scopeSelect.value === 'project') {
              projInput.focus();
            }
          } else {
            repairWidget.classList.add('hidden');
            btnEditScope.classList.remove('active');
            projCtrl.close();
          }
        }
      }, '✎');

      const header = el('div', { className: 'result-header' },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          typeBadge,
          scopeBadge,
          btnEditScope,
          el('span', { className: 'code-pill' }, 'v' + note.version),
          el('span', { className: 'text-muted', style: { fontSize: '11px' } }, formatTimestamp(note.created_at))
        ),
        el('span', { className: 'code-pill text-mono' }, note.id)
      );

      // Title & Content
      const titleEl = el('div', { className: 'result-title', textContent: note.title });
      const contentEl = el('div', { className: 'result-body', textContent: note.content });

      // Relations
      const tagList = el('div', { className: 'tag-list', style: { marginBottom: '12px' } });
      if (Array.isArray(note.concepts)) {
        note.concepts.forEach((c) => tagList.appendChild(createBadge('#' + c, 'subtle', true)));
      }
      if (Array.isArray(note.files)) {
        note.files.forEach((f) => tagList.appendChild(createBadge('📁 ' + f, 'subtle', true)));
      }

      const scopeSelect = el('select', { className: 'form-select' },
        el('option', { value: 'project', selected: note.scope === 'project' }, 'Assign to Project'),
        el('option', { value: 'global', selected: note.scope === 'global' }, 'Mark Global'),
        el('option', { value: 'unknown', selected: note.scope === 'unknown' }, 'Keep Unknown')
      );

      const projWrapper = el('div', { className: 'searchable-dropdown' });
      const projInput = el('input', {
        type: 'text',
        className: 'form-input input-w-180-pr',
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
        className: 'btn btn-primary',
        onClick: async () => {
          const newScope = scopeSelect.value;
          const newProj = newScope === 'project' ? projInput.value.trim() : null;

          if (newScope === 'project' && !newProj) {
            showToast('Project slug is required when scope is project', 'amber');
            return;
          }

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

            if (newProj && !knownProjects.has(newProj)) {
              knownProjects.set(newProj, { notes_count: 1, total: 1 });
              notifyDropdowns();
            }

            showToast('Scope updated for note ' + note.id, 'emerald');
            fetchStats();
            applyNotesFilter();
          } catch (err) {
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
    const scopeSelect = el('select', { className: 'form-select', style: { width: '100%' } },
      el('option', { value: 'project', selected: true }, 'project (requires projectId)'),
      el('option', { value: 'global' }, 'global (applies everywhere)'),
      el('option', { value: 'unknown' }, 'unknown (unspecified scope)')
    );

    const projWrapper = el('div', { className: 'searchable-dropdown flex-1', style: { width: '100%' } });
    const projectInput = el('input', {
      type: 'text',
      className: 'form-input input-w-full-pr',
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
        projWrapper.style.opacity = '0.5';
      } else {
        projWrapper.style.opacity = '1';
      }
    });

    const typeSelect = el('select', { className: 'form-select', style: { width: '100%' } },
      el('option', { value: 'fact' }, 'fact'),
      el('option', { value: 'architecture' }, 'architecture'),
      el('option', { value: 'pattern' }, 'pattern'),
      el('option', { value: 'workflow' }, 'workflow'),
      el('option', { value: 'bug' }, 'bug'),
      el('option', { value: 'lesson' }, 'lesson'),
      el('option', { value: 'preference' }, 'preference')
    );

    const titleInput = el('input', {
      type: 'text',
      className: 'form-input',
      style: { width: '100%' },
      placeholder: 'Note Title...'
    });

    const contentTextarea = el('textarea', {
      className: 'form-textarea',
      placeholder: 'Curated knowledge content (will never be auto-deleted)...'
    });

    const conceptsInput = el('input', {
      type: 'text',
      className: 'form-input',
      style: { width: '100%' },
      placeholder: 'Concepts (comma-separated, e.g. sqlite, schema, migrations)'
    });

    const filesInput = el('input', {
      type: 'text',
      className: 'form-input',
      style: { width: '100%' },
      placeholder: 'Files touched (comma-separated paths, e.g. src/lib/db.ts)'
    });

    const bodyNodes = [
      el('div', {},
        el('label', { className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'RULE 4 SCOPE *'),
        scopeSelect
      ),
      el('div', {},
        el('label', { className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'PROJECT ID'),
        projWrapper
      ),
      el('div', {},
        el('label', { className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'NOTE TYPE *'),
        typeSelect
      ),
      el('div', {},
        el('label', { className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'TITLE *'),
        titleInput
      ),
      el('div', {},
        el('label', { className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'CONTENT *'),
        contentTextarea
      ),
      el('div', {},
        el('label', { className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'CONCEPTS (OPTIONAL)'),
        conceptsInput
      ),
      el('div', {},
        el('label', { className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'FILES TOUCHED (OPTIONAL)'),
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

          try {
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

            showToast('Note created successfully!', 'emerald');
            close();
            fetchStats();
            applyNotesFilter();
          } catch (err) {
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
          el('div', { className: 'inspector-value text-mono', style: { color: 'var(--accent-cyan)' } }, t.id)
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
      )
    ];

    showModal('Trajectory Inspector · ' + t.id, bodyNodes);
  }

  function showObservationModal(obs) {
    const isFailed = obs.failed === 1;
    const bodyNodes = [
      el('div', { className: 'inspector-grid' },
        el('div', { className: 'inspector-field' },
          el('div', { className: 'inspector-label' }, 'OBSERVATION ID'),
          el('div', { className: 'inspector-value text-mono', style: { color: 'var(--accent-cyan)' } }, obs.id)
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
            el('span', { className: 'code-pill', style: { color: 'var(--accent-cyan)' } }, obs.tool_name || obs.kind || 'unknown')
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
        el('div', { className: 'inspector-label', style: { color: isFailed ? '#f87171' : 'var(--text-muted)' } }, 'OUTPUT / EXECUTION RESULT'),
        el('div', {
          className: 'inspector-code-block',
          style: isFailed ? { color: '#fca5a5', borderColor: 'var(--accent-rose-border)' } : {}
        }, obs.output || '(empty output)')
      )
    ];

    showModal('Observation Inspector · ' + obs.id, bodyNodes);
  }

  function showObservationNotFoundModal(recordId, grain = 'observation') {
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
          el('span', { style: { fontSize: '20px' } }, '⚠️'),
          el('div', {},
            el('strong', { style: { color: '#fda4af', display: 'block', marginBottom: '4px' } },
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
          el('div', { className: 'inspector-label' }, 'GRAIN'),
          el('div', { className: 'inspector-value' },
            createBadge((grain || 'observation').toUpperCase(), 'purple', true)
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
          borderRadius: '6px',
          border: '1px solid var(--border-color)',
          fontSize: '13px',
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

  async function inspectCitation(recordId, grain = 'observation') {
    showToast('Fetching cited ' + (grain || 'observation') + ': ' + recordId + '...', 'cyan', 2500);

    // 1. Switch to Trajectories tab & Observations subtab
    switchTab('trajectories');

    if (grain === 'trajectory') {
      switchSubTab('trajectories', recordId);
      try {
        const resp = await apiFetch('/trajectories/' + encodeURIComponent(recordId));
        if (resp.status === 404) {
          showObservationNotFoundModal(recordId, grain);
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
        showObservationNotFoundModal(recordId, grain);
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

  async function renderTrajectoriesTable(container, highlightId = null) {
    container.replaceChildren(
      el('div', { className: 'text-muted', style: { padding: '24px', textAlign: 'center' } }, 'Loading trajectories...')
    );

    try {
      const resp = await apiFetch('/trajectories?limit=50');
      if (!resp.ok) throw new Error('Failed to load trajectories: HTTP ' + resp.status);
      const list = await resp.json();

      container.replaceChildren();
      if (!list || list.length === 0) {
        const trajCounts = statsData?.counts?.trajectories || {};
        const archivedCount = trajCounts.archived || 0;
        const emptyCard = el('div', {
          className: 'result-card',
          style: { padding: '32px 24px', textAlign: 'center', backgroundColor: 'var(--bg-subtle)' }
        },
          el('div', { style: { fontSize: '28px', marginBottom: '12px' } }, '📋'),
          el('h3', { style: { fontSize: '16px', fontWeight: '700', marginBottom: '8px' } }, 'No Active Trajectories Recorded'),
          el('p', { className: 'text-muted', style: { fontSize: '13px', maxWidth: '520px', margin: '0 auto 16px', lineHeight: '1.5' } },
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
              el('td', {}, el('span', { className: 'code-pill text-mono' + (isTarget ? ' text-bold' : '') }, t.id)),
              el('td', {}, createBadge(t.scope + (t.project_id ? ': ' + t.project_id : ''), 'subtle', true)),
              el('td', {}, el('span', { className: 'code-pill' }, t.task_type || 'unknown')),
              el('td', {}, outcomeBadge),
              el('td', {}, el('span', { className: 'text-mono' }, (t.duration_ms || 0) + 'ms')),
              el('td', {},
                el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, t.description),
                t.result ? el('div', { className: 'text-muted', style: { fontSize: '12px' } }, t.result) : null
              ),
              el('td', {},
                el('button', {
                  className: 'btn',
                  style: { height: '28px', padding: '0 8px', fontSize: '11px' },
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

      container.appendChild(table);

      if (highlightedRowEl) {
        setTimeout(() => {
          highlightedRowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 120);
      }
    } catch (err) {
      container.replaceChildren(
        el('div', { className: 'toast toast-rose', style: { position: 'static' } },
          el('span', {}, 'Error: ' + err.message)
        )
      );
    }
  }

  async function renderObservationsTable(container, highlightId = null) {
    container.replaceChildren(
      el('div', { className: 'text-muted', style: { padding: '24px', textAlign: 'center' } }, 'Loading observations...')
    );

    try {
      const resp = await apiFetch('/observations?limit=50');
      if (!resp.ok) throw new Error('Failed to load observations: HTTP ' + resp.status);
      const list = await resp.json();

      container.replaceChildren();
      if (!list || list.length === 0) {
        const obsCounts = statsData?.counts?.observations || {};
        const archivedCount = obsCounts.archived || 0;
        const emptyCard = el('div', {
          className: 'result-card',
          style: { padding: '32px 24px', textAlign: 'center', backgroundColor: 'var(--bg-subtle)' }
        },
          el('div', { style: { fontSize: '28px', marginBottom: '12px' } }, '🔍'),
          el('h3', { style: { fontSize: '16px', fontWeight: '700', marginBottom: '8px' } }, 'No Active Observations Recorded'),
          el('p', { className: 'text-muted', style: { fontSize: '13px', maxWidth: '520px', margin: '0 auto 16px', lineHeight: '1.5' } },
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
              el('td', {}, el('span', { className: 'code-pill text-mono' + (isTarget ? ' text-bold' : '') }, obs.id)),
              el('td', {}, createBadge(obs.scope + (obs.project_id ? ': ' + obs.project_id : ''), 'subtle', true)),
              el('td', {}, el('span', { className: 'code-pill', style: { color: 'var(--accent-cyan)' } }, toolStr)),
              el('td', {}, obs.file_path ? el('span', { className: 'code-pill' }, obs.file_path) : el('span', { className: 'text-muted' }, '-')),
              el('td', {}, statusBadge),
              el('td', {}, el('span', { className: 'text-mono' }, (obs.duration_ms || 0) + 'ms')),
              el('td', {},
                el('div', { style: { fontSize: '11px', maxHeight: '40px', overflow: 'hidden' } },
                  obs.input ? el('span', { className: 'text-muted' }, 'in: ' + obs.input.slice(0, 70)) : null,
                  obs.output ? el('div', { style: { color: isFailed ? '#f87171' : 'var(--text-secondary)' } }, 'out: ' + obs.output.slice(0, 70)) : null
                )
              ),
              el('td', {},
                el('button', {
                  className: 'btn',
                  style: { height: '28px', padding: '0 8px', fontSize: '11px' },
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

      container.appendChild(table);

      if (highlightedRowEl) {
        setTimeout(() => {
          highlightedRowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 120);
      }
    } catch (err) {
      container.replaceChildren(
        el('div', { className: 'toast toast-rose', style: { position: 'static' } },
          el('span', {}, 'Error: ' + err.message)
        )
      );
    }
  }

  async function renderSummariesList(container) {
    container.replaceChildren(
      el('div', { className: 'text-muted', style: { padding: '24px', textAlign: 'center' } }, 'Loading extractive summaries...')
    );

    try {
      const resp = await apiFetch('/summaries?limit=50');
      if (!resp.ok) throw new Error('Failed to load summaries: HTTP ' + resp.status);
      const list = await resp.json();

      container.replaceChildren();
      if (!list || list.length === 0) {
        container.appendChild(
          el('div', { className: 'text-muted', style: { padding: '24px', textAlign: 'center' } },
            'No extractive summaries stored yet. Derived rows are produced under Rule 6 attribution.'
          )
        );
        return;
      }

      list.forEach((sum) => {
        const card = el('div', { className: 'result-card' });

        const outcomeVariant = sum.outcome === 'success' ? 'emerald' : sum.outcome === 'failure' ? 'rose' : 'amber';
        const outcomeBadge = createBadge('OUTCOME: ' + (sum.outcome || 'unknown').toUpperCase(), outcomeVariant, true);

        const producerStr = (sum.producer_tier || 'agent') + (sum.producer_model ? '/' + sum.producer_model : '') + ' (' + sum.prompt_version + ')';
        const producerBadge = createBadge('PRODUCER: ' + producerStr, 'purple', true);

        const header = el('div', { className: 'result-header' },
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            createBadge(sum.kind.toUpperCase(), 'cyan', true),
            outcomeBadge,
            producerBadge,
            sum.verified === 1 ? createBadge('VERIFIED', 'emerald', true) : createBadge('UNVERIFIED', 'amber', true)
          ),
          el('span', { className: 'code-pill text-mono' }, sum.id)
        );

        // Claims list
        const claimsList = el('div', { style: { marginTop: '10px' } });
        if (Array.isArray(sum.claims) && sum.claims.length > 0) {
          sum.claims.forEach((claim, idx) => {
            const claimSources = (sum.sources || []).filter((s) => s.claim_id === claim.id);
            const sourcePills = claimSources.map((s) =>
              el('span', {
                className: 'code-pill citation-badge',
                title: 'Citation source: ' + s.grain + ' -> ' + s.record_id + ' (Click to inspect observation)',
                onClick: (e) => {
                  e.stopPropagation();
                  inspectCitation(s.record_id, s.grain);
                }
              }, '🔍 ' + s.record_id)
            );

            const claimItem = el('div', {
              style: {
                backgroundColor: 'var(--bg-subtle)',
                padding: '10px 14px',
                borderRadius: '6px',
                marginBottom: '6px'
              }
            },
              el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, (idx + 1) + '. ' + claim.text),
              el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
                el('span', { className: 'text-muted', style: { fontSize: '11px' } }, 'Citations:'),
                ...sourcePills
              )
            );
            claimsList.appendChild(claimItem);
          });
        }

        // Additional/General citations if any sources are not mapped to specific claims
        const claimedSourceIds = new Set((sum.claims || []).flatMap((c) => (sum.sources || []).filter(s => s.claim_id === c.id).map(s => s.record_id)));
        const generalSources = (sum.sources || []).filter(s => !claimedSourceIds.has(s.record_id));
        if (generalSources.length > 0) {
          const generalPills = generalSources.map((s) =>
            el('span', {
              className: 'code-pill citation-badge',
              title: 'Source: ' + s.grain + ' -> ' + s.record_id + ' (Click to inspect observation)',
              onClick: (e) => {
                e.stopPropagation();
                inspectCitation(s.record_id, s.grain);
              }
            }, '🔍 ' + s.record_id)
          );
          claimsList.appendChild(
            el('div', {
              style: {
                backgroundColor: 'var(--bg-subtle)',
                padding: '8px 14px',
                borderRadius: '6px',
                marginTop: '6px',
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
                flexWrap: 'wrap'
              }
            },
              el('span', { className: 'text-muted', style: { fontSize: '11px', fontWeight: '600' } }, 'General Citations:'),
              ...generalPills
            )
          );
        }

        card.appendChild(header);
        card.appendChild(claimsList);
        container.appendChild(card);
      });
    } catch (err) {
      container.replaceChildren(
        el('div', { className: 'toast toast-rose', style: { position: 'static' } },
          el('span', {}, 'Error: ' + err.message)
        )
      );
    }
  }

  // Interactive Test Capture Modal
  function openCaptureModal(defaultGrain = 'observation') {
    const isTraj = defaultGrain === 'trajectory';
    const grainSelect = el('select', { className: 'form-select', style: { width: '100%' } },
      el('option', { value: 'observation', selected: !isTraj }, 'Observation (Tool Call / Hot Path)'),
      el('option', { value: 'trajectory', selected: isTraj }, 'Trajectory (Task Attempt Rollup)')
    );

    const scopeSelect = el('select', { className: 'form-select', style: { width: '100%' } },
      el('option', { value: 'project', selected: true }, 'project'),
      el('option', { value: 'global' }, 'global'),
      el('option', { value: 'unknown' }, 'unknown')
    );

    const projectInput = el('input', {
      type: 'text',
      className: 'form-input',
      style: { width: '100%' },
      value: 'example-app',
      placeholder: 'Project ID...'
    });

    const toolOrTaskInput = el('input', {
      type: 'text',
      className: 'form-input',
      style: { width: '100%' },
      value: isTraj ? 'migration' : 'ExecuteCommand',
      placeholder: 'Tool Name (e.g. Edit, ExecuteCommand) or Task Type...'
    });

    const fileInput = el('input', {
      type: 'text',
      className: 'form-input',
      style: { width: '100%' },
      value: isTraj ? '' : 'src/lib/db.ts',
      placeholder: 'Target File Path...'
    });

    const failedSelect = el('select', { className: 'form-select', style: { width: '100%' } },
      el('option', { value: '0', selected: true }, 'Success / OK (failed = 0)'),
      el('option', { value: '1' }, 'Failed (failed = 1) — Triggers Failure Pattern UPSERT')
    );

    const inputArea = el('textarea', {
      className: 'form-textarea',
      placeholder: 'Input / Description...',
      textContent: isTraj ? 'Execute migration for SQLite composite index' : 'npm test -- memories'
    });

    const outputArea = el('textarea', {
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
        el('label', { className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'GRAIN'),
        grainSelect
      ),
      el('div', {},
        el('label', { className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'SCOPE & PROJECT'),
        el('div', { style: { display: 'flex', gap: '8px' } }, scopeSelect, projectInput)
      ),
      el('div', {},
        el('label', { className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'TOOL / TASK TYPE'),
        toolOrTaskInput
      ),
      el('div', {},
        el('label', { className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'FILE PATH'),
        fileInput
      ),
      el('div', {},
        el('label', { className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'STATUS / OUTCOME'),
        failedSelect
      ),
      el('div', {},
        el('label', { className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'INPUT / PROMPT'),
        inputArea
      ),
      el('div', {},
        el('label', { className: 'text-muted', style: { fontSize: '12px', fontWeight: '600', display: 'block', marginBottom: '4px' } }, 'OUTPUT / RESULT'),
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

          try {
            if (grain === 'observation') {
              const resp = await apiFetch('/capture/observations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  observations: [{
                    scope,
                    project_id: projectId,
                    kind: 'tool_call',
                    tool_name: toolOrTaskInput.value.trim(),
                    file_path: fileInput.value.trim() || null,
                    input: inputArea.value.trim(),
                    output: outputArea.value.trim(),
                    failed,
                    duration_ms: 120
                  }]
                })
              });
              if (!resp.ok) throw new Error('Observation capture failed: ' + resp.status);
              const result = await resp.json();
              showToast('Captured observation ' + (result.ids ? result.ids[0] : 'ok'), 'emerald');
            } else {
              const resp = await apiFetch('/capture/trajectories', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  trajectories: [{
                    scope,
                    project_id: projectId,
                    task_type: toolOrTaskInput.value.trim(),
                    description: inputArea.value.trim(),
                    result: outputArea.value.trim(),
                    success: failed === 0,
                    duration_ms: 350
                  }]
                })
              });
              if (!resp.ok) throw new Error('Trajectory capture failed: ' + resp.status);
              const result = await resp.json();
              showToast('Captured trajectory ' + (result.ids ? result.ids[0] : 'ok'), 'emerald');
            }

            close();
            fetchStats();
            renderTrajectoriesSubView();
          } catch (err) {
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
      btnRun.textContent = 'Running Fixtures...';
    }

    if (verdictContainer) {
      verdictContainer.replaceChildren(
        el('div', { className: 'text-muted', style: { padding: '16px', textAlign: 'center' } },
          'Running conformance fixtures (fx1-failure, fx2-success, fx3-sparse) through verification gate...'
        )
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
        btnRun.textContent = 'Run Conformance Fixtures';
      }
    }
  }

  function renderConformanceReport(data) {
    const verdictContainer = document.getElementById('conformanceVerdictContainer');
    const resultsContainer = document.getElementById('conformanceResultsContainer');
    if (!verdictContainer || !resultsContainer) return;

    // 1. Overall Non-Contradictory Verdict Banner
    const isPassing = data.all_passing === true;
    const banner = el('div', {
      className: 'warning-banner',
      style: {
        borderRadius: '8px',
        marginBottom: '16px',
        backgroundColor: isPassing ? 'rgba(16, 185, 129, 0.15)' : 'rgba(244, 63, 94, 0.15)',
        borderColor: isPassing ? 'var(--accent-emerald-border)' : 'var(--accent-rose-border)'
      }
    },
      el('div', { className: 'warning-banner-text' },
        el('span', { style: { fontSize: '20px' } }, isPassing ? '✅' : '❌'),
        el('div', {},
          el('strong', { style: { color: isPassing ? '#6ee7b7' : '#fda4af', fontSize: '15px' } },
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
            el('td', {}, el('span', { className: 'badge badge-rose badge-mono' }, String(fp.count))),
            el('td', {}, el('span', { className: 'text-mono', style: { fontSize: '12px' } }, formatTimestamp(fp.last_seen_at))),
            el('td', {}, el('pre', { className: 'code-block', style: { padding: '6px 10px', fontSize: '11px', margin: 0 }, textContent: fp.error_text }))
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
                className: 'btn',
                style: { height: '30px', padding: '0 10px', fontSize: '12px' },
                onClick: () => {
                  showModal('Dead Letter Payload Inspector (' + dl.id + ')', [
                    el('div', { style: { marginBottom: '8px' } },
                      createBadge('REASON: ' + dl.reason, 'rose', true),
                      createBadge('PRODUCER: ' + (dl.producer || 'unknown'), 'purple', true)
                    ),
                    el('pre', { className: 'code-block', style: { maxHeight: '400px' }, textContent: dl.payload })
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
      const banner = el('div', {
        style: {
          backgroundColor: 'rgba(16, 185, 129, 0.08)',
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
            style: { color: '#6ee7b7', fontSize: '13px' },
            textContent: '✓ API Key Successfully Created'
          }),
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
            style: {
              flex: '1',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              backgroundColor: 'var(--bg-base)',
              color: '#6ee7b7'
            }
          }),
          el('button', {
            className: 'btn btn-primary',
            style: { cursor: 'pointer', height: '38px' },
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(newKeyData.key);
                showToast('API key copied to clipboard!', 'emerald', 3000);
              } catch {
                showToast('Failed to copy to clipboard', 'rose');
              }
            }
          }, 'Copy Key')
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

    const mcpSection = el('div', {
      style: {
        marginBottom: '20px',
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
          style: { fontWeight: '600', fontSize: '13px', color: 'var(--text-primary)' },
          textContent: 'Agent MCP Configuration (Antigravity / Claude Code)'
        }),
        el('button', {
          className: 'btn',
          style: { height: '30px', padding: '0 12px', fontSize: '12px', cursor: 'pointer' },
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(mcpSnippetText);
              showToast('MCP configuration JSON copied to clipboard!', 'emerald', 3000);
            } catch {
              showToast('Failed to copy to clipboard', 'rose');
            }
          }
        }, 'Copy MCP JSON')
      ),
      el('pre', {
        className: 'code-block',
        style: {
          maxHeight: '160px',
          overflowY: 'auto',
          fontSize: '11px',
          margin: '0',
          backgroundColor: 'var(--bg-base)'
        },
        textContent: mcpSnippetText
      })
    );
    modalBodyNodes.push(mcpSection);

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
        style: { fontWeight: '600', fontSize: '13px', color: 'var(--text-primary)' },
        textContent: 'Active API Keys'
      }),
      el('button', {
        className: 'btn',
        style: { height: '28px', padding: '0 10px', fontSize: '11px', cursor: 'pointer' },
        onClick: () => refreshKeysList()
      }, 'Refresh')
    );
    activeKeysContainer.appendChild(activeKeysHeader);

    const keysTableWrapper = el('div', { style: { overflowX: 'auto' } });
    activeKeysContainer.appendChild(keysTableWrapper);
    modalBodyNodes.push(activeKeysContainer);

    async function refreshKeysList() {
      keysTableWrapper.replaceChildren();
      const loading = el('div', {
        style: { padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' },
        textContent: 'Loading active keys...'
      });
      keysTableWrapper.appendChild(loading);

      try {
        const resp = await apiFetch('/maintenance/api-keys');
        const keys = await resp.json();
        keysTableWrapper.replaceChildren();

        if (!resp.ok) {
          keysTableWrapper.appendChild(el('div', {
            style: { padding: '12px', color: '#fda4af', fontSize: '12px' },
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
                el('td', { style: { padding: '8px', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)' }, textContent: k.id }),
                el('td', { style: { padding: '8px', color: 'var(--text-secondary)' }, textContent: k.created_at ? new Date(k.created_at).toLocaleDateString() : 'unknown' }),
                el('td', { style: { padding: '8px', color: 'var(--text-secondary)' }, textContent: k.last_used_at ? new Date(k.last_used_at).toLocaleTimeString() : 'never' }),
                el('td', { style: { padding: '8px', textAlign: 'center' } },
                  el('button', {
                    className: 'btn btn-rose',
                    style: { height: '26px', padding: '0 8px', fontSize: '11px', cursor: 'pointer' },
                    onClick: async () => {
                      try {
                        const delResp = await apiFetch('/maintenance/api-keys/' + encodeURIComponent(k.id), {
                          method: 'DELETE'
                        });
                        if (delResp.ok) {
                          showToast('API key "' + k.name + '" revoked', 'emerald', 2500);
                          await refreshKeysList();
                        } else {
                          const errData = await delResp.json();
                          showToast('Failed to revoke: ' + (errData.error?.message || 'Unknown error'), 'rose');
                        }
                      } catch (err) {
                        showToast('Revoke error: ' + err.message, 'rose');
                      }
                    }
                  }, 'Revoke')
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
          style: { padding: '12px', color: '#fda4af', fontSize: '12px' },
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
            showToast('New API key generated!', 'emerald', 2500);
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
          btnGenApiKey.textContent = isBootstrapRequired ? 'Claiming...' : 'Generating...';
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

          // Automatically activate the key in this window!
          inMemoryApiKey = data.key;
          isSessionAuthenticated = true;
          sessionKeyName = data.name || 'Active';
          isBootstrapRequired = false;
          updateAuthStatusUI();

          showToast(isBootstrapRequired ? 'First-time key claimed successfully!' : 'API key created successfully!', 'emerald', 3000);
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
          btnDrain.textContent = 'Draining...';
          const resp = await apiFetch('/dashboard/api/drain-embed', { method: 'POST' });
          const result = await resp.json();
          if (!resp.ok) throw new Error(result.error || 'Drain failed');

          showToast('Drain complete! Processed ' + result.processed + ' embeddings (' + result.remaining + ' remaining)', 'emerald');
          await fetchStats();
        } catch (err) {
          showToast('Drain error: ' + err.message, 'rose');
        } finally {
          btnDrain.disabled = false;
          btnDrain.textContent = 'Drain Embed Queue';
        }
      });
    }

    // 3. Retention Cleanup Pass
    const btnCleanup = document.getElementById('btnCleanup');
    if (btnCleanup) {
      btnCleanup.addEventListener('click', async () => {
        try {
          btnCleanup.disabled = true;
          btnCleanup.textContent = 'Running Cleanup...';
          const resp = await apiFetch('/maintenance/cleanup', { method: 'POST' });
          const result = await resp.json();
          if (!resp.ok) throw new Error('Cleanup failed');

          showToast('Retention cleanup done: ' + (result.observationsArchived || 0) + ' obs archived, ' + (result.trajectoriesArchived || 0) + ' trajectories archived', 'emerald');
          await fetchStats();
        } catch (err) {
          showToast('Cleanup error: ' + err.message, 'rose');
        } finally {
          btnCleanup.disabled = false;
          btnCleanup.textContent = 'Run Retention Cleanup';
        }
      });
    }

    // 4. Refresh Data
    const btnRefresh = document.getElementById('btnRefresh');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', async () => {
        btnRefresh.textContent = 'Refreshing...';
        await fetchStats();
        btnRefresh.textContent = 'Refresh Data';
        showToast('Telemetry and memory layer stats refreshed', 'cyan', 2000);
      });
    }

    // 5. Re-embed Button on Mismatch Warning Banner
    const btnReembed = document.getElementById('btnBannerReembed');
    if (btnReembed) {
      btnReembed.addEventListener('click', async () => {
        try {
          btnReembed.disabled = true;
          btnReembed.textContent = 'Starting Atomic Re-embed...';
          const resp = await apiFetch('/maintenance/reembed', { method: 'POST' });
          const result = await resp.json();
          if (!resp.ok) throw new Error(result.error?.message || 'Re-embed failed to start');

          showToast('Atomic re-embed initiated: collection ' + (result.collection || 'new'), 'emerald', 6000);
          pollReembedProgress();
        } catch (err) {
          showToast('Re-embed error: ' + err.message, 'rose');
          btnReembed.disabled = false;
          btnReembed.textContent = 'Run Atomic Re-embed';
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
        btnReembed.textContent = 'Run Atomic Re-embed';
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
        btnReembed.textContent = 'Re-embedding ' + processed + '/' + total + ' (' + pct + '%)...';
      } else {
        btnReembed.disabled = false;
        btnReembed.textContent = 'Run Atomic Re-embed';
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
                btnReembed.textContent = 'Run Atomic Re-embed';
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
            showToast('Atomic re-embed successfully completed! Processed ' + status.processed + ' vectors', 'emerald', 7000);
            await fetchStats();
            const btnReembed = document.getElementById('btnBannerReembed');
            if (btnReembed) {
              btnReembed.disabled = false;
              btnReembed.textContent = 'Run Atomic Re-embed';
            }
          } else if (status.status === 'failed') {
            shouldContinue = false;
            isReembedding = false;
            showToast('Re-embed failed: ' + status.error, 'rose', 7000);
            const btnReembed = document.getElementById('btnBannerReembed');
            if (btnReembed) {
              btnReembed.disabled = false;
              btnReembed.textContent = 'Run Atomic Re-embed';
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
              btnReembed.textContent = 'Run Atomic Re-embed';
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
      btn.className = btn.getAttribute('data-short-subtab') === subTabKey ? 'btn btn-primary' : 'btn';
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
    if (status === 'completed') return 'cyan';
    if (status === 'abandoned') return 'rose';
    return 'subtle';
  }

  function getActionPriorityVariant(priority) {
    if (priority === 'urgent') return 'rose';
    if (priority === 'high') return 'amber';
    if (priority === 'normal') return 'cyan';
    return 'subtle';
  }

  function getActionStatusVariant(status) {
    if (status === 'ready') return 'emerald';
    if (status === 'blocked') return 'rose';
    if (status === 'in_progress') return 'cyan';
    return 'subtle';
  }

  async function loadShortSessions() {
    const container = document.getElementById('shortTermListContainer');
    if (!container) return;
    container.replaceChildren(
      el('div', { className: 'text-muted', style: { padding: '24px', textAlign: 'center' } }, 'Loading sessions...')
    );

    const projInput = document.getElementById('shortSessionsProject');
    const statusSelect = document.getElementById('shortSessionsStatus');
    let projVal = projInput ? projInput.value.trim() : '';
    if (projVal.toLowerCase() === 'all projects') projVal = '';

    const params = new URLSearchParams();
    if (projVal) params.set('project_id', projVal);
    if (statusSelect && statusSelect.value) params.set('status', statusSelect.value);
    params.set('limit', '50');

    try {
      const resp = await apiFetch('/sessions?' + params.toString());
      if (!resp.ok) throw new Error('Failed to load sessions: ' + resp.status);
      const data = await resp.json();
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];

      container.replaceChildren();
      if (sessions.length === 0) {
        container.appendChild(
          el('div', { className: 'text-muted', style: { padding: '24px', textAlign: 'center' } }, 'No sessions match the current filters.')
        );
        return;
      }

      sessions.forEach((sess) => {
        const card = el('div', { className: 'result-card' });
        const agentName = sess.agent_name || 'unknown-agent';
        const scopeVariant = sess.scope === 'project' ? 'emerald' : (sess.scope === 'global' ? 'cyan' : 'rose');

        const headerLeft = el('div', { className: 'control-row', style: { flexWrap: 'wrap' } },
          createBadge(agentName, 'purple', true),
          createBadge((sess.status || 'active').toUpperCase(), getSessionStatusVariant(sess.status), true),
          createBadge(sess.scope || 'unknown', scopeVariant, true),
          sess.project_id ? createBadge(sess.project_id, 'subtle', true) : null
        );

        const replayBtn = el('button', {
          type: 'button',
          className: 'btn btn-primary',
          onClick: () => showSessionReplayModal(sess.id)
        }, 'Replay');

        card.appendChild(el('div', { className: 'card-header', style: { marginBottom: '8px' } },
          headerLeft,
          replayBtn
        ));

        card.appendChild(el('div', { style: { fontSize: '13px', marginBottom: '6px' } },
          sess.summary ? sess.summary : el('span', { className: 'text-muted' }, 'No session summary recorded.')
        ));

        card.appendChild(el('div', { className: 'text-muted text-mono', style: { fontSize: '11px' } },
          'ID: ' + sess.id + ' · Started: ' + formatTimestamp(sess.started_at) +
          (sess.ended_at ? ' · Ended: ' + formatTimestamp(sess.ended_at) : '')
        ));

        container.appendChild(card);
      });
    } catch (err) {
      container.replaceChildren(
        el('div', { className: 'toast toast-rose', style: { position: 'static' } },
          el('span', {}, 'Error loading sessions: ' + err.message)
        )
      );
    }
  }

  async function showSessionReplayModal(sessionId) {
    showModal(
      'Session Replay: ' + sessionId,
      [el('div', { className: 'text-muted', style: { padding: '16px', textAlign: 'center' } }, 'Loading session replay timeline...')],
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
          createBadge(sess.agent_name || 'unknown-agent', 'purple', true),
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
          const kindVariant = kind === 'note' ? 'emerald' : (kind === 'action' ? 'amber' : 'cyan');
          listEl.appendChild(
            el('div', { className: 'replay-item kind-' + kind },
              el('div', { className: 'control-row', style: { justifyContent: 'space-between', marginBottom: '4px' } },
                el('div', { className: 'control-row' },
                  createBadge(kind.toUpperCase(), kindVariant, true),
                  el('strong', { style: { fontSize: '13px' } }, item.title || item.id)
                ),
                el('span', { className: 'text-muted text-mono', style: { fontSize: '11px' } }, formatTimestamp(item.timestamp))
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

  async function loadShortActions() {
    const container = document.getElementById('shortTermListContainer');
    if (!container) return;
    container.replaceChildren(
      el('div', { className: 'text-muted', style: { padding: '24px', textAlign: 'center' } }, 'Loading next actions...')
    );

    const projInput = document.getElementById('shortActionsProject');
    const statusSelect = document.getElementById('shortActionsStatus');
    let projVal = projInput ? projInput.value.trim() : '';
    if (projVal.toLowerCase() === 'all projects') projVal = '';

    const params = new URLSearchParams();
    if (projVal) params.set('project_id', projVal);
    if (statusSelect && statusSelect.value) params.set('status', statusSelect.value);
    params.set('limit', '50');

    try {
      const resp = await apiFetch('/actions?' + params.toString());
      if (!resp.ok) throw new Error('Failed to load actions: ' + resp.status);
      const data = await resp.json();
      const actions = Array.isArray(data.actions) ? data.actions : [];

      container.replaceChildren();
      if (actions.length === 0) {
        container.appendChild(
          el('div', { className: 'text-muted', style: { padding: '24px', textAlign: 'center' } }, 'No next actions match the current filters.')
        );
        return;
      }

      actions.forEach((act) => {
        const card = el('div', { className: 'result-card' });
        const scopeVariant = act.scope === 'project' ? 'emerald' : (act.scope === 'global' ? 'cyan' : 'rose');
        const isTerminal = act.status === 'done' || act.status === 'dismissed';

        const headerLeft = el('div', { className: 'control-row', style: { flexWrap: 'wrap' } },
          createBadge((act.priority || 'normal').toUpperCase(), getActionPriorityVariant(act.priority), true),
          createBadge((act.status || 'ready').toUpperCase(), getActionStatusVariant(act.status), true),
          createBadge(act.scope || 'unknown', scopeVariant, true),
          act.project_id ? createBadge(act.project_id, 'subtle', true) : null
        );

        const doneBtn = el('button', {
          type: 'button',
          className: 'btn btn-emerald',
          disabled: isTerminal,
          onClick: () => updateActionStatus(act.id, 'done')
        }, 'Done');

        const dismissBtn = el('button', {
          type: 'button',
          className: 'btn',
          disabled: isTerminal,
          onClick: () => updateActionStatus(act.id, 'dismissed')
        }, 'Dismiss');

        card.appendChild(el('div', { className: 'card-header', style: { marginBottom: '8px' } },
          headerLeft,
          el('div', { className: 'control-row' }, doneBtn, dismissBtn)
        ));

        card.appendChild(el('div', { className: 'font-semibold', style: { fontSize: '14px', marginBottom: '4px' } }, act.title));
        if (act.description) {
          card.appendChild(el('div', { style: { fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '6px' } }, act.description));
        }
        if (act.blocked_reason) {
          card.appendChild(el('div', { style: { fontSize: '12px', color: '#fda4af', marginBottom: '6px' } }, 'Blocked: ' + act.blocked_reason));
        }
        card.appendChild(el('div', { className: 'text-muted text-mono', style: { fontSize: '11px' } },
          'ID: ' + act.id + ' · Updated: ' + formatTimestamp(act.updated_at || act.created_at)
        ));

        container.appendChild(card);
      });
    } catch (err) {
      container.replaceChildren(
        el('div', { className: 'toast toast-rose', style: { position: 'static' } },
          el('span', {}, 'Error loading actions: ' + err.message)
        )
      );
    }
  }

  async function updateActionStatus(actionId, status) {
    try {
      const resp = await apiFetch('/actions/' + encodeURIComponent(actionId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (!resp.ok) throw new Error('Update failed: ' + resp.status);
      showToast('Action marked as ' + status, 'emerald', 3000);
      loadShortActions();
      fetchStats();
    } catch (err) {
      showToast('Failed to update action: ' + err.message, 'rose');
    }
  }

  // =========================================================================
  // Knowledge Graph Tab (SVG Renderer + Side Inspector)
  // =========================================================================
  const GRAPH_TYPE_COLORS = {
    note: '#38bdf8',
    lesson: '#f59e0b',
    concept: '#a855f7',
    file: '#10b981',
    session: '#60a5fa',
    action: '#f43f5e',
    summary: '#2dd4bf'
  };

  function initGraphTab() {
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

  async function loadGraph() {
    const canvasWrap = document.getElementById('graphCanvasContainer');
    const statsBadge = document.getElementById('graphStatsBadge');
    if (!canvasWrap) return;

    canvasWrap.replaceChildren(
      el('div', { className: 'text-muted', style: { padding: '24px' } }, 'Loading knowledge graph...')
    );

    const projInput = document.getElementById('graphFilterProject');
    const scopeSel = document.getElementById('graphFilterScope');
    const limitSel = document.getElementById('graphFilterLimit');

    let projVal = projInput ? projInput.value.trim() : '';
    if (projVal.toLowerCase() === 'all projects') projVal = '';

    const params = new URLSearchParams();
    if (projVal) params.set('project_id', projVal);
    if (scopeSel && scopeSel.value) params.set('scope', scopeSel.value);
    if (limitSel && limitSel.value) params.set('limit', limitSel.value);

    try {
      const resp = await apiFetch('/dashboard/api/graph?' + params.toString());
      if (!resp.ok) throw new Error('Graph request failed: ' + resp.status);
      graphData = await resp.json();
      selectedGraphNodeId = null;

      const nodes = Array.isArray(graphData.nodes) ? graphData.nodes : [];
      const edges = Array.isArray(graphData.edges) ? graphData.edges : [];
      if (statsBadge) {
        statsBadge.textContent = nodes.length + ' nodes · ' + edges.length + ' edges';
      }

      renderGraphLegend();
      renderGraphSvg(nodes, edges);

      const inspector = document.getElementById('graphInspectorContainer');
      if (inspector) {
        inspector.replaceChildren(
          el('div', { className: 'text-muted' }, 'Click any node in the graph to inspect its metadata and connections.')
        );
      }
    } catch (err) {
      canvasWrap.replaceChildren(
        el('div', { className: 'toast toast-rose', style: { position: 'static' } },
          el('span', {}, 'Error loading graph: ' + err.message)
        )
      );
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

    const SVG_NS = 'http://www.w3.org/2000/svg';
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
      line.setAttribute('stroke', '#334155');
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

      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(Math.round(p.x)));
      circle.setAttribute('cy', String(Math.round(p.y)));
      circle.setAttribute('r', node.type === 'session' || node.type === 'summary' ? '12' : '9');
      circle.setAttribute('fill', GRAPH_TYPE_COLORS[node.type] || '#94a3b8');
      circle.setAttribute('stroke', '#0f172a');
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

    inspector.appendChild(
      el('div', { className: 'control-row mb-4', style: { flexWrap: 'wrap' } },
        createBadge((node.type || 'node').toUpperCase(), 'cyan', true),
        node.scope ? createBadge(node.scope, node.scope === 'project' ? 'emerald' : 'subtle', true) : null,
        node.project_id ? createBadge(node.project_id, 'subtle', true) : null
      )
    );

    inspector.appendChild(el('h3', { style: { fontSize: '15px', marginBottom: '6px', wordBreak: 'break-word' } }, node.label || node.id));
    inspector.appendChild(el('div', { className: 'text-muted text-mono mb-4', style: { fontSize: '11px', wordBreak: 'break-all' } }, 'ID: ' + node.id));

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
          el('span', { className: 'text-muted text-mono', style: { fontSize: '10px', flexShrink: '0' } }, edge.type)
        )
      );
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
              showToast('Authenticated as ' + sessionKeyName + '. Session active!', 'emerald', 3000);
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
        }
      });
    });
  });
})();
`;
