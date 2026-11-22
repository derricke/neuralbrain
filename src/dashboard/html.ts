export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>neuralbrain — Operator Dashboard</title>
  <link rel="stylesheet" href="/dashboard/styles.css">
  <script src="/dashboard/app.js" defer></script>
</head>
<body class="full-height-section">
  <!-- Loud Mismatch Banner (Active when store_meta mismatches config) -->
  <div id="mismatchBanner" class="warning-banner">
    <div class="warning-banner-text">
      <svg class="icon-svg warning-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M12 9v4"></path>
        <path d="M12 17h.01"></path>
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path>
      </svg>
      <div>
        <strong>CRITICAL STORE META MISMATCH:</strong>
        <span id="mismatchReasonText">Configured embedder differs from pinned store_meta. Vector search is disabled (SQL and BM25 remain active).</span>
      </div>
    </div>
    <button id="btnBannerReembed" type="button" class="btn btn-rose btn-solid">
      <span class="icon-swap-slot icon-swap-in">
        <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
          <path d="M21 3v5h-5"></path>
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path>
          <path d="M8 16H3v5"></path>
        </svg>
      </span>
      <span class="btn-label">Run Atomic Re-embed</span>
    </button>
  </div>

  <!-- Header & Operator Toolbar -->
  <header class="app-header">
    <div class="header-inner">
      <div class="brand-section">
        <div class="brand-logo" aria-hidden="true">B</div>
        <div class="brand-info">
          <span class="brand-title balanced-headline">
            <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M12 4a4 4 0 0 0-4 4v8a4 4 0 0 0 8 0V8a4 4 0 0 0-4-4Z"></path>
              <path d="M8 10H5a2 2 0 0 0-2 2v1a2 2 0 0 0 2 2h3"></path>
              <path d="M16 10h3a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-3"></path>
            </svg>
            neuralbrain
          </span>
          <span class="brand-subtitle">Memory for agents that holds up · Layered and recalled when it counts</span>
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
        <button id="btnCommandMenu" type="button" class="btn" title="Open Command Menu (⌘K / Ctrl+K)">
          <span class="icon-swap-slot icon-swap-in">
            <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <circle cx="11" cy="11" r="8"></circle>
              <path d="m21 21-4.3-4.3"></path>
            </svg>
          </span>
          <span class="btn-label">Actions</span>
          <kbd class="shortcut-hint">⌘K</kbd>
        </button>

        <form id="formDashboardApiKey" class="header-auth-form" autocomplete="off">
          <input type="text" name="username" class="sr-only" tabindex="-1" autocomplete="username">
          <input id="inputDashboardApiKey" type="password" class="form-input input-api-key" placeholder="Paste API Key..." aria-label="API Key" autocomplete="current-password" title="Bearer token for operator requests">
          <button id="btnSubmitApiKey" type="submit" class="btn btn-primary" title="Authenticate with API key">
            <span class="icon-swap-slot icon-swap-in">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="m21 2-9.6 9.6"></path>
                <circle cx="7.5" cy="15.5" r="5.5"></circle>
                <path d="m15.5 7.5 3 3L22 7l-3-3"></path>
              </svg>
            </span>
            <span class="btn-label">Apply</span>
          </button>
        </form>

        <div id="otpVerifyContainer" class="otp-input-group hidden" aria-label="One-time verification code">
          <input id="otpPrimaryInput" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="otp-digit-input" aria-label="OTP digit 1" placeholder="•">
          <input type="text" inputmode="numeric" maxlength="1" class="otp-digit-input" aria-label="OTP digit 2" placeholder="•">
          <input type="text" inputmode="numeric" maxlength="1" class="otp-digit-input" aria-label="OTP digit 3" placeholder="•">
          <input type="text" inputmode="numeric" maxlength="1" class="otp-digit-input" aria-label="OTP digit 4" placeholder="•">
          <input type="text" inputmode="numeric" maxlength="1" class="otp-digit-input" aria-label="OTP digit 5" placeholder="•">
          <input type="text" inputmode="numeric" maxlength="1" class="otp-digit-input" aria-label="OTP digit 6" placeholder="•">
        </div>

        <div id="authSessionCluster" class="auth-session-cluster hidden">
          <div id="authSessionBadge" class="badge badge-emerald badge-mono" title="Active authenticated operator session">
            <span class="badge-dot"></span>
            <span id="authSessionText">KEY: Active</span>
          </div>
          <button id="btnLogoutApiKey" type="button" class="btn" title="Log out of dashboard session">
            <span class="icon-swap-slot icon-swap-in">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                <polyline points="16 17 21 12 16 7"></polyline>
                <line x1="21" y1="12" x2="9" y2="12"></line>
              </svg>
            </span>
            <span class="btn-label">Log Out</span>
          </button>
        </div>
        <button id="btnGenerateApiKey" type="button" class="btn" title="Generate and manage client API keys for agents">
          <span class="icon-swap-slot icon-swap-in">
            <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <circle cx="7.5" cy="15.5" r="4.5"></circle>
              <path d="m21 2-9.6 9.6"></path>
              <path d="m15.5 7.5 3 3L22 7l-3-3"></path>
            </svg>
          </span>
          <span class="btn-label">+ Generate API Key</span>
        </button>
        <button id="btnDrainEmbed" type="button" class="btn" title="Drain pending live embeddings into Qdrant">
          <span class="icon-swap-slot icon-swap-in">
            <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M12 3v12"></path>
              <path d="m7 10 5 5 5-5"></path>
              <path d="M5 21h14"></path>
            </svg>
          </span>
          <span class="btn-label">Drain Embed Queue</span>
        </button>
        <button id="btnCleanup" type="button" class="btn" title="Run 30-day archive and 90-day delete retention pass">
          <span class="icon-swap-slot icon-swap-in">
            <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </span>
          <span class="btn-label">Run Retention Cleanup</span>
        </button>
        <button id="btnRefresh" type="button" class="btn" title="Refresh all telemetry and counts">
          <span class="icon-swap-slot icon-swap-in">
            <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
              <path d="M21 3v6h-6"></path>
            </svg>
          </span>
          <span class="btn-label">Refresh Data</span>
        </button>
      </div>
    </div>
  </header>

  <!-- Navigation Tabs Bar -->
  <nav class="nav-tabs-bar" aria-label="Dashboard Sections">
    <div class="nav-tabs-container" role="tablist" aria-label="Dashboard Sections">
      <button id="tabBtnOverview" type="button" role="tab" aria-selected="true" aria-controls="paneOverview" class="nav-tab-btn active" data-tab="overview" title="Overview & Memory Layers (⌘1)">
        <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <rect x="3" y="3" width="7" height="9" rx="1"></rect>
          <rect x="14" y="3" width="7" height="5" rx="1"></rect>
          <rect x="14" y="12" width="7" height="9" rx="1"></rect>
          <rect x="3" y="16" width="7" height="5" rx="1"></rect>
        </svg>
        <span>Overview</span>
      </button>
      <button id="tabBtnNotes" type="button" role="tab" aria-selected="false" aria-controls="paneNotes" class="nav-tab-btn" data-tab="notes" title="Notes Explorer & Repair Queue (⌘2)">
        <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"></path>
          <polyline points="10 2 10 10 13 7 16 10 16 2"></polyline>
        </svg>
        <span>Long Term</span>
        <span id="repairQueueBadge" class="tab-badge">0</span>
      </button>
      <button id="tabBtnShortTerm" type="button" role="tab" aria-selected="false" aria-controls="paneShortTerm" class="nav-tab-btn" data-tab="shortTerm" title="Active Sessions & Next Actions (⌘3)">
        <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
        <span>Short Term</span>
      </button>
      <button id="tabBtnTrajectories" type="button" role="tab" aria-selected="false" aria-controls="paneTrajectories" class="nav-tab-btn" data-tab="trajectories" title="Trajectories, Observations, Summaries & Session Replay (⌘4)">
        <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>
        </svg>
        <span>Observations</span>
      </button>
      <button id="tabBtnGraph" type="button" role="tab" aria-selected="false" aria-controls="paneGraph" class="nav-tab-btn" data-tab="graph" title="Knowledge Graph Explorer (⌘5)">
        <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <circle cx="18" cy="5" r="3"></circle>
          <circle cx="6" cy="12" r="3"></circle>
          <circle cx="18" cy="19" r="3"></circle>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
        </svg>
        <span>Graph</span>
      </button>
      <button id="tabBtnSearch" type="button" role="tab" aria-selected="false" aria-controls="paneSearch" class="nav-tab-btn" data-tab="search" title="Hybrid Search & Push Injection (⌘6)">
        <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.3-4.3"></path>
        </svg>
        <span>Search &amp; Inject</span>
      </button>
      <button id="tabBtnConformance" type="button" role="tab" aria-selected="false" aria-controls="paneConformance" class="nav-tab-btn" data-tab="conformance" title="Failure Patterns, Dead Letters & AI Conformance Doctor (⌘7)">
        <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"></path>
          <path d="m9 12 2 2 4-4"></path>
        </svg>
        <span>System &amp; AI</span>
      </button>
    </div>
  </nav>

  <!-- Main Application Body -->
  <main class="app-main">
    <!-- Tab 1: Overview & Memory Layers -->
    <section id="paneOverview" class="tab-pane active" role="tabpanel" aria-labelledby="tabBtnOverview">
      <div id="overviewKpiGrid" class="kpi-grid"></div>

      <!-- Scope Breakdown (Rule 4 Visualization) -->
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"></path>
              </svg>
              Scope Separation &amp; Rule 4 Telemetry
            </h2>
            <div class="card-subtitle">Explicit scope, never inferred — and "global" is not "unknown"</div>
          </div>
          <button id="btnScopeGoRepair" type="button" class="btn">
            <span class="icon-swap-slot icon-swap-in">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
              </svg>
            </span>
            <span class="btn-label">Inspect Repair Queue</span>
          </button>
        </div>
        <div class="scope-bar-container">
          <div id="scopeProgressBar" class="scope-bar"></div>
          <div class="scope-legend">
            <div class="scope-legend-item">
              <span class="badge-dot dot-emerald"></span>
              <span>Project Scoped (<strong id="legendCountProject" class="tabular-nums">0</strong>)</span>
            </div>
            <div class="scope-legend-item">
              <span class="badge-dot dot-cyan"></span>
              <span>Global Scoped (<strong id="legendCountGlobal" class="tabular-nums">0</strong>)</span>
            </div>
            <div class="scope-legend-item">
              <span class="badge-dot dot-rose"></span>
              <span>Unknown Scoped — Repair Queue (<strong id="legendCountUnknown" class="tabular-nums">0</strong>)</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Type Taxonomy Distribution & Spool Telemetry -->
      <div class="telemetry-grid">
        <div class="card">
          <div class="card-header">
            <div>
              <h2 class="card-title">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <line x1="18" y1="20" x2="18" y2="10"></line>
                  <line x1="12" y1="20" x2="12" y2="4"></line>
                  <line x1="6" y1="20" x2="6" y2="14"></line>
                </svg>
                Note Type Distribution
              </h2>
              <div class="card-subtitle">Taxonomy from live memory corpus</div>
            </div>
          </div>
          <div id="typeDistributionContainer"></div>
        </div>

        <div class="card">
          <div class="card-header">
            <div>
              <h2 class="card-title">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <line x1="22" y1="12" x2="2" y2="12"></line>
                  <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
                  <line x1="6" y1="16" x2="6.01" y2="16"></line>
                  <line x1="10" y1="16" x2="10.01" y2="16"></line>
                </svg>
                Client Spool Telemetry
              </h2>
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
            <h2 class="card-title">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path>
              </svg>
              Discovered Projects Breakdown
            </h2>
            <div class="card-subtitle">Multi-tenant memory layers partitioned across notes, trajectories, and observations</div>
          </div>
        </div>
        <div id="projectsTableContainer" class="table-responsive"></div>
      </div>
    </section>

    <!-- Tab 2: Hybrid Search & Push Injection Workbench -->
    <section id="paneSearch" class="tab-pane" role="tabpanel" aria-labelledby="tabBtnSearch">
      <div class="workbench-grid">
        <!-- Hybrid Search Column -->
        <div class="card">
          <div class="card-header">
            <div>
              <h2 class="card-title">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <circle cx="11" cy="11" r="8"></circle>
                  <path d="m21 21-4.3-4.3"></path>
                </svg>
                Hybrid Retrieval (Dense + BM25 with RRF)
              </h2>
              <div class="card-subtitle">POST /search — Vector similarity plus full-text keyword ranking</div>
            </div>
          </div>

          <form id="searchForm">
            <div class="search-form-grid">
              <input id="searchInputQ" type="text" class="form-input flex-1" placeholder="Search query (e.g., 'foreign key constraint failed' or 'docker')..." aria-label="Search query" required>
              <button id="btnExecuteSearch" type="button" class="btn btn-primary">
                <span class="icon-swap-slot icon-swap-in">
                  <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                    <circle cx="11" cy="11" r="8"></circle>
                    <path d="m21 21-4.3-4.3"></path>
                  </svg>
                </span>
                <span class="btn-label">Search Brain</span>
              </button>
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
                  <span id="searchProjectDropdownToggle" class="dropdown-chevron" role="button" tabindex="0" aria-label="Toggle project dropdown" aria-expanded="false" title="Toggle project dropdown">▼</span>
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

              <label class="checkbox-label">
                <input id="searchCheckAncestors" type="checkbox" checked>
                <span>include_ancestors</span>
              </label>

              <label class="checkbox-label">
                <input id="searchCheckChildren" type="checkbox">
                <span>include_children</span>
              </label>

              <label class="checkbox-label">
                <input id="searchCheckHistory" type="checkbox">
                <span>include_history</span>
              </label>

              <div class="form-row-inline">
                <label for="searchInputUserId" class="text-muted form-label-inline">USER:</label>
                <input id="searchInputUserId" type="text" class="form-input input-w-130" placeholder="user_id">
              </div>

              <div class="form-row-inline">
                <label for="searchInputAfter" class="text-muted form-label-inline">AFTER:</label>
                <input id="searchInputAfter" type="text" class="form-input input-w-150" placeholder="ISO date (UTC)">
              </div>

              <div class="form-row-inline">
                <label for="searchInputBefore" class="text-muted form-label-inline">BEFORE:</label>
                <input id="searchInputBefore" type="text" class="form-input input-w-150" placeholder="ISO date (UTC)">
              </div>

              <div class="form-row-inline">
                <label for="searchSelectTemporalBias" class="text-muted form-label-inline">TEMPORAL BIAS:</label>
                <select id="searchSelectTemporalBias" class="form-select input-w-130">
                  <option value="none" selected>none</option>
                  <option value="recent">recent</option>
                  <option value="upcoming">upcoming</option>
                </select>
              </div>
            </div>

            <div class="record-types-selection-bar">
              <span class="text-muted form-label-inline">RECORD TYPES:</span>
              <label class="checkbox-label"><input type="checkbox" id="recordTypeCheckNote" checked> note</label>
              <label class="checkbox-label"><input type="checkbox" id="recordTypeCheckTrajectory" checked> trajectory</label>
              <label class="checkbox-label"><input type="checkbox" id="recordTypeCheckObservation" checked> observation</label>
              <label class="checkbox-label"><input type="checkbox" id="recordTypeCheckSummary" checked> summary</label>
              <label class="checkbox-label"><input type="checkbox" id="recordTypeCheckEntity" checked> entity</label>
              <label class="checkbox-label"><input type="checkbox" id="recordTypeCheckAction" checked> action</label>
            </div>
          </form>

          <div id="searchMetaBar" class="search-meta-bar"></div>
          <div id="searchResultsContainer"></div>
        </div>

        <!-- Push Injection Preview Column -->
        <div class="card">
          <div class="card-header">
            <div>
              <h2 class="card-title">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                </svg>
                Task-Start Push Injection Simulator
              </h2>
              <div class="card-subtitle">GET /inject — Proactive context delivered to coding agents before task execution</div>
            </div>
          </div>

          <form id="injectForm">
            <div class="control-row mb-4">
              <div id="injectProjectDropdownWrapper" class="searchable-dropdown flex-1">
                <input id="injectInputProject" type="text" class="form-input input-w-full-pr" placeholder="Project ID (e.g. acme/socials/calendar, example-app)..." value="example-app" aria-label="Project ID for injection simulation" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false">
                <span id="injectProjectDropdownToggle" class="dropdown-chevron" role="button" tabindex="0" aria-label="Toggle project dropdown" aria-expanded="false" title="Toggle project dropdown">▼</span>
                <div id="injectProjectDropdownMenu" class="dropdown-menu"></div>
              </div>
              <select id="injectInputTaskType" class="form-select input-w-170" aria-label="Task type filter" title="Filter failure patterns and push injection by task type">
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
              <button id="btnExecuteInject" type="button" class="btn">
                <span class="icon-swap-slot icon-swap-in">
                  <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                  </svg>
                </span>
                <span class="btn-label">Simulate Task-Start Injection</span>
              </button>
            </div>
            <div class="filter-bar">
              <label class="checkbox-label">
                <input id="injectCheckAncestors" type="checkbox" checked>
                <span>include_ancestors</span>
              </label>
              <label class="checkbox-label">
                <input id="injectCheckChildren" type="checkbox">
                <span>include_children</span>
              </label>
              <div class="form-row-inline">
                <label for="injectInputUserId" class="text-muted form-label-inline">USER:</label>
                <input id="injectInputUserId" type="text" class="form-input input-w-130" placeholder="user_id">
              </div>
            </div>
          </form>

          <div id="injectOutputContainer"></div>
        </div>
      </div>
    </section>

    <!-- Tab 3: Notes Explorer & Repair Queue -->
    <section id="paneNotes" class="tab-pane" role="tabpanel" aria-labelledby="tabBtnNotes">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
              </svg>
              Notes Explorer &amp; Scope Repair Queue
            </h2>
            <div class="card-subtitle">Long-Term Memory (Curated Notes &amp; Lessons) — Rule 4 explicit scope enforcement &amp; SQL repair</div>
          </div>
          <div class="control-row">
            <button id="btnOpenCreateNoteModal" type="button" class="btn btn-primary">
              <span class="icon-swap-slot icon-swap-in">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <path d="M12 5v14"></path>
                  <path d="M5 12h14"></path>
                </svg>
              </span>
              <span class="btn-label">Create Note</span>
            </button>
          </div>
        </div>

        <!-- Long-Term Category Filter Pills -->
        <div id="notesCategoryPills" class="subtabs-bar" role="group" aria-label="Long-term memory categories">
          <button id="btnNotesPillAll" type="button" class="btn btn-primary" data-note-category="all" aria-pressed="true">All</button>
          <button id="btnNotesPillMemories" type="button" class="btn" data-note-category="memories" aria-pressed="false">Memories</button>
          <button id="btnNotesPillLessons" type="button" class="btn" data-note-category="lessons" aria-pressed="false">Lessons</button>
          <button id="btnNotesPillUnknown" type="button" class="btn" data-note-category="unknown" aria-pressed="false">Unknown Scope</button>
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
              <span id="notesProjectDropdownToggle" class="dropdown-chevron" role="button" tabindex="0" aria-label="Toggle project dropdown" aria-expanded="false" title="Toggle project dropdown">▼</span>
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

          <label class="checkbox-label">
            <input id="notesCheckAncestors" type="checkbox" checked>
            <span>include_ancestors</span>
          </label>

          <label class="checkbox-label">
            <input id="notesCheckChildren" type="checkbox">
            <span>include_children</span>
          </label>

          <div class="form-row-inline">
            <label for="notesInputUserId" class="text-muted form-label-inline">USER:</label>
            <input id="notesInputUserId" type="text" class="form-input input-w-130" placeholder="user_id">
          </div>

          <button id="btnApplyNotesFilter" type="button" class="btn">
            <span class="icon-swap-slot icon-swap-in">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
              </svg>
            </span>
            <span class="btn-label">Filter</span>
          </button>
          <button id="btnShowRepairQueue" type="button" class="btn">
            <span class="icon-swap-slot icon-swap-in">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
              </svg>
            </span>
            <span class="btn-label">Show Repair Queue Only</span>
          </button>
        </div>

        <div id="repairBannerContainer"></div>
        <div id="notesListContainer"></div>
      </div>
    </section>

    <!-- Tab: Short Term (Sessions & Next Actions) -->
    <section id="paneShortTerm" class="tab-pane" role="tabpanel" aria-labelledby="tabBtnShortTerm">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              Short-Term Memory: Sessions &amp; Next Actions
            </h2>
            <div class="card-subtitle">Active cross-agent sessions, session replay timelines, and prioritized next actions</div>
          </div>
        </div>

        <div class="subtabs-bar" role="tablist" aria-label="Short Term Views">
          <button id="subTabBtnShortSessions" type="button" role="tab" aria-selected="true" class="btn btn-primary" data-short-subtab="sessions">
            <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <polyline points="4 17 10 11 4 5"></polyline>
              <line x1="12" y1="19" x2="20" y2="19"></line>
            </svg>
            <span>Sessions</span>
          </button>
          <button id="subTabBtnShortActions" type="button" role="tab" aria-selected="false" class="btn" data-short-subtab="actions">
            <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <polyline points="9 11 12 14 22 4"></polyline>
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
            </svg>
            <span>Next Actions</span>
          </button>
          <button id="subTabBtnShortSummaries" type="button" role="tab" aria-selected="false" class="btn" data-short-subtab="summaries">
            <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <path d="m9 15 2 2 4-4"></path>
            </svg>
            <span>Summaries</span>
          </button>
        </div>

        <div id="shortSessionsFilterBar" class="filter-bar">
          <div class="form-row-inline">
            <label for="shortSessionsProject" class="text-muted form-label-inline">PROJECT:</label>
            <div id="shortSessionsProjectDropdownWrapper" class="searchable-dropdown">
              <input id="shortSessionsProject" type="text" class="form-input input-w-170-pr" placeholder="All Projects..." autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false">
              <span id="shortSessionsProjectDropdownToggle" class="dropdown-chevron" role="button" tabindex="0" aria-label="Toggle project dropdown" aria-expanded="false" title="Toggle project dropdown">▼</span>
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
          <label class="checkbox-label">
            <input id="shortSessionsCheckAncestors" type="checkbox" checked>
            <span>include_ancestors</span>
          </label>
          <label class="checkbox-label">
            <input id="shortSessionsCheckChildren" type="checkbox">
            <span>include_children</span>
          </label>
          <div class="form-row-inline">
            <label for="shortSessionsInputUserId" class="text-muted form-label-inline">USER:</label>
            <input id="shortSessionsInputUserId" type="text" class="form-input input-w-130" placeholder="user_id">
          </div>
          <button id="btnFilterShortSessions" type="button" class="btn">
            <span class="icon-swap-slot icon-swap-in">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
                <path d="M21 3v6h-6"></path>
              </svg>
            </span>
            <span class="btn-label">Refresh Sessions</span>
          </button>
        </div>

        <div id="shortActionsFilterBar" class="filter-bar hidden">
          <div class="form-row-inline">
            <label for="shortActionsProject" class="text-muted form-label-inline">PROJECT:</label>
            <div id="shortActionsProjectDropdownWrapper" class="searchable-dropdown">
              <input id="shortActionsProject" type="text" class="form-input input-w-170-pr" placeholder="All Projects..." autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false">
              <span id="shortActionsProjectDropdownToggle" class="dropdown-chevron" role="button" tabindex="0" aria-label="Toggle project dropdown" aria-expanded="false" title="Toggle project dropdown">▼</span>
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
          <label class="checkbox-label">
            <input id="shortActionsCheckAncestors" type="checkbox" checked>
            <span>include_ancestors</span>
          </label>
          <label class="checkbox-label">
            <input id="shortActionsCheckChildren" type="checkbox">
            <span>include_children</span>
          </label>
          <label class="checkbox-label">
            <input id="shortActionsCheckDueOnly" type="checkbox">
            <span>due_only</span>
          </label>
          <div class="form-row-inline">
            <label for="shortActionsInputUserId" class="text-muted form-label-inline">USER:</label>
            <input id="shortActionsInputUserId" type="text" class="form-input input-w-130" placeholder="user_id">
          </div>
          <button id="btnFilterShortActions" type="button" class="btn">
            <span class="icon-swap-slot icon-swap-in">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
                <path d="M21 3v6h-6"></path>
              </svg>
            </span>
            <span class="btn-label">Refresh Actions</span>
          </button>
          <button id="btnOpenCreateActionModal" type="button" class="btn btn-primary">
            <span class="icon-swap-slot icon-swap-in">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M12 5v14"></path>
                <path d="M5 12h14"></path>
              </svg>
            </span>
            <span class="btn-label">+ Create Action</span>
          </button>
        </div>

        <div id="shortTermListContainer"></div>
      </div>
    </section>

    <!-- Tab: Knowledge Graph -->
    <section id="paneGraph" class="tab-pane" role="tabpanel" aria-labelledby="tabBtnGraph">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <circle cx="18" cy="5" r="3"></circle>
                <circle cx="6" cy="12" r="3"></circle>
                <circle cx="18" cy="19" r="3"></circle>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
              </svg>
              Knowledge Graph
            </h2>
            <div class="card-subtitle">GET /dashboard/api/graph — Interactive relational topology across notes, lessons, concepts, files, sessions, actions, and summaries</div>
          </div>
          <div class="control-row">
            <div id="graphStatsBadge" class="badge badge-subtle badge-mono">0 nodes · 0 edges</div>
            <button id="btnOpenAddEntityModal" type="button" class="btn">
              <span class="icon-swap-slot icon-swap-in">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <path d="M12 5v14"></path>
                  <path d="M5 12h14"></path>
                </svg>
              </span>
              <span class="btn-label">+ Add Entity</span>
            </button>
            <button id="btnOpenLinkNodesModal" type="button" class="btn">
              <span class="icon-swap-slot icon-swap-in">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                </svg>
              </span>
              <span class="btn-label">+ Link Nodes</span>
            </button>
          </div>
        </div>

        <div class="filter-bar">
          <div class="form-row-inline">
            <label for="graphFilterProject" class="text-muted form-label-inline">PROJECT:</label>
            <div id="graphProjectDropdownWrapper" class="searchable-dropdown">
              <input id="graphFilterProject" type="text" class="form-input input-w-170-pr" placeholder="All Projects..." autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false">
              <span id="graphProjectDropdownToggle" class="dropdown-chevron" role="button" tabindex="0" aria-label="Toggle project dropdown" aria-expanded="false" title="Toggle project dropdown">▼</span>
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
          <div class="form-row-inline">
            <label for="graphFilterDepth" class="text-muted form-label-inline">DEPTH:</label>
            <select id="graphFilterDepth" class="form-select input-w-130">
              <option value="1" selected>1 hop</option>
              <option value="2">2 hops</option>
              <option value="3">3 hops</option>
            </select>
          </div>
          <div class="form-row-inline">
            <label for="graphFilterEntityType" class="text-muted form-label-inline">ENTITY TYPE:</label>
            <select id="graphFilterEntityType" class="form-select input-w-140">
              <option value="all" selected>All Types</option>
              <option value="brand">brand</option>
              <option value="person">person</option>
              <option value="asset">asset</option>
              <option value="metric">metric</option>
              <option value="document">document</option>
              <option value="tool">tool</option>
            </select>
          </div>
          <label class="checkbox-label">
            <input id="graphCheckAncestors" type="checkbox" checked>
            <span>include_ancestors</span>
          </label>
          <label class="checkbox-label">
            <input id="graphCheckChildren" type="checkbox">
            <span>include_children</span>
          </label>
          <label class="checkbox-label">
            <input id="graphCheckGlobal" type="checkbox">
            <span>include_global</span>
          </label>
          <button id="btnLoadGraph" type="button" class="btn btn-primary">
            <span class="icon-swap-slot icon-swap-in">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <circle cx="18" cy="5" r="3"></circle>
                <circle cx="6" cy="12" r="3"></circle>
                <circle cx="18" cy="19" r="3"></circle>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
              </svg>
            </span>
            <span class="btn-label">Load Graph</span>
          </button>
        </div>

        <div id="graphLegend" class="graph-legend"></div>

        <div class="graph-layout">
          <div id="graphCanvasContainer" class="graph-canvas-wrap"></div>
          <aside id="graphInspectorContainer" class="graph-inspector-wrap">
            <div class="graph-inspector-empty">
              <div class="carousel-card-media">
                <div class="blurhash-placeholder" data-blurhash="L6PZfSi_.AyE_3t7t7R**0o#DgR4"></div>
                <img class="product-shot blend-multiply" alt="NeuralBrain memory layers: capture to compact to recall" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='84' viewBox='0 0 320 84'%3E%3Crect width='320' height='84' fill='%23ffffff'/%3E%3Crect x='8' y='18' width='84' height='48' rx='10' fill='%23ffffff' stroke='%23111827' stroke-width='1.75'/%3E%3Ccircle cx='24' cy='36' r='5' fill='%23F59E0B'/%3E%3Ctext x='34' y='40' font-family='sans-serif' font-size='11' font-weight='700' fill='%230B0F19'%3Ecapture%3C/text%3E%3Ctext x='18' y='54' font-family='monospace' font-size='9' fill='%23111827'%3Eraw signals%3C/text%3E%3Cpath d='M96 42h14m-4-4 4 4-4 4' fill='none' stroke='%23047857' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3Crect x='116' y='18' width='88' height='48' rx='10' fill='%23ffffff' stroke='%23047857' stroke-width='1.75'/%3E%3Ccircle cx='132' cy='36' r='5' fill='%23047857'/%3E%3Ctext x='142' y='40' font-family='sans-serif' font-size='11' font-weight='700' fill='%230B0F19'%3Ecompact%3C/text%3E%3Ctext x='126' y='54' font-family='monospace' font-size='9' fill='%23111827'%3Esourced notes%3C/text%3E%3Cpath d='M208 42h14m-4-4 4 4-4 4' fill='none' stroke='%2310B981' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3Crect x='228' y='18' width='84' height='48' rx='10' fill='%23ffffff' stroke='%2310B981' stroke-width='2'/%3E%3Ccircle cx='244' cy='36' r='5' fill='%2310B981'/%3E%3Ctext x='254' y='40' font-family='sans-serif' font-size='11' font-weight='700' fill='%230B0F19'%3Erecall%3C/text%3E%3Ctext x='238' y='54' font-family='monospace' font-size='9' fill='%23111827'%3Eaudit trail%3C/text%3E%3C/svg%3E">
              </div>
              <div class="graph-inspector-caption">Click any node in the graph to inspect its metadata, provenance, and connections.</div>
            </div>
          </aside>
        </div>
      </div>
    </section>

    <!-- Tab 4: Trajectories & Observations -->
    <section id="paneTrajectories" class="tab-pane" role="tabpanel" aria-labelledby="tabBtnTrajectories">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>
              </svg>
              Observations, Trajectories &amp; Summaries
            </h2>
            <div class="card-subtitle">Machine-written high-volume observations rolled up into trajectories and verified summaries</div>
          </div>
          <div class="control-row">
            <button id="btnOpenCaptureModal" type="button" class="btn">
              <span class="icon-swap-slot icon-swap-in">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <path d="M12 5v14"></path>
                  <path d="M5 12h14"></path>
                </svg>
              </span>
              <span class="btn-label">Capture Test Event</span>
            </button>
          </div>
        </div>

        <div class="subtabs-bar" role="tablist" aria-label="Observation Views">
          <button id="subTabBtnTrajectories" type="button" role="tab" aria-selected="true" class="btn btn-primary" data-subtab="trajectories">
            <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <line x1="6" y1="3" x2="6" y2="15"></line>
              <circle cx="18" cy="6" r="3"></circle>
              <circle cx="6" cy="18" r="3"></circle>
              <path d="M18 9a9 9 0 0 1-9 9"></path>
            </svg>
            <span>Trajectories</span>
          </button>
          <button id="subTabBtnObservations" type="button" role="tab" aria-selected="false" class="btn" data-subtab="observations">
            <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
            <span>Observations</span>
          </button>
          <button id="subTabBtnSummaries" type="button" role="tab" aria-selected="false" class="btn" data-subtab="summaries">
            <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
              <polyline points="2 17 12 22 22 17"></polyline>
              <polyline points="2 12 12 17 22 12"></polyline>
            </svg>
            <span>Summaries</span>
          </button>
        </div>

        <div id="trajectoriesSubViewContainer"></div>
      </div>
    </section>

    <!-- Tab 5: Failure Patterns & Conformance Doctor -->
    <section id="paneConformance" class="tab-pane" role="tabpanel" aria-labelledby="tabBtnConformance">
      <!-- AI Conformance Doctor -->
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"></path>
                <path d="m9 12 2 2 4-4"></path>
              </svg>
              AI Conformance Doctor
            </h2>
            <div class="card-subtitle">GET /diagnostics/ai — Non-negotiable verification gate fixtures (fx1-failure, fx2-success, fx3-sparse)</div>
          </div>
          <button id="btnRunConformance" type="button" class="btn btn-primary">
            <span class="icon-swap-slot icon-swap-in">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
            </span>
            <span class="btn-label">Run Conformance Fixtures</span>
          </button>
        </div>
        <div id="conformanceVerdictContainer"></div>
        <div id="conformanceResultsContainer" class="table-responsive"></div>
      </div>

      <!-- Failure Patterns Table -->
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              Push-Injection Scoped Failure Patterns
            </h2>
            <div class="card-subtitle">Grouped by (project_id, task_type, error_text) with atomic SQL UPSERT counter</div>
          </div>
        </div>
        <div id="failurePatternsContainer" class="table-responsive"></div>
      </div>

      <!-- Dead Letters Inspector -->
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline>
                <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
              </svg>
              Dead Letters Inspector
            </h2>
            <div class="card-subtitle">Rule 3 guarantee: Dead letters are strictly for malformed records, never for capacity or volume</div>
          </div>
        </div>
        <div id="deadLettersBreakdownContainer" class="dead-letters-breakdown"></div>
        <div id="deadLettersContainer" class="table-responsive"></div>
      </div>
    </section>
  </main>

  <!-- Predictive Back Gesture Preview -->
  <div id="predictiveBackPreview" class="predictive-back-preview" aria-hidden="true"></div>

  <!-- Command Menu Palette (⌘K) -->
  <div id="commandMenuOverlay" class="command-menu-overlay" role="dialog" aria-modal="true" aria-label="Command Menu" aria-hidden="true">
    <div class="command-menu-dialog">
      <div class="command-menu-input-row">
        <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.3-4.3"></path>
        </svg>
        <input id="commandMenuInput" type="text" class="command-menu-input" placeholder="Type a command or search (e.g. 'dep' for Deploy to production)..." aria-label="Search commands" autocomplete="off">
        <kbd class="shortcut-hint">ESC</kbd>
      </div>
      <div id="commandMenuList" class="command-menu-list" role="listbox" aria-label="Commands"></div>
    </div>
  </div>

  <!-- Modal Overlays (Swipe-to-Dismiss Sheets) -->
  <div id="modalContainer" class="modal-overlay" role="dialog" aria-modal="true" aria-label="Modal dialog" aria-hidden="true"></div>

  <!-- Toasts Container -->
  <div id="toastContainer" class="toast-container" aria-live="polite" aria-atomic="false"></div>
</body>
</html>`;
}
