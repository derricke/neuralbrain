export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>neuralbrain — Operator Dashboard</title>
  <link rel="stylesheet" href="/dashboard/styles.css">
  <script src="/dashboard/app.js" defer></script>
</head>
<body>
  <!-- Loud Mismatch Banner (Active when store_meta mismatches config) -->
  <div id="mismatchBanner" class="warning-banner">
    <div class="warning-banner-text">
      <span class="warning-icon">⚠️</span>
      <div>
        <strong>CRITICAL STORE META MISMATCH:</strong>
        <span id="mismatchReasonText">Configured embedder differs from pinned store_meta. Vector search is disabled (SQL and BM25 remain active).</span>
      </div>
    </div>
    <button id="btnBannerReembed" class="btn btn-rose">Run Atomic Re-embed</button>
  </div>

  <!-- Header & Operator Toolbar -->
  <header class="app-header">
    <div class="header-inner">
      <div class="brand-section">
        <div class="brand-logo">B</div>
        <div class="brand-info">
          <span class="brand-title">neuralbrain</span>
          <span class="brand-subtitle">Standalone Memory Engine · Operator Console</span>
        </div>
      </div>

      <div class="header-status-cluster">
        <div id="healthBadge" class="badge badge-emerald">
          <span class="badge-dot"></span>
          <span id="healthText">HEALTH: OK</span>
        </div>
        <div id="storeMetaBadge" class="badge badge-subtle badge-mono">
          <span id="storeMetaText">STORE: loading...</span>
        </div>
        <div id="qdrantBadge" class="badge badge-subtle badge-mono">
          <span id="qdrantText">QDRANT: ...</span>
        </div>
        <div id="reembedBadge" class="badge badge-subtle badge-mono hidden">
          <span id="reembedText">REEMBED: idle</span>
        </div>
      </div>

      <div class="header-actions">
        <form id="formDashboardApiKey" class="header-auth-form" autocomplete="off">
          <input type="text" name="username" class="sr-only" tabindex="-1" autocomplete="username">
          <input id="inputDashboardApiKey" type="password" class="form-input input-api-key" placeholder="Paste API Key..." autocomplete="current-password" title="Bearer token for operator requests">
          <button id="btnSubmitApiKey" type="submit" class="btn btn-primary" title="Authenticate with API key">
            Apply
          </button>
        </form>
        <div id="authSessionCluster" class="auth-session-cluster hidden">
          <div id="authSessionBadge" class="badge badge-emerald badge-mono" title="Active authenticated operator session">
            <span class="badge-dot"></span>
            <span id="authSessionText">KEY: Active</span>
          </div>
          <button id="btnLogoutApiKey" type="button" class="btn" title="Log out of dashboard session">
            Log Out
          </button>
        </div>
        <button id="btnGenerateApiKey" class="btn btn-emerald" title="Generate and manage client API keys for agents">
          + Generate API Key
        </button>
        <button id="btnDrainEmbed" class="btn" title="Drain pending live embeddings into Qdrant">
          Drain Embed Queue
        </button>
        <button id="btnCleanup" class="btn" title="Run 30-day archive and 90-day delete retention pass">
          Run Retention Cleanup
        </button>
        <button id="btnRefresh" class="btn" title="Refresh all telemetry and counts">
          Refresh Data
        </button>
      </div>
    </div>
  </header>

  <!-- Navigation Tabs Bar -->
  <nav class="nav-tabs-bar">
    <div class="nav-tabs-container">
      <button id="tabBtnOverview" class="nav-tab-btn active" data-tab="overview" title="Overview & Memory Layers">
        Overview
      </button>
      <button id="tabBtnNotes" class="nav-tab-btn" data-tab="notes" title="Notes Explorer & Repair Queue">
        Long Term
        <span id="repairQueueBadge" class="tab-badge">0</span>
      </button>
      <button id="tabBtnShortTerm" class="nav-tab-btn" data-tab="shortTerm" title="Active Sessions & Next Actions">
        Short Term
      </button>
      <button id="tabBtnTrajectories" class="nav-tab-btn" data-tab="trajectories" title="Trajectories, Observations, Summaries & Session Replay">
        Observations
      </button>
      <button id="tabBtnGraph" class="nav-tab-btn" data-tab="graph" title="Knowledge Graph Explorer">
        Graph
      </button>
      <button id="tabBtnSearch" class="nav-tab-btn" data-tab="search" title="Hybrid Search & Push Injection">
        Search &amp; Inject
      </button>
      <button id="tabBtnConformance" class="nav-tab-btn" data-tab="conformance" title="Failure Patterns, Dead Letters & AI Conformance Doctor">
        System &amp; AI
      </button>
    </div>
  </nav>

  <!-- Main Application Body -->
  <main class="app-main">
    <!-- Tab 1: Overview & Memory Layers -->
    <section id="paneOverview" class="tab-pane active">
      <div id="overviewKpiGrid" class="kpi-grid"></div>

      <!-- Scope Breakdown (Rule 4 Visualization) -->
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Scope Separation & Rule 4 Telemetry</h2>
            <div class="card-subtitle">Explicit scope, never inferred — and "global" is not "unknown"</div>
          </div>
          <button id="btnScopeGoRepair" class="btn btn-amber">Inspect Repair Queue</button>
        </div>
        <div class="scope-bar-container">
          <div id="scopeProgressBar" class="scope-bar"></div>
          <div class="scope-legend">
            <div class="scope-legend-item">
              <span class="badge-dot dot-emerald"></span>
              <span>Project Scoped (<strong id="legendCountProject">0</strong>)</span>
            </div>
            <div class="scope-legend-item">
              <span class="badge-dot dot-cyan"></span>
              <span>Global Scoped (<strong id="legendCountGlobal">0</strong>)</span>
            </div>
            <div class="scope-legend-item">
              <span class="badge-dot dot-rose"></span>
              <span>Unknown Scoped — Repair Queue (<strong id="legendCountUnknown">0</strong>)</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Type Taxonomy Distribution & Spool Telemetry -->
      <div class="telemetry-grid">
        <div class="card">
          <div class="card-header">
            <div>
              <h2 class="card-title">Note Type Distribution</h2>
              <div class="card-subtitle">Taxonomy from live memory corpus</div>
            </div>
          </div>
          <div id="typeDistributionContainer"></div>
        </div>

        <div class="card">
          <div class="card-header">
            <div>
              <h2 class="card-title">Client Spool Telemetry</h2>
              <div class="card-subtitle">Local JSONL fallback buffer on transport failure</div>
            </div>
          </div>
          <div id="spoolStatsContainer"></div>
        </div>
      </div>

      <!-- Projects Directory Table -->
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Discovered Projects Breakdown</h2>
            <div class="card-subtitle">Multi-tenant memory layers partitioned across notes, trajectories, and observations</div>
          </div>
        </div>
        <div id="projectsTableContainer" class="table-responsive"></div>
      </div>
    </section>

    <!-- Tab 2: Hybrid Search & Push Injection Workbench -->
    <section id="paneSearch" class="tab-pane">
      <div class="workbench-grid">
        <!-- Hybrid Search Column -->
        <div class="card">
          <div class="card-header">
            <div>
              <h2 class="card-title">Hybrid Retrieval (Dense + BM25 with RRF)</h2>
              <div class="card-subtitle">POST /search — Vector similarity plus full-text keyword ranking</div>
            </div>
          </div>

          <form id="searchForm">
            <div class="search-form-grid">
              <input id="searchInputQ" type="text" class="form-input flex-1" placeholder="Search query (e.g., 'foreign key constraint failed' or 'docker')..." required>
              <button id="btnExecuteSearch" type="button" class="btn btn-primary">Search Brain</button>
            </div>

            <div class="filter-bar">
              <div class="form-row-inline">
                <label for="searchSelectScope" class="text-muted form-label-inline">SCOPE:</label>
                <select id="searchSelectScope" class="form-select">
                  <option value="project">project</option>
                  <option value="global">global</option>
                  <option value="unknown">unknown (repair list)</option>
                  <option value="" selected>all scopes</option>
                </select>
              </div>

              <div class="form-row-inline">
                <label for="searchInputProject" class="text-muted form-label-inline">PROJECT:</label>
                <div id="searchProjectDropdownWrapper" class="searchable-dropdown">
                  <input id="searchInputProject" type="text" class="form-input input-w-170-pr" placeholder="All Projects..." autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false">
                  <span id="searchProjectDropdownToggle" class="dropdown-chevron" title="Toggle project dropdown">▼</span>
                  <div id="searchProjectDropdownMenu" class="dropdown-menu"></div>
                </div>
              </div>

              <div class="form-row-inline">
                <label for="searchNoteType" class="text-muted form-label-inline">NOTE TYPE:</label>
                <select id="searchNoteType" class="form-select input-w-140" title="Filter search results by note type">
                  <option value="" selected>All Types</option>
                  <option value="fact">fact</option>
                  <option value="architecture">architecture</option>
                  <option value="pattern">pattern</option>
                  <option value="workflow">workflow</option>
                  <option value="bug">bug</option>
                  <option value="lesson">lesson</option>
                  <option value="preference">preference</option>
                </select>
              </div>

              <label class="checkbox-label">
                <input id="searchCheckGlobal" type="checkbox" checked>
                <span>include_global</span>
              </label>

              <div class="form-row-inline">
                <label for="searchInputFilePath" class="text-muted form-label-inline">FILE:</label>
                <input id="searchInputFilePath" type="text" class="form-input input-w-130" placeholder="path filter">
              </div>
            </div>

            <div class="grains-selection-bar">
              <span class="text-muted form-label-inline">RECORD TYPES:</span>
              <label class="checkbox-label"><input type="checkbox" id="grainCheckNote" checked> note</label>
              <label class="checkbox-label"><input type="checkbox" id="grainCheckTrajectory" checked> trajectory</label>
              <label class="checkbox-label"><input type="checkbox" id="grainCheckObservation" checked> observation</label>
              <label class="checkbox-label"><input type="checkbox" id="grainCheckSummary" checked> summary</label>
            </div>
          </form>

          <div id="searchMetaBar" class="search-meta-bar"></div>
          <div id="searchResultsContainer"></div>
        </div>

        <!-- Push Injection Preview Column -->
        <div class="card">
          <div class="card-header">
            <div>
              <h2 class="card-title">Task-Start Push Injection Simulator</h2>
              <div class="card-subtitle">GET /inject — Proactive context delivered to coding agents before task execution</div>
            </div>
          </div>

          <form id="injectForm">
            <div class="control-row mb-4">
              <div id="injectProjectDropdownWrapper" class="searchable-dropdown flex-1">
                <input id="injectInputProject" type="text" class="form-input input-w-full-pr" placeholder="Project ID (e.g. example-app, demo-project)..." value="example-app" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false">
                <span id="injectProjectDropdownToggle" class="dropdown-chevron" title="Toggle project dropdown">▼</span>
                <div id="injectProjectDropdownMenu" class="dropdown-menu"></div>
              </div>
              <select id="injectInputTaskType" class="form-select input-w-170" title="Filter failure patterns and push injection by task type">
                <option value="">All / Any Task Type</option>
                <option value="general">general</option>
                <option value="implementation">implementation</option>
                <option value="bugfix">bugfix</option>
                <option value="refactor">refactor</option>
                <option value="migration" selected>migration</option>
                <option value="testing">testing</option>
                <option value="security">security</option>
                <option value="deployment">deployment</option>
              </select>
              <button id="btnExecuteInject" type="button" class="btn btn-emerald">Simulate Task-Start Injection</button>
            </div>
          </form>

          <div id="injectOutputContainer"></div>
        </div>
      </div>
    </section>

    <!-- Tab 3: Notes Explorer & Repair Queue -->
    <section id="paneNotes" class="tab-pane">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Notes Explorer & Scope Repair Queue</h2>
            <div class="card-subtitle">Long-Term Memory (Curated Notes & Lessons) — Rule 4 explicit scope enforcement & SQL repair</div>
          </div>
          <div class="control-row">
            <button id="btnOpenCreateNoteModal" class="btn btn-primary">+ Create Note</button>
          </div>
        </div>

        <!-- Long-Term Category Filter Pills -->
        <div id="notesCategoryPills" class="subtabs-bar">
          <button id="btnNotesPillAll" type="button" class="btn btn-primary" data-note-category="all">All</button>
          <button id="btnNotesPillMemories" type="button" class="btn" data-note-category="memories">Memories</button>
          <button id="btnNotesPillLessons" type="button" class="btn" data-note-category="lessons">Lessons</button>
          <button id="btnNotesPillUnknown" type="button" class="btn" data-note-category="unknown">Unknown Scope</button>
        </div>

        <!-- Notes Filter Bar -->
        <div class="filter-bar">
          <div class="form-row-inline">
            <label for="notesFilterScope" class="text-muted form-label-inline">SCOPE:</label>
            <select id="notesFilterScope" class="form-select">
              <option value="">All Scopes</option>
              <option value="unknown">unknown (Repair Queue)</option>
              <option value="project">project</option>
              <option value="global">global</option>
            </select>
          </div>

          <div class="form-row-inline">
            <label for="notesFilterProject" class="text-muted form-label-inline">PROJECT:</label>
            <div id="notesProjectDropdownWrapper" class="searchable-dropdown">
              <input id="notesFilterProject" type="text" class="form-input input-w-170-pr" placeholder="All Projects..." autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false">
              <span id="notesProjectDropdownToggle" class="dropdown-chevron" title="Toggle project dropdown">▼</span>
              <div id="notesProjectDropdownMenu" class="dropdown-menu"></div>
            </div>
          </div>

          <div class="form-row-inline">
            <label for="notesFilterType" class="text-muted form-label-inline">TYPE:</label>
            <select id="notesFilterType" class="form-select">
              <option value="">All Types</option>
              <option value="fact">fact</option>
              <option value="architecture">architecture</option>
              <option value="pattern">pattern</option>
              <option value="workflow">workflow</option>
              <option value="bug">bug</option>
              <option value="lesson">lesson</option>
              <option value="preference">preference</option>
            </select>
          </div>

          <div class="form-row-inline">
            <label for="notesFilterFile" class="text-muted form-label-inline">FILE:</label>
            <input id="notesFilterFile" type="text" class="form-input input-w-150" placeholder="e.g. src/lib/db.ts">
          </div>

          <button id="btnApplyNotesFilter" class="btn">Filter</button>
          <button id="btnShowRepairQueue" class="btn btn-amber">Show Repair Queue Only</button>
        </div>

        <div id="repairBannerContainer"></div>
        <div id="notesListContainer"></div>
      </div>
    </section>

    <!-- Tab: Short Term (Sessions & Next Actions) -->
    <section id="paneShortTerm" class="tab-pane">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Short-Term Memory: Sessions &amp; Next Actions</h2>
            <div class="card-subtitle">Active cross-agent sessions, session replay timelines, and prioritized next actions</div>
          </div>
        </div>

        <div class="subtabs-bar">
          <button id="subTabBtnShortSessions" type="button" class="btn btn-primary" data-short-subtab="sessions">Sessions</button>
          <button id="subTabBtnShortActions" type="button" class="btn" data-short-subtab="actions">Next Actions</button>
          <button id="subTabBtnShortSummaries" type="button" class="btn" data-short-subtab="summaries">Summaries</button>
        </div>

        <div id="shortSessionsFilterBar" class="filter-bar">
          <div class="form-row-inline">
            <label for="shortSessionsProject" class="text-muted form-label-inline">PROJECT:</label>
            <div id="shortSessionsProjectDropdownWrapper" class="searchable-dropdown">
              <input id="shortSessionsProject" type="text" class="form-input input-w-170-pr" placeholder="All Projects..." autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false">
              <span id="shortSessionsProjectDropdownToggle" class="dropdown-chevron" title="Toggle project dropdown">▼</span>
              <div id="shortSessionsProjectDropdownMenu" class="dropdown-menu"></div>
            </div>
          </div>
          <div class="form-row-inline">
            <label for="shortSessionsStatus" class="text-muted form-label-inline">STATUS:</label>
            <select id="shortSessionsStatus" class="form-select">
              <option value="">All Statuses</option>
              <option value="active">active</option>
              <option value="paused">paused</option>
              <option value="completed">completed</option>
              <option value="abandoned">abandoned</option>
            </select>
          </div>
          <button id="btnFilterShortSessions" type="button" class="btn">Refresh Sessions</button>
        </div>

        <div id="shortActionsFilterBar" class="filter-bar hidden">
          <div class="form-row-inline">
            <label for="shortActionsProject" class="text-muted form-label-inline">PROJECT:</label>
            <div id="shortActionsProjectDropdownWrapper" class="searchable-dropdown">
              <input id="shortActionsProject" type="text" class="form-input input-w-170-pr" placeholder="All Projects..." autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false">
              <span id="shortActionsProjectDropdownToggle" class="dropdown-chevron" title="Toggle project dropdown">▼</span>
              <div id="shortActionsProjectDropdownMenu" class="dropdown-menu"></div>
            </div>
          </div>
          <div class="form-row-inline">
            <label for="shortActionsStatus" class="text-muted form-label-inline">STATUS:</label>
            <select id="shortActionsStatus" class="form-select">
              <option value="">All Statuses</option>
              <option value="ready">ready</option>
              <option value="blocked">blocked</option>
              <option value="in_progress">in_progress</option>
              <option value="done">done</option>
              <option value="dismissed">dismissed</option>
            </select>
          </div>
          <button id="btnFilterShortActions" type="button" class="btn">Refresh Actions</button>
        </div>

        <div id="shortTermListContainer"></div>
      </div>
    </section>

    <!-- Tab: Knowledge Graph -->
    <section id="paneGraph" class="tab-pane">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Knowledge Graph</h2>
            <div class="card-subtitle">GET /dashboard/api/graph — Interactive relational topology across notes, lessons, concepts, files, sessions, actions, and summaries</div>
          </div>
          <div id="graphStatsBadge" class="badge badge-subtle badge-mono">0 nodes · 0 edges</div>
        </div>

        <div class="filter-bar">
          <div class="form-row-inline">
            <label for="graphFilterProject" class="text-muted form-label-inline">PROJECT:</label>
            <div id="graphProjectDropdownWrapper" class="searchable-dropdown">
              <input id="graphFilterProject" type="text" class="form-input input-w-170-pr" placeholder="All Projects..." autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false">
              <span id="graphProjectDropdownToggle" class="dropdown-chevron" title="Toggle project dropdown">▼</span>
              <div id="graphProjectDropdownMenu" class="dropdown-menu"></div>
            </div>
          </div>
          <div class="form-row-inline">
            <label for="graphFilterScope" class="text-muted form-label-inline">SCOPE:</label>
            <select id="graphFilterScope" class="form-select">
              <option value="">All Scopes</option>
              <option value="project">project</option>
              <option value="global">global</option>
              <option value="unknown">unknown</option>
            </select>
          </div>
          <div class="form-row-inline">
            <label for="graphFilterLimit" class="text-muted form-label-inline">LIMIT:</label>
            <select id="graphFilterLimit" class="form-select input-w-130">
              <option value="50">50 nodes</option>
              <option value="80" selected>80 nodes</option>
              <option value="120">120 nodes</option>
              <option value="200">200 nodes</option>
            </select>
          </div>
          <button id="btnLoadGraph" type="button" class="btn btn-primary">Load Graph</button>
        </div>

        <div id="graphLegend" class="graph-legend"></div>

        <div class="graph-layout">
          <div id="graphCanvasContainer" class="graph-canvas-wrap"></div>
          <aside id="graphInspectorContainer" class="graph-inspector-wrap">
            <div class="text-muted">Click any node in the graph to inspect its metadata and connections.</div>
          </aside>
        </div>
      </div>
    </section>

    <!-- Tab 4: Trajectories & Observations -->
    <section id="paneTrajectories" class="tab-pane">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Observations, Trajectories & Summaries</h2>
            <div class="card-subtitle">Machine-written high-volume observations rolled up into trajectories and verified summaries</div>
          </div>
          <div class="control-row">
            <button id="btnOpenCaptureModal" class="btn btn-emerald">+ Capture Test Event</button>
          </div>
        </div>

        <div class="subtabs-bar">
          <button id="subTabBtnTrajectories" class="btn btn-primary" data-subtab="trajectories">Trajectories</button>
          <button id="subTabBtnObservations" class="btn" data-subtab="observations">Observations</button>
          <button id="subTabBtnSummaries" class="btn" data-subtab="summaries">Summaries</button>
        </div>

        <div id="trajectoriesSubViewContainer"></div>
      </div>
    </section>

    <!-- Tab 5: Failure Patterns & Conformance Doctor -->
    <section id="paneConformance" class="tab-pane">
      <!-- AI Conformance Doctor -->
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">AI Conformance Doctor</h2>
            <div class="card-subtitle">GET /diagnostics/ai — Non-negotiable verification gate fixtures (fx1-failure, fx2-success, fx3-sparse)</div>
          </div>
          <button id="btnRunConformance" class="btn btn-primary">Run Conformance Fixtures</button>
        </div>
        <div id="conformanceVerdictContainer"></div>
        <div id="conformanceResultsContainer" class="table-responsive"></div>
      </div>

      <!-- Failure Patterns Table -->
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Push-Injection Scoped Failure Patterns</h2>
            <div class="card-subtitle">Grouped by (project_id, task_type, error_text) with atomic SQL UPSERT counter</div>
          </div>
        </div>
        <div id="failurePatternsContainer" class="table-responsive"></div>
      </div>

      <!-- Dead Letters Inspector -->
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Dead Letters Inspector</h2>
            <div class="card-subtitle">Rule 3 guarantee: Dead letters are strictly for malformed records, never for capacity or volume</div>
          </div>
        </div>
        <div id="deadLettersBreakdownContainer" class="dead-letters-breakdown"></div>
        <div id="deadLettersContainer" class="table-responsive"></div>
      </div>
    </section>
  </main>

  <!-- Modal Overlays -->
  <div id="modalContainer" class="modal-overlay"></div>

  <!-- Toasts Container -->
  <div id="toastContainer" class="toast-container"></div>
</body>
</html>`;
}
