export const dashboardCss = `
/* Neuralbrain - Operator Command Center Stylesheet */
:root {
  --bg-base: #070a12;
  --bg-primary: #0b0f19;
  --bg-card: #111827;
  --bg-card-hover: #162032;
  --bg-subtle: #1e293b;
  --bg-input: #0e1422;
  --border-color: #1e293b;
  --border-subtle: #283548;
  --border-focus: #38bdf8;
  --text-primary: #f8fafc;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
  --accent-emerald: #10b981;
  --accent-emerald-bg: rgba(16, 185, 129, 0.12);
  --accent-emerald-border: rgba(16, 185, 129, 0.35);
  --accent-amber: #f59e0b;
  --accent-amber-bg: rgba(245, 158, 11, 0.12);
  --accent-amber-border: rgba(245, 158, 11, 0.35);
  --accent-rose: #f43f5e;
  --accent-rose-bg: rgba(244, 63, 94, 0.12);
  --accent-rose-border: rgba(244, 63, 94, 0.35);
  --accent-cyan: #38bdf8;
  --accent-cyan-bg: rgba(56, 189, 248, 0.12);
  --accent-cyan-border: rgba(56, 189, 248, 0.35);
  --accent-purple: #a855f7;
  --accent-purple-bg: rgba(168, 85, 247, 0.12);
  --accent-purple-border: rgba(168, 85, 247, 0.35);
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  --control-height: 38px;
  --control-radius: 8px;
  --control-padding: 0 14px;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  background-color: var(--bg-base);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}

/* App Header & Top Navigation */
.app-header {
  background-color: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
  position: sticky;
  top: 0;
  z-index: 100;
  backdrop-filter: blur(8px);
}

.header-inner {
  max-width: 1540px;
  margin: 0 auto;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.brand-section {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand-logo {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: linear-gradient(135deg, #0284c7, #38bdf8, #10b981);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  font-size: 17px;
  color: #fff;
  box-shadow: 0 0 12px rgba(56, 189, 248, 0.35);
}

.brand-info {
  display: flex;
  flex-direction: column;
}

.brand-title {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #ffffff;
  display: flex;
  align-items: center;
  gap: 8px;
}

.brand-subtitle {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
}

.header-status-cluster {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* Warning Banner */
.warning-banner {
  background-color: rgba(244, 63, 94, 0.15);
  border-bottom: 1px solid var(--accent-rose-border);
  color: #fecdd3;
  padding: 12px 24px;
  display: none;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  animation: pulse-border 2s infinite ease-in-out;
}

.warning-banner.visible {
  display: flex;
}

.warning-banner-text {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 500;
}

.warning-banner-text strong {
  color: #fff;
}

/* Navigation Tabs */
.nav-tabs-bar {
  background-color: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
}

.nav-tabs-container {
  max-width: 1540px;
  margin: 0 auto;
  padding: 0 24px;
  display: flex;
  gap: 4px;
  overflow-x: auto;
}

.nav-tab-btn {
  height: 44px;
  padding: 0 16px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease-in-out;
}

.nav-tab-btn:hover {
  color: var(--text-primary);
  border-bottom-color: var(--border-subtle);
  background-color: rgba(255, 255, 255, 0.02);
}

.nav-tab-btn.active {
  color: var(--accent-cyan);
  border-bottom-color: var(--accent-cyan);
}

.tab-badge {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 12px;
  background-color: var(--bg-subtle);
  color: var(--text-secondary);
  font-family: var(--font-mono);
}

.nav-tab-btn.active .tab-badge {
  background-color: var(--accent-cyan-bg);
  color: var(--accent-cyan);
  border: 1px solid var(--accent-cyan-border);
}

/* Main Layout */
.app-main {
  max-width: 1540px;
  margin: 0 auto;
  padding: 24px;
}

.tab-pane {
  display: none;
}

.tab-pane.active {
  display: block;
}

/* Common UI Elements: Consistency Rule */
.btn {
  height: var(--control-height);
  padding: var(--control-padding);
  border-radius: var(--control-radius);
  font-size: 13px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  cursor: pointer;
  border: 1px solid var(--border-color);
  background-color: var(--bg-subtle);
  color: var(--text-primary);
  text-decoration: none;
  white-space: nowrap;
  box-sizing: border-box;
  transition: all 0.15s ease-in-out;
}

.btn:hover {
  background-color: var(--bg-card-hover);
  border-color: var(--border-subtle);
  color: #ffffff;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background-color: #0284c7;
  border-color: #0369a1;
  color: #ffffff;
}

.btn-primary:hover {
  background-color: #0369a1;
  border-color: #0284c7;
}

.btn-emerald {
  background-color: var(--accent-emerald-bg);
  border-color: var(--accent-emerald-border);
  color: #6ee7b7;
}

.btn-emerald:hover {
  background-color: rgba(16, 185, 129, 0.25);
  color: #a7f3d0;
}

.btn-amber {
  background-color: var(--accent-amber-bg);
  border-color: var(--accent-amber-border);
  color: #fcd34d;
}

.btn-amber:hover {
  background-color: rgba(245, 158, 11, 0.25);
  color: #fde68a;
}

.btn-rose {
  background-color: var(--accent-rose-bg);
  border-color: var(--accent-rose-border);
  color: #fda4af;
}

.btn-rose:hover {
  background-color: rgba(244, 63, 94, 0.25);
  color: #fecdd3;
}

.form-input,
.form-select {
  height: var(--control-height);
  padding: var(--control-padding);
  border-radius: var(--control-radius);
  background-color: var(--bg-input);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  font-size: 13px;
  font-family: var(--font-sans);
  box-sizing: border-box;
  transition: border-color 0.15s ease-in-out, box-shadow 0.15s ease-in-out;
}

.form-select {
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  padding-right: 28px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%2394a3b8' d='M0 0l5 5 5-5z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
}

.form-select option {
  background-color: var(--bg-card);
  color: var(--text-primary);
}

.form-input:focus,
.form-select:focus {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
}

.form-textarea {
  padding: 10px 14px;
  border-radius: var(--control-radius);
  background-color: var(--bg-input);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  font-size: 13px;
  font-family: var(--font-mono);
  box-sizing: border-box;
  resize: vertical;
  min-height: 80px;
  width: 100%;
  transition: border-color 0.15s ease-in-out;
}

.form-textarea:focus {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
}

/* Control Group for Siblings */
.control-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* Pills & Badges */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 9999px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid transparent;
  white-space: nowrap;
}

.badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.badge-emerald {
  background-color: var(--accent-emerald-bg);
  border-color: var(--accent-emerald-border);
  color: #34d399;
}
.badge-emerald .badge-dot { background-color: #34d399; }

.badge-amber {
  background-color: var(--accent-amber-bg);
  border-color: var(--accent-amber-border);
  color: #fbbf24;
}
.badge-amber .badge-dot { background-color: #fbbf24; }

.badge-rose {
  background-color: var(--accent-rose-bg);
  border-color: var(--accent-rose-border);
  color: #fb7185;
}
.badge-rose .badge-dot { background-color: #fb7185; }

.badge-cyan {
  background-color: var(--accent-cyan-bg);
  border-color: var(--accent-cyan-border);
  color: #38bdf8;
}
.badge-cyan .badge-dot { background-color: #38bdf8; }

.badge-purple {
  background-color: var(--accent-purple-bg);
  border-color: var(--accent-purple-border);
  color: #c084fc;
}
.badge-purple .badge-dot { background-color: #c084fc; }

.badge-subtle {
  background-color: var(--bg-subtle);
  border-color: var(--border-subtle);
  color: var(--text-secondary);
}

.badge-mono {
  font-family: var(--font-mono);
  font-size: 11px;
}

/* Cards & Section Containers */
.card {
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
  transition: border-color 0.15s ease-in-out;
}

.card:hover {
  border-color: var(--border-subtle);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  flex-wrap: wrap;
  gap: 12px;
}

.card-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-subtitle {
  font-size: 12px;
  color: var(--text-muted);
}

/* KPI Cards Grid */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.kpi-card {
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  transition: transform 0.15s ease, border-color 0.15s ease;
}

.kpi-card:hover {
  border-color: var(--border-subtle);
  background-color: var(--bg-card-hover);
}

.kpi-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.kpi-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.kpi-value {
  font-size: 28px;
  font-weight: 800;
  color: #ffffff;
  font-family: var(--font-mono);
  line-height: 1.1;
  margin-bottom: 12px;
}

.kpi-breakdown {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  border-top: 1px solid var(--border-color);
  padding-top: 10px;
  font-size: 11px;
  color: var(--text-muted);
}

/* Visual Progress & Breakdown Bar */
.scope-bar-container {
  margin: 16px 0;
}

.scope-bar {
  display: flex;
  height: 18px;
  border-radius: 9px;
  overflow: hidden;
  background-color: var(--bg-subtle);
  border: 1px solid var(--border-color);
}

.scope-bar-segment {
  height: 100%;
  transition: width 0.3s ease;
}

.scope-bar-project { background-color: var(--accent-emerald); }
.scope-bar-global { background-color: var(--accent-cyan); }
.scope-bar-unknown { background-color: var(--accent-rose); }

.scope-legend {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-top: 10px;
  flex-wrap: wrap;
  font-size: 12px;
}

.scope-legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Tables */
.table-responsive {
  overflow-x: auto;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: 13px;
}

.data-table th {
  background-color: var(--bg-subtle);
  color: var(--text-secondary);
  font-weight: 600;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  white-space: nowrap;
}

.data-table td {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-color);
  color: var(--text-primary);
  vertical-align: middle;
}

.data-table tr:last-child td {
  border-bottom: none;
}

.data-table tr:hover td {
  background-color: rgba(255, 255, 255, 0.02);
}

/* Code & Pre */
.code-block {
  background-color: var(--bg-base);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px 16px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: #e2e8f0;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.code-pill {
  font-family: var(--font-mono);
  font-size: 11px;
  background-color: var(--bg-subtle);
  border: 1px solid var(--border-color);
  padding: 2px 6px;
  border-radius: 4px;
  color: #cbd5e1;
}

/* Search & Filter Workbench */
.search-form-grid {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px;
  margin-bottom: 16px;
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
  background-color: var(--bg-subtle);
  border-radius: 8px;
  margin-bottom: 16px;
}

.checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
  font-size: 13px;
  color: var(--text-secondary);
}

.checkbox-label:hover {
  color: var(--text-primary);
}

.checkbox-label input[type="checkbox"] {
  accent-color: #0284c7;
  cursor: pointer;
}

/* Result Cards */
.result-card {
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 12px;
  transition: border-color 0.15s ease;
}

.result-card:hover {
  border-color: var(--border-subtle);
}

.result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.result-score {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--accent-cyan);
  font-weight: 700;
}

.result-title {
  font-size: 14px;
  font-weight: 700;
  color: #ffffff;
  margin-bottom: 6px;
}

.result-body {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: 10px;
}

.tag-list {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

/* Toasts Container */
.toast-container {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  min-width: 300px;
  max-width: 460px;
  background-color: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 14px 18px;
  color: var(--text-primary);
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
  animation: slide-in 0.2s ease-out;
}

.toast-emerald {
  border-left: 4px solid var(--accent-emerald);
}

.toast-amber {
  border-left: 4px solid var(--accent-amber);
}

.toast-rose {
  border-left: 4px solid var(--accent-rose);
}

.toast-cyan {
  border-left: 4px solid var(--accent-cyan);
}

.toast-close-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 16px;
  padding: 2px 6px;
  border-radius: 4px;
}

.toast-close-btn:hover {
  color: #fff;
  background-color: var(--bg-subtle);
}

/* Modal Dialog */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
  z-index: 500;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.modal-overlay.open {
  display: flex;
}

.hidden {
  display: none !important;
}

.modal-dialog {
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  width: 100%;
  max-width: 650px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
  animation: modal-pop 0.15s ease-out;
}

.modal-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-title {
  font-size: 16px;
  font-weight: 700;
}

.modal-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.modal-footer {
  padding: 16px 20px;
  border-top: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

/* Animations */
@keyframes slide-in {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@keyframes modal-pop {
  from {
    transform: scale(0.95);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

@keyframes pulse-border {
  0% { border-color: rgba(244, 63, 94, 0.35); }
  50% { border-color: rgba(244, 63, 94, 0.8); }
  100% { border-color: rgba(244, 63, 94, 0.35); }
}

/* Searchable Dropdown / Combobox (Notes Explorer) */
.searchable-dropdown {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.searchable-dropdown.flex-1 {
  flex: 1;
  display: flex;
}

.searchable-dropdown.flex-1 input {
  width: 100%;
}

.searchable-dropdown input::-webkit-calendar-picker-indicator {
  display: none !important;
  opacity: 0 !important;
  -webkit-appearance: none;
}

.searchable-dropdown .dropdown-chevron {
  position: absolute;
  right: 10px;
  font-size: 10px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
  transition: color 0.15s ease, transform 0.15s ease;
  line-height: 1;
  z-index: 2;
}

.searchable-dropdown .dropdown-chevron:hover {
  color: var(--accent-cyan);
}

.searchable-dropdown.open .dropdown-chevron {
  transform: rotate(180deg);
  color: var(--accent-cyan);
}

.dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 240px;
  width: max-content;
  max-width: 340px;
  max-height: 260px;
  overflow-y: auto;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--control-radius);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
  z-index: 1000;
  display: none;
  padding: 6px 0;
}

.dropdown-menu.open {
  display: block;
}

.dropdown-item {
  padding: 8px 12px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  white-space: nowrap;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.dropdown-item:hover,
.dropdown-item.active {
  background-color: var(--bg-hover);
  color: var(--accent-cyan);
}

.dropdown-item.selected {
  font-weight: 600;
  color: var(--accent-cyan);
  background-color: rgba(56, 189, 248, 0.08);
}

.dropdown-item .text-mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dropdown-empty {
  padding: 10px 14px;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}

/* Interactive Citation Link & Badge */
.citation-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  transition: all 0.15s ease-in-out;
  text-decoration: none;
}

.citation-badge:hover {
  background-color: var(--accent-cyan-bg) !important;
  border-color: var(--accent-cyan) !important;
  color: var(--accent-cyan) !important;
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(56, 189, 248, 0.25);
}

/* Highlighted Table Row */
tr.row-highlight {
  background-color: rgba(56, 189, 248, 0.12) !important;
  border-left: 3px solid var(--accent-cyan);
  transition: background-color 0.4s ease;
}

/* Inspector Dialog Styling */
.inspector-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.inspector-field {
  background-color: var(--bg-subtle);
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
}

.inspector-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}

.inspector-value {
  font-size: 13px;
  color: var(--text-primary);
  word-break: break-all;
}

.inspector-code-block {
  background-color: var(--bg-base);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 10px 14px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin-top: 4px;
}

/* Utilities */
.flex-1 { flex: 1; }
.text-muted { color: var(--text-muted); }
.text-mono { font-family: var(--font-mono); }
.mt-4 { margin-top: 16px; }
.mb-4 { margin-bottom: 16px; }
.gap-8 { gap: 8px; }
.gap-12 { gap: 12px; }

/* Layout & Component Helpers */
.warning-icon { font-size: 18px; }
.header-auth-form { display: inline-flex; align-items: center; gap: 8px; margin: 0; padding: 0; }
.auth-session-cluster { display: inline-flex; align-items: center; gap: 8px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.input-api-key { width: 170px; }
.dot-emerald { background-color: var(--accent-emerald); }
.dot-cyan { background-color: var(--accent-cyan); }
.dot-rose { background-color: var(--accent-rose); }
.telemetry-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 20px; }
.workbench-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 24px; }
.form-row-inline { display: flex; align-items: center; gap: 8px; }
.form-label-inline { font-size: 12px; font-weight: 600; color: var(--text-muted); }
.input-w-140 { width: 140px; }
.input-w-130 { width: 130px; }
.input-w-150 { width: 150px; }
.input-w-170-pr { width: 190px; padding-right: 28px; }
.grains-selection-bar { margin-bottom: 12px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.search-meta-bar { margin-bottom: 12px; display: none; }
.subtabs-bar { display: flex; gap: 8px; margin-bottom: 16px; }
.dead-letters-breakdown { margin-bottom: 16px; }
.font-semibold { font-weight: 600; }
.badge-clear { font-size: 11px; }
.badge-count { font-size: 10px; }

/* Note Card Inline Scope Editor & Controls */
.btn-icon-edit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 6px;
  background-color: var(--bg-subtle);
  border: 1px solid var(--border-color);
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s ease-in-out;
  line-height: 1;
}

.btn-icon-edit:hover,
.btn-icon-edit.active {
  color: var(--accent-cyan);
  border-color: var(--accent-cyan);
  background-color: rgba(56, 189, 248, 0.12);
  transform: translateY(-1px);
}

.scope-repair-widget {
  padding-top: 12px;
  border-top: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.scope-repair-widget.hidden {
  display: none !important;
}

.input-w-full-pr {
  width: 100%;
  padding-right: 28px;
}

.input-w-180-pr {
  width: 180px;
  padding-right: 28px;
}

.input-w-170 {
  width: 170px;
}

/* Knowledge Graph & Side Inspector */
.graph-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: center;
  margin-bottom: 14px;
  padding: 10px 14px;
  background-color: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.graph-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

.graph-legend-swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}

.graph-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 16px;
  align-items: start;
}

@media (max-width: 960px) {
  .graph-layout {
    grid-template-columns: 1fr;
  }
}

.graph-canvas-wrap {
  background-color: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  min-height: 520px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.graph-svg {
  width: 100%;
  height: 540px;
  display: block;
}

.graph-node {
  cursor: pointer;
  transition: opacity 0.15s ease-in-out;
}

.graph-node:hover circle {
  stroke: #ffffff;
  stroke-width: 2.5;
}

.graph-node.selected circle {
  stroke: #f8fafc;
  stroke-width: 3;
}

.graph-node-label {
  fill: #e2e8f0;
  font-size: 10px;
  font-family: var(--font-mono);
  pointer-events: none;
  user-select: none;
}

.graph-inspector-wrap {
  background-color: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 16px;
  min-height: 520px;
  max-height: 540px;
  overflow-y: auto;
}

.graph-edge-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  margin-bottom: 6px;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s ease-in-out, background-color 0.15s ease-in-out;
}

.graph-edge-link:hover {
  border-color: var(--accent-cyan);
  background-color: var(--bg-card-hover);
}

/* Session Replay Timeline */
.replay-timeline {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}

.replay-item {
  background-color: var(--bg-input);
  border: 1px solid var(--border-color);
  border-left: 3px solid var(--accent-cyan);
  border-radius: 8px;
  padding: 10px 12px;
}

.replay-item.kind-note {
  border-left-color: var(--accent-emerald);
}

.replay-item.kind-action {
  border-left-color: var(--accent-amber);
}
`;
