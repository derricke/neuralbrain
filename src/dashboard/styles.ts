export const dashboardCss = `
/* Neuralbrain - Operator Command Center Stylesheet */
:root {
  /* 1. BRANDING.md 60/30/10 Color Palette in OKLCH (+ Exact Hex Reference Tokens) */
  --brand-obsidian-slate: #0B0F19;
  --brand-midnight-steel: #111827;
  --brand-luminous-emerald: #10B981;
  --brand-deep-emerald: #047857;
  --brand-coral-rose: #FB7185;
  --brand-coral-rose-fill: #F43F5E;
  --brand-electric-gold: #F59E0B;
  --brand-crisp-mist: #F3F4F6;
  --brand-cool-pewter: #9CA3AF;

  /* 60% Dominant Canvas -> 30% Secondary Surfaces -> Floating Overlays (progressively lighter) */
  --bg-base: oklch(0.165 0.024 264); /* Obsidian Slate #0B0F19 (60% canvas) */
  --bg-primary: oklch(0.208 0.028 264); /* Midnight Steel #111827 (30% secondary) */
  --bg-card: oklch(0.208 0.028 264); /* Midnight Steel #111827 */
  --bg-subtle: oklch(0.250 0.028 264); /* Lighter Midnight Steel #182235 (Dark mode depth: lighter inner surface) */
  --bg-input: oklch(0.250 0.028 264); /* Lighter Midnight Steel #182235 */
  --bg-card-hover: oklch(0.285 0.030 264); /* Hover state #1F2C44 */
  --bg-hover: oklch(0.285 0.030 264); /* Hover state #1F2C44 */
  --bg-elevated: oklch(0.310 0.032 264); /* Floating overlays #25334F */

  /* 2. Alpha Borders (Blend into any background behind them) */
  --border-alpha: rgb(0 0 0 / 0.12);
  --border-color: rgb(255 255 255 / 0.10);
  --border-subtle: rgb(255 255 255 / 0.16);
  --border-focus: oklch(0.696 0.149 162); /* Luminous Emerald #10B981 */

  /* Text Tokens in OKLCH (WCAG 2.2 AA/AAA verified on Obsidian Slate & Midnight Steel) */
  --text-primary: oklch(0.967 0.003 264); /* Crisp Mist #F3F4F6 (17.4:1 AAA) */
  --text-secondary: oklch(0.714 0.014 261); /* Cool Pewter #9CA3AF (7.0:1 AAA) */
  --text-muted: oklch(0.714 0.014 261); /* Cool Pewter #9CA3AF (AAA muted text) */
  --text-on-accent: oklch(0.165 0.024 264); /* Obsidian Slate #0B0F19 (text on Emerald, Gold, or Coral #F43F5E fills) */

  /* 10% Accent & Attention Tokens in OKLCH (~7% Emerald, ~2% Gold, <=1% Coral) */
  --accent-emerald: oklch(0.696 0.149 162); /* Luminous Emerald #10B981 */
  --accent-emerald-deep: oklch(0.508 0.118 166); /* Deep Emerald #047857 (borders/icons, or white-text fills) */
  --accent-emerald-bg: oklch(0.696 0.149 162 / 0.14);
  --accent-emerald-border: oklch(0.696 0.149 162 / 0.40);
  --accent-primary: oklch(0.696 0.149 162); /* Luminous Emerald #10B981 */
  --accent-primary-hover: oklch(0.640 0.145 162);

  --accent-amber: oklch(0.769 0.165 70); /* Electric Gold #F59E0B */
  --accent-gold: oklch(0.769 0.165 70); /* Electric Gold #F59E0B */
  --accent-amber-bg: oklch(0.769 0.165 70 / 0.14);
  --accent-amber-border: oklch(0.769 0.165 70 / 0.40);

  --accent-rose: oklch(0.718 0.176 13); /* Coral Rose #FB7185 (error text & icons on dark) */
  --accent-rose-fill: oklch(0.645 0.215 16); /* Coral Rose Fill #F43F5E (badge/banner fill with #0B0F19 text only) */
  --accent-rose-bg: oklch(0.645 0.215 16 / 0.16);
  --accent-rose-border: oklch(0.718 0.176 13 / 0.42);

  /* Brand-compliant semantic aliases (zero off-brand sky-blue or purple) */
  --accent-cyan: var(--accent-emerald);
  --accent-cyan-bg: var(--accent-emerald-bg);
  --accent-cyan-border: var(--accent-emerald-border);

  --accent-purple: var(--accent-amber);
  --accent-purple-bg: var(--accent-amber-bg);
  --accent-purple-border: var(--accent-amber-border);

  /* 3. Strict Multiple-of-4 Spacing Scale */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;

  /* 4. Strict 4-Size Typography Scale */
  --text-xs: 12px;
  --text-sm: 14px;
  --text-md: 16px;
  --text-lg: 28px;

  /* 5. Nested Rounded Corner Rule: outer = inner + padding (inner = outer - padding) */
  --control-height: 38px;
  --control-radius: 8px;
  --control-padding: 0 16px;
  --radius-inner: 8px;
  --card-padding: 16px;
  --radius-outer: calc(var(--radius-inner) + var(--card-padding));
  --radius-inner-calc: calc(var(--radius-outer) - var(--card-padding));
  --radius-nested-sm: calc(var(--radius-inner) - var(--space-1));

  /* 6. Strictly Two Shadow Levels (Small for cards, Large for floating) */
  --shadow-sm: 0 2px 8px rgb(0 0 0 / 0.24), inset 0 1px 0 rgb(255 255 255 / 0.06);
  --shadow-lg: 0 16px 40px rgb(0 0 0 / 0.48), inset 0 1px 0 rgb(255 255 255 / 0.12);

  /* 7. Responsive 4 / 8 / 12 Column Grid */
  --grid-columns: 4;
  --page-margin: 16px;
  --grid-gap: 16px;

  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

@supports not (color: oklch(0.5 0 0)) {
  :root {
    --bg-base: var(--brand-obsidian-slate);
    --bg-primary: var(--brand-midnight-steel);
    --bg-card: var(--brand-midnight-steel);
    --bg-subtle: #182235;
    --bg-input: #182235;
    --bg-card-hover: #1F2C44;
    --bg-hover: #1F2C44;
    --bg-elevated: #25334F;
    --border-focus: var(--brand-luminous-emerald);
    --text-primary: var(--brand-crisp-mist);
    --text-secondary: var(--brand-cool-pewter);
    --text-muted: var(--brand-cool-pewter);
    --text-on-accent: var(--brand-obsidian-slate);
    --accent-emerald: var(--brand-luminous-emerald);
    --accent-emerald-deep: var(--brand-deep-emerald);
    --accent-primary: var(--brand-luminous-emerald);
    --accent-primary-hover: #0EA572;
    --accent-amber: var(--brand-electric-gold);
    --accent-gold: var(--brand-electric-gold);
    --accent-rose: var(--brand-coral-rose);
    --accent-rose-fill: var(--brand-coral-rose-fill);
  }
}

@media (min-width: 640px) {
  :root {
    --grid-columns: 8;
    --page-margin: 32px;
    --grid-gap: 16px;
  }
}

@media (min-width: 1024px) {
  :root {
    --grid-columns: 12;
    --page-margin: 48px;
    --grid-gap: 24px;
  }
}

@media (min-width: 1440px) {
  :root {
    --grid-columns: 12;
    --page-margin: 64px;
    --grid-gap: 24px;
  }
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html {
  background-color: var(--bg-base);
}

body {
  background-color: var(--bg-base);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: var(--text-md);
  line-height: 1.6;
  min-height: 100dvh;
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  -webkit-font-smoothing: antialiased;
}

a:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid var(--accent-emerald);
  outline-offset: 2px;
}

.full-height-section {
  min-height: 100dvh;
}

/* View Transitions */
@keyframes vt-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes vt-fade-out {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(-4px); }
}

::view-transition-old(root) {
  animation: vt-fade-out 0.16s ease-out both;
}

::view-transition-new(root) {
  animation: vt-fade-in 0.2s ease-out both;
}

/* Balanced Headlines & Tabular Numbers */
h1, h2, h3, h4,
.modal-title,
.result-title,
.balanced-headline {
  text-wrap: balance;
}

.kpi-value,
.tab-badge,
.badge-mono,
.data-table td,
.result-score,
.code-pill,
.tabular-nums {
  font-variant-numeric: tabular-nums;
}

/* Icons Matched to Font Weight & Blurred Icon Swaps */
.icon-svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  stroke: currentColor;
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.75;
  transition: opacity 0.18s ease, filter 0.18s ease, transform 0.18s ease;
}

.btn .icon-svg,
.nav-tab-btn .icon-svg,
.badge .icon-svg {
  stroke-width: 2.25;
}

strong .icon-svg,
.card-title .icon-svg,
.brand-title .icon-svg,
h1 .icon-svg,
h2 .icon-svg,
h3 .icon-svg {
  stroke-width: 2.5;
}

.icon-swap-slot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.18s ease, filter 0.18s ease, transform 0.18s ease;
}

.icon-swap-out {
  opacity: 0;
  filter: blur(4px);
  transform: scale(0.85);
}

.icon-swap-in {
  opacity: 1;
  filter: blur(0px);
  transform: scale(1);
}

/* Hit Slop (Expanded Tap Targets >= 44px without inflating visual layout) */
.hit-slop,
.btn-icon-edit,
.toast-close-btn,
.toast-undo-btn,
.dropdown-chevron {
  position: relative;
}

.hit-slop::before,
.btn-icon-edit::before,
.toast-close-btn::before,
.toast-undo-btn::before,
.dropdown-chevron::before {
  content: "";
  position: absolute;
  inset: -8px;
}

/* App Header & Top Navigation */
.app-header {
  background-color: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
  border-top: 1px solid var(--border-alpha);
  position: sticky;
  top: env(safe-area-inset-top, 0px);
  z-index: 100;
}

.header-inner {
  max-width: 1540px;
  margin: 0 auto;
  padding: var(--space-3) calc(var(--page-margin) + env(safe-area-inset-right, 0px)) var(--space-3) calc(var(--page-margin) + env(safe-area-inset-left, 0px));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.brand-section {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.brand-logo {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-inner);
  corner-shape: squircle;
  background: linear-gradient(135deg in oklch, var(--accent-emerald), var(--accent-gold), var(--accent-rose-fill));
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  font-size: var(--text-md);
  color: var(--text-on-accent);
  box-shadow: var(--shadow-sm);
}

.brand-info {
  display: flex;
  flex-direction: column;
}

.brand-title {
  font-size: var(--text-md);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  white-space: nowrap;
}

.brand-subtitle {
  font-size: var(--text-xs);
  color: var(--text-muted);
  letter-spacing: 0.01em;
  font-weight: 500;
}

.header-status-cluster {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

/* Warning Banner */
.warning-banner {
  background-color: var(--accent-rose-bg);
  border-bottom: 1px solid var(--accent-rose-border);
  color: var(--accent-rose);
  padding: var(--space-3) calc(var(--page-margin) + env(safe-area-inset-right, 0px)) var(--space-3) calc(var(--page-margin) + env(safe-area-inset-left, 0px));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

#mismatchBanner {
  display: none;
}

#mismatchBanner.visible,
.warning-banner.visible {
  display: flex;
}

.warning-banner.warning-banner-solid {
  background-color: var(--accent-rose-fill);
  border-bottom: 1px solid var(--accent-rose-fill);
  color: var(--text-on-accent);
}

.warning-banner-text {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-primary);
}

.warning-banner-text strong {
  color: var(--accent-rose);
}

.warning-banner.warning-banner-solid .warning-banner-text,
.warning-banner.warning-banner-solid .warning-banner-text strong,
.warning-banner.warning-banner-solid .warning-icon {
  color: var(--text-on-accent);
}

/* Navigation Tabs & Carousel Edge Fade */
.nav-tabs-bar {
  background-color: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
}

.nav-tabs-container {
  max-width: 1540px;
  margin: 0 auto;
  padding: 0 calc(var(--page-margin) + env(safe-area-inset-right, 0px)) 0 calc(var(--page-margin) + env(safe-area-inset-left, 0px));
  display: flex;
  gap: var(--space-1);
  overflow-x: auto;
  scrollbar-width: none;
}

.nav-tabs-container::-webkit-scrollbar {
  display: none;
}

.nav-tab-btn {
  height: 44px;
  padding: 0 var(--space-4);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.15s ease-in-out, border-color 0.15s ease-in-out, background-color 0.15s ease-in-out;
}

.nav-tab-btn:hover {
  color: var(--text-primary);
  border-bottom-color: var(--border-subtle);
  background-color: rgb(255 255 255 / 0.04);
}

.nav-tab-btn.active {
  color: var(--accent-emerald);
  border-bottom-color: var(--accent-emerald);
}

.tab-badge {
  font-size: var(--text-xs);
  padding: 2px 8px;
  border-radius: 9999px;
  background-color: var(--bg-subtle);
  color: var(--text-secondary);
  font-family: var(--font-mono);
}

.nav-tab-btn.active .tab-badge {
  background-color: var(--accent-emerald-bg);
  color: var(--accent-emerald);
  border: 1px solid var(--accent-emerald-border);
}

/* Shortcut Hints */
.shortcut-hint {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 6px;
  border-radius: var(--radius-nested-sm);
  background-color: rgb(255 255 255 / 0.06);
  border: 1px solid var(--border-color);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.2;
  letter-spacing: 0.02em;
}

.btn-primary .shortcut-hint {
  background-color: rgb(11 15 25 / 0.14);
  border-color: rgb(11 15 25 / 0.28);
  color: var(--text-on-accent);
}

/* Main Layout (Centered with increasing margins) */
.app-main {
  max-width: 1540px;
  margin: 0 auto;
  padding: var(--space-6) calc(var(--page-margin) + env(safe-area-inset-right, 0px)) calc(var(--space-8) + env(safe-area-inset-bottom, 0px)) calc(var(--page-margin) + env(safe-area-inset-left, 0px));
}

.tab-pane {
  display: none;
}

.tab-pane.active {
  display: block;
}

/* 12-Column Grid System (4 mobile, 8 tablet, 12 desktop) */
.grid-12 {
  display: grid;
  grid-template-columns: repeat(var(--grid-columns), minmax(0, 1fr));
  gap: var(--grid-gap);
}

.col-span-4 { grid-column: span 4; }
.col-span-8 { grid-column: span 4; }
.col-span-12 { grid-column: span 4; }

@media (min-width: 640px) {
  .col-span-8 { grid-column: span 8; }
  .col-span-12 { grid-column: span 8; }
}

@media (min-width: 1024px) {
  .col-span-8 { grid-column: span 8; }
  .col-span-12 { grid-column: span 12; }
}

/* Carousel Strip with Edge Fade Mask */
.carousel-wrapper {
  position: relative;
  margin-bottom: var(--space-4);
}

.carousel-track {
  display: flex;
  gap: var(--space-4);
  overflow-x: auto;
  padding: var(--space-2) var(--space-6);
  scroll-snap-type: x proximity;
  scrollbar-width: none;
  mask: linear-gradient(90deg, transparent, black 15% 85%, transparent);
  -webkit-mask-image: linear-gradient(90deg, transparent, black 15% 85%, transparent);
}

.carousel-track:empty {
  padding: 0;
}

.carousel-track::-webkit-scrollbar {
  display: none;
}

.carousel-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
  height: var(--control-height);
  padding: var(--control-padding);
  border-radius: 9999px;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  scroll-snap-align: center;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.carousel-pill:hover {
  background-color: var(--bg-card-hover);
  border-color: var(--border-subtle);
  color: var(--text-primary);
}

.carousel-pill.active {
  background-color: var(--accent-emerald-bg);
  border-color: var(--accent-emerald-border);
  color: var(--accent-emerald);
}

.carousel-card {
  flex: 0 0 260px;
  scroll-snap-align: center;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-outer);
  corner-shape: squircle;
  padding: var(--card-padding);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.carousel-card-media {
  position: relative;
  border-radius: calc(var(--radius-outer) - var(--card-padding));
  corner-shape: squircle;
  overflow: hidden;
  background: oklch(0.967 0.003 264); /* Crisp Mist #F3F4F6 light backdrop for multiply blend */
  border: 1px solid var(--border-alpha);
  min-height: 88px;
  padding: var(--space-2);
  display: flex;
  align-items: center;
  justify-content: center;
}

.blurhash-placeholder {
  position: absolute;
  inset: 0;
  background: linear-gradient(120deg in oklch, var(--accent-emerald), var(--accent-gold), var(--bg-elevated));
  filter: blur(20px);
  transform: scale(1.08);
  transition: opacity 0.35s ease;
  pointer-events: none;
}

.blurhash-placeholder.loaded {
  opacity: 0;
}

.product-shot,
.blend-multiply {
  mix-blend-mode: multiply;
  position: relative;
  z-index: 1;
  max-height: 96px;
  max-width: 100%;
  object-fit: contain;
}

.oklch-spectrum-bar {
  height: 8px;
  border-radius: var(--radius-nested-sm);
  background: linear-gradient(90deg in oklch, blue, orange);
}

/* Common UI Elements: Consistency Rule */
.btn {
  height: var(--control-height);
  padding: var(--control-padding);
  border-radius: var(--control-radius);
  corner-shape: squircle;
  font-size: var(--text-sm);
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  cursor: pointer;
  border: 1px solid var(--border-color);
  background-color: var(--bg-subtle);
  color: var(--text-primary);
  text-decoration: none;
  white-space: nowrap;
  box-sizing: border-box;
  transition: background-color 0.15s ease-in-out, border-color 0.15s ease-in-out, color 0.15s ease-in-out, transform 0.12s ease;
}

.btn:hover {
  background-color: var(--bg-card-hover);
  border-color: var(--border-subtle);
  color: var(--text-primary);
}

.btn:active {
  transform: translateY(1px);
}

.btn:disabled {
  background-color: var(--bg-card);
  border-color: rgb(255 255 255 / 0.08);
  color: var(--text-muted);
  opacity: 1;
  cursor: not-allowed;
  transform: none;
}

.btn-primary {
  background-color: var(--accent-primary);
  border-color: var(--accent-emerald-deep);
  color: var(--text-on-accent);
}

.btn-primary:hover {
  background-color: var(--accent-primary-hover);
  border-color: var(--accent-emerald);
  color: var(--text-on-accent);
}

.btn-primary:disabled {
  background-color: var(--accent-primary-hover);
  border-color: var(--accent-emerald-deep);
  color: var(--text-on-accent);
}

/* Subtab navigation pills stay calm so only one Emerald CTA leads each view */
.subtabs-bar .btn-primary,
.subtabs-bar .btn.active {
  background-color: var(--accent-emerald-bg);
  border-color: var(--accent-emerald-border);
  color: var(--accent-emerald);
}

.subtabs-bar .btn-primary:hover,
.subtabs-bar .btn.active:hover {
  background-color: oklch(0.696 0.149 162 / 0.22);
  border-color: var(--accent-emerald);
  color: var(--accent-emerald);
}

.btn-emerald {
  background-color: var(--accent-emerald-bg);
  border-color: var(--accent-emerald-border);
  color: var(--accent-emerald);
}

.btn-emerald:hover {
  background-color: oklch(0.696 0.149 162 / 0.24);
}

.btn-emerald.btn-solid {
  background-color: var(--accent-emerald);
  border-color: var(--accent-emerald-deep);
  color: var(--text-on-accent);
}

.btn-emerald.btn-solid:hover {
  background-color: var(--accent-primary-hover);
  color: var(--text-on-accent);
}

.btn-emerald-deep {
  background-color: var(--accent-emerald-deep);
  border-color: var(--accent-emerald);
  color: oklch(1 0 0);
}

.btn-amber {
  background-color: var(--accent-amber-bg);
  border-color: var(--accent-amber-border);
  color: var(--accent-amber);
}

.btn-amber:hover {
  background-color: oklch(0.769 0.165 70 / 0.24);
}

.btn-amber.btn-solid {
  background-color: var(--accent-amber);
  border-color: var(--accent-amber);
  color: var(--text-on-accent);
}

.btn-amber.btn-solid:hover {
  background-color: oklch(0.720 0.160 70);
  color: var(--text-on-accent);
}

.btn-rose {
  background-color: var(--accent-rose-bg);
  border-color: var(--accent-rose-border);
  color: var(--accent-rose);
}

.btn-rose:hover {
  background-color: oklch(0.645 0.215 16 / 0.24);
}

.btn-rose.btn-solid {
  background-color: var(--accent-rose-fill);
  border-color: var(--accent-rose-fill);
  color: var(--text-on-accent);
}

.btn-rose.btn-solid:hover {
  background-color: oklch(0.600 0.210 16);
  color: var(--text-on-accent);
}

.btn-emerald.btn-solid:disabled,
.btn-amber.btn-solid:disabled,
.btn-rose.btn-solid:disabled {
  color: var(--text-on-accent);
}

.btn-emerald.btn-solid:disabled {
  background-color: var(--accent-primary-hover);
  border-color: var(--accent-emerald-deep);
}

.btn-amber.btn-solid:disabled {
  background-color: var(--accent-amber);
  border-color: var(--accent-amber);
}

.btn-rose.btn-solid:disabled {
  background-color: var(--accent-rose-fill);
  border-color: var(--accent-rose-fill);
}

.form-input,
.form-select {
  height: var(--control-height);
  padding: var(--control-padding);
  border-radius: var(--control-radius);
  corner-shape: squircle;
  background-color: var(--bg-input);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-family: var(--font-sans);
  box-sizing: border-box;
  transition: border-color 0.15s ease-in-out;
}

.form-select {
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  padding-right: 28px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%239CA3AF' d='M0 0l5 5 5-5z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
}

.form-select option {
  background-color: var(--bg-card);
  color: var(--text-primary);
}

.form-input:focus,
.form-select:focus {
  outline: 2px solid var(--accent-emerald);
  outline-offset: 2px;
  border-color: var(--border-focus);
}

.form-input:disabled,
.form-select:disabled,
.form-textarea:disabled {
  background-color: var(--bg-card);
  border-color: rgb(255 255 255 / 0.08);
  color: var(--text-muted);
  opacity: 1;
  cursor: not-allowed;
}

.form-input::placeholder,
.form-textarea::placeholder,
.command-menu-input::placeholder,
.otp-digit-input::placeholder {
  color: var(--text-muted);
  opacity: 1;
}

.form-textarea {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--control-radius);
  corner-shape: squircle;
  background-color: var(--bg-input);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-family: var(--font-mono);
  box-sizing: border-box;
  resize: vertical;
  min-height: 80px;
  width: 100%;
  transition: border-color 0.15s ease-in-out;
}

.form-textarea:focus {
  outline: 2px solid var(--accent-emerald);
  outline-offset: 2px;
  border-color: var(--border-focus);
}

/* Control Group for Siblings */
.control-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

/* OTP Input Group */
.otp-input-group {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.otp-digit-input {
  width: 34px;
  height: var(--control-height);
  padding: 0;
  text-align: center;
  font-family: var(--font-mono);
  font-size: var(--text-md);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  border-radius: var(--control-radius);
  corner-shape: squircle;
  background-color: var(--bg-input);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
}

.otp-digit-input:focus {
  outline: 2px solid var(--accent-emerald);
  outline-offset: 2px;
  border-color: var(--border-focus);
}

/* Pills & Badges */
.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  width: fit-content;
  align-self: flex-start;
  padding: 4px 10px;
  border-radius: 9999px;
  font-size: var(--text-xs);
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
  color: var(--accent-emerald);
}
.badge-emerald .badge-dot { background-color: var(--accent-emerald); }

.badge-emerald-fill {
  background-color: var(--accent-emerald);
  border-color: var(--accent-emerald-deep);
  color: var(--text-on-accent);
}
.badge-emerald-fill .badge-dot { background-color: var(--text-on-accent); }

.badge-amber {
  background-color: var(--accent-amber-bg);
  border-color: var(--accent-amber-border);
  color: var(--accent-amber);
}
.badge-amber .badge-dot { background-color: var(--accent-amber); }

.badge-amber-fill {
  background-color: var(--accent-amber);
  border-color: var(--accent-amber);
  color: var(--text-on-accent);
}
.badge-amber-fill .badge-dot { background-color: var(--text-on-accent); }

.badge-rose {
  background-color: var(--accent-rose-bg);
  border-color: var(--accent-rose-border);
  color: var(--accent-rose);
}
.badge-rose .badge-dot { background-color: var(--accent-rose); }

.badge-rose-fill {
  background-color: var(--accent-rose-fill);
  border-color: var(--accent-rose-fill);
  color: var(--text-on-accent);
}
.badge-rose-fill .badge-dot { background-color: var(--text-on-accent); }

.badge-cyan {
  background-color: var(--accent-cyan-bg);
  border-color: var(--accent-cyan-border);
  color: var(--accent-cyan);
}
.badge-cyan .badge-dot { background-color: var(--accent-cyan); }

.badge-purple {
  background-color: var(--accent-purple-bg);
  border-color: var(--accent-purple-border);
  color: var(--accent-purple);
}
.badge-purple .badge-dot { background-color: var(--accent-purple); }

.badge-subtle {
  background-color: var(--bg-subtle);
  border-color: var(--border-subtle);
  color: var(--text-secondary);
}

.badge-mono {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.swr-updating-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px 8px;
  border-radius: 9999px;
  background-color: var(--accent-cyan-bg);
  border: 1px solid var(--accent-cyan-border);
  color: var(--accent-cyan);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  animation: pulse-opacity 1.2s ease-in-out infinite;
}

@keyframes pulse-opacity {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.78; }
}

/* Cards & Section Containers (Outer Radius = Inner + Padding) */
.card {
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-outer);
  corner-shape: squircle;
  padding: var(--card-padding);
  margin-bottom: var(--space-6);
  box-shadow: var(--shadow-sm);
  transition: border-color 0.15s ease-in-out, background-color 0.15s ease-in-out;
}

.card:hover {
  border-color: var(--border-subtle);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-4);
  flex-wrap: wrap;
  gap: var(--space-4);
}

.card-title {
  font-size: var(--text-md);
  font-weight: 700;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.card-subtitle {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

/* KPI Cards Grid (4 cols mobile, 8 cols tablet, 12 cols desktop) */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(var(--grid-columns), minmax(0, 1fr));
  gap: var(--grid-gap);
  margin-bottom: var(--space-6);
}

.kpi-card {
  grid-column: span 4;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-outer);
  corner-shape: squircle;
  padding: var(--card-padding);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  transition: transform 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
}

@media (min-width: 1024px) {
  .kpi-card {
    grid-column: span 3;
  }
}

.kpi-card:hover {
  border-color: var(--border-subtle);
  background-color: var(--bg-card-hover);
}

.kpi-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.kpi-label {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.kpi-value {
  font-size: var(--text-lg);
  font-weight: 800;
  color: var(--text-primary);
  font-family: var(--font-mono);
  line-height: 1.1;
  margin-bottom: var(--space-3);
}

.kpi-breakdown {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  border-top: 1px solid var(--border-color);
  padding-top: var(--space-3);
  font-size: var(--text-xs);
  color: var(--text-muted);
}

/* Skeleton Loaders */
@keyframes skeleton-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.skeleton {
  background: linear-gradient(
    90deg in oklch,
    var(--bg-subtle) 25%,
    var(--bg-elevated) 50%,
    var(--bg-subtle) 75%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s infinite linear;
  border-radius: calc(var(--radius-outer) - var(--card-padding));
}

.skeleton-line {
  height: 14px;
  border-radius: var(--radius-nested-sm);
}

.skeleton-card {
  padding: var(--card-padding);
  border-radius: calc(var(--radius-outer) - var(--card-padding));
  background-color: var(--bg-input);
  border: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.skeleton-kpi {
  height: 132px;
  border-radius: var(--radius-outer);
}

/* Visual Progress & Breakdown Bar */
.scope-bar-container {
  margin: var(--space-4) 0;
}

.scope-bar {
  display: flex;
  height: 18px;
  border-radius: calc(var(--radius-outer) - var(--card-padding));
  overflow: hidden;
  background-color: var(--bg-subtle);
  border: 1px solid var(--border-color);
}

.scope-bar-segment {
  height: 100%;
  background: linear-gradient(90deg in oklch, var(--accent-emerald-deep), var(--accent-emerald));
  transition: width 0.3s ease;
}

.scope-bar-segment + .scope-bar-segment {
  border-left: 1px solid var(--bg-base);
}

.scope-bar-project {
  background: linear-gradient(90deg in oklch, var(--accent-emerald-deep), var(--accent-emerald));
}

.scope-bar-global {
  background: linear-gradient(90deg in oklch, var(--accent-gold), var(--accent-emerald));
}

.scope-bar-unknown {
  background: linear-gradient(90deg in oklch, var(--accent-rose-fill), var(--accent-rose));
}

.scope-legend {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  margin-top: var(--space-3);
  flex-wrap: wrap;
  font-size: var(--text-xs);
}

.scope-legend-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* Tables (Inner radius = outer - padding) */
.table-responsive {
  overflow-x: auto;
  border: 1px solid var(--border-color);
  border-radius: calc(var(--radius-outer) - var(--card-padding));
  corner-shape: squircle;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: var(--text-sm);
}

.data-table th {
  background-color: var(--bg-subtle);
  color: var(--text-secondary);
  font-weight: 600;
  font-size: var(--text-xs);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-color);
  white-space: nowrap;
}

.data-table td {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-color);
  color: var(--text-primary);
  vertical-align: middle;
}

.data-table td.table-cell-nowrap {
  white-space: nowrap;
  width: 1%;
}

.data-table td.table-cell-wrap {
  width: 100%;
  min-width: 260px;
  max-width: 520px;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.data-table tr:last-child td {
  border-bottom: none;
}

.data-table tr:hover td {
  background-color: rgb(255 255 255 / 0.03);
}

/* Code & Pre */
.code-block {
  background-color: var(--bg-base);
  border: 1px solid var(--border-color);
  border-radius: calc(var(--radius-outer) - var(--card-padding));
  corner-shape: squircle;
  padding: var(--space-3) var(--space-4);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-primary);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.code-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  background-color: var(--bg-subtle);
  border: 1px solid var(--border-color);
  padding: 2px 8px;
  border-radius: var(--radius-nested-sm);
  color: var(--text-secondary);
  white-space: nowrap;
}

.code-pill-truncate {
  display: inline-block;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}

/* Search & Filter Workbench */
.search-form-grid {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex-wrap: wrap;
  padding: var(--card-padding);
  background-color: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: calc(var(--radius-outer) - var(--card-padding));
  corner-shape: squircle;
  margin-bottom: var(--space-4);
}

.checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
  user-select: none;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.checkbox-label:hover {
  color: var(--text-primary);
}

.checkbox-label input[type="checkbox"] {
  accent-color: var(--accent-primary);
  cursor: pointer;
}

/* Result Cards (Nested inside .card -> radius = outer - padding) */
.result-card {
  background-color: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: calc(var(--radius-outer) - var(--card-padding));
  corner-shape: squircle;
  padding: var(--card-padding);
  margin-bottom: var(--space-3);
  box-shadow: var(--shadow-sm);
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.result-card:hover {
  border-color: var(--border-subtle);
  background-color: var(--bg-card-hover);
}

.result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  flex-wrap: wrap;
}

.result-score {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--accent-emerald);
  font-weight: 700;
}

.result-title {
  font-size: var(--text-md);
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: var(--space-2);
}

.result-body {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.6;
  width: 100%;
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
  margin-bottom: var(--space-3);
}

.prose-measure {
  font-size: var(--text-md);
  color: var(--text-secondary);
  line-height: 1.6;
  max-width: 70ch;
  margin-bottom: var(--space-3);
}

.provenance-line {
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  flex-wrap: nowrap;
  margin-bottom: var(--space-2);
}

.provenance-line > .icon-svg {
  flex-shrink: 0;
  margin-top: 2px;
}

.provenance-line > span {
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* Collapsible Summary Rows */
.summary-collapsible-row {
  background-color: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: calc(var(--radius-outer) - var(--card-padding));
  corner-shape: squircle;
  margin-bottom: var(--space-2);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.summary-collapsible-row:hover {
  border-color: var(--border-subtle);
}

.summary-row-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.summary-row-header:hover {
  background-color: var(--bg-card-hover);
}

.summary-row-header:focus-visible {
  outline: 2px solid var(--accent-emerald);
  outline-offset: -2px;
}

.summary-row-left {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
}

.summary-row-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.summary-row-chevron {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 0.18s ease, color 0.18s ease;
}

.summary-collapsible-row.expanded .summary-row-chevron {
  transform: rotate(180deg);
  color: var(--accent-emerald);
}

.summary-row-preview {
  flex: 1;
  min-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: 600;
}

.summary-row-body {
  padding: var(--card-padding);
  border-top: 1px solid var(--border-color);
  background-color: var(--bg-card);
}

.tag-list {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

/* Toasts Container (Floating -> shadow-lg) */
.toast-container {
  position: fixed;
  bottom: calc(var(--space-6) + env(safe-area-inset-bottom, 0px));
  right: calc(var(--space-6) + env(safe-area-inset-right, 0px));
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  min-width: 300px;
  max-width: 480px;
  background-color: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: calc(var(--radius-outer) - var(--card-padding));
  corner-shape: squircle;
  padding: var(--space-4);
  color: var(--text-primary);
  font-size: var(--text-sm);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  box-shadow: var(--shadow-lg);
  animation: slide-in 0.2s ease-out;
}

.toast-content {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.toast-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.toast-undo-btn {
  min-height: 28px;
  padding: 4px 10px;
  border-radius: var(--radius-nested-sm);
  border: 1px solid var(--accent-cyan-border);
  background-color: var(--accent-cyan-bg);
  color: var(--accent-cyan);
  font-size: var(--text-xs);
  font-weight: 600;
  cursor: pointer;
}

.toast-undo-btn:hover {
  background-color: oklch(0.696 0.149 162 / 0.24);
}

.toast-emerald { border-left: 4px solid var(--accent-emerald); }
.toast-amber { border-left: 4px solid var(--accent-amber); }
.toast-rose { border-left: 4px solid var(--accent-rose); }
.toast-cyan { border-left: 4px solid var(--accent-cyan); }

.toast-close-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: var(--text-md);
  min-width: 28px;
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: var(--radius-nested-sm);
}

.toast-close-btn:hover {
  color: var(--text-primary);
  background-color: var(--bg-subtle);
}

/* Modal Dialog & Swipe-to-Dismiss Sheet (Floating -> shadow-lg) */
.modal-overlay {
  position: fixed;
  inset: 0;
  background-color: rgb(11 15 25 / 0.80);
  z-index: 500;
  display: none;
  align-items: flex-end;
  justify-content: center;
  padding: var(--space-4);
  padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
}

@media (min-width: 640px) {
  .modal-overlay {
    align-items: center;
    padding: var(--space-6);
  }
}

.modal-overlay.open {
  display: flex;
}

.hidden {
  display: none !important;
}

.modal-dialog,
.swipe-sheet {
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-outer);
  corner-shape: squircle;
  width: 100%;
  max-width: 650px;
  max-height: 90dvh;
  overflow-y: auto;
  box-shadow: var(--shadow-lg);
  touch-action: pan-y;
  will-change: transform, opacity;
  animation: modal-pop 0.18s ease-out;
}

.sheet-drag-handle {
  width: 40px;
  height: 4px;
  border-radius: 9999px;
  background-color: rgb(255 255 255 / 0.24);
  margin: var(--space-2) auto 0;
  cursor: grab;
}

.sheet-drag-handle:active {
  cursor: grabbing;
}

.modal-header {
  padding: var(--card-padding);
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.modal-title {
  font-size: var(--text-md);
  font-weight: 700;
}

.modal-body {
  padding: var(--card-padding);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.modal-footer {
  padding: var(--card-padding);
  border-top: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

/* Command Menu (⌘K) */
.command-menu-overlay {
  position: fixed;
  inset: 0;
  background-color: rgb(11 15 25 / 0.80);
  z-index: 900;
  display: none;
  align-items: flex-start;
  justify-content: center;
  padding: 80px var(--space-4) var(--space-4);
}

.command-menu-overlay.open {
  display: flex;
}

.command-menu-dialog {
  width: 100%;
  max-width: 580px;
  background-color: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-outer);
  corner-shape: squircle;
  padding: var(--card-padding);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  animation: modal-pop 0.16s ease-out;
}

.command-menu-input-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border-color);
  transition: border-color 0.15s ease;
}

.command-menu-input-row:focus-within {
  border-bottom-color: var(--accent-emerald);
}

.command-menu-input {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: var(--text-md);
  font-family: var(--font-sans);
  border-radius: var(--radius-nested-sm);
}

.command-menu-input:focus:not(:focus-visible) {
  outline: none;
}

.command-menu-input:focus-visible {
  outline: 2px solid var(--accent-emerald);
  outline-offset: 2px;
}

.command-menu-list {
  max-height: 340px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.command-menu-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-3);
  border-radius: calc(var(--radius-outer) - var(--card-padding));
  corner-shape: squircle;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}

.command-menu-item:hover,
.command-menu-item.active {
  background-color: var(--bg-card-hover);
  border-color: var(--border-subtle);
  color: var(--accent-cyan);
}

/* Predictive Back Gesture Preview */
.predictive-back-preview {
  position: fixed;
  top: 50%;
  left: calc(var(--space-4) + env(safe-area-inset-left, 0px));
  transform: translateY(-50%) translateX(-120%);
  width: 220px;
  padding: var(--card-padding);
  background-color: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-outer);
  corner-shape: squircle;
  box-shadow: var(--shadow-lg);
  z-index: 800;
  opacity: 0;
  pointer-events: none;
  transition: transform 0.16s ease, opacity 0.16s ease;
}

.predictive-back-preview.visible {
  opacity: 1;
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

/* Searchable Dropdown / Combobox (Floating -> shadow-lg) */
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
  right: 4px;
  min-width: 28px;
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-nested-sm);
  font-size: var(--text-xs);
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
  background-color: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--control-radius);
  corner-shape: squircle;
  box-shadow: var(--shadow-lg);
  z-index: 1000;
  display: none;
  padding: var(--space-1) 0;
}

.dropdown-menu.open {
  display: block;
}

.dropdown-item {
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
  cursor: pointer;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
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
  background-color: var(--accent-cyan-bg);
}

.dropdown-item .text-mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dropdown-empty {
  padding: var(--space-3) var(--space-4);
  font-size: var(--text-xs);
  color: var(--text-muted);
  text-align: center;
}

/* Interactive Citation Link & Badge */
.citation-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  cursor: pointer;
  transition: background-color 0.15s ease-in-out, border-color 0.15s ease-in-out, color 0.15s ease-in-out, transform 0.15s ease-in-out;
  text-decoration: none;
}

.citation-badge:hover {
  background-color: var(--accent-cyan-bg) !important;
  border-color: var(--accent-cyan) !important;
  color: var(--accent-cyan) !important;
  transform: translateY(-1px);
}

/* Highlighted Table Row */
tr.row-highlight {
  background-color: var(--accent-cyan-bg) !important;
  border-left: 3px solid var(--accent-cyan);
  transition: background-color 0.4s ease;
}

/* Inspector Dialog Styling */
.inspector-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.inspector-field {
  min-width: 0;
  background-color: var(--bg-subtle);
  padding: var(--space-2) var(--space-3);
  border-radius: calc(var(--radius-outer) - var(--card-padding));
  corner-shape: squircle;
  border: 1px solid var(--border-color);
}

.inspector-label {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: var(--space-1);
}

.inspector-value {
  font-size: var(--text-sm);
  color: var(--text-primary);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.inspector-value .code-pill {
  display: inline-block;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-all;
  max-width: 100%;
}

.inspector-code-block {
  background-color: var(--bg-base);
  border: 1px solid var(--border-color);
  border-radius: calc(var(--radius-outer) - var(--card-padding));
  corner-shape: squircle;
  padding: var(--space-3) var(--space-4);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin-top: var(--space-1);
}

/* Utilities */
.flex-1 { flex: 1; }
.text-muted { color: var(--text-muted); }
.text-mono { font-family: var(--font-mono); }
.mt-4 { margin-top: var(--space-4); }
.mb-4 { margin-bottom: var(--space-4); }
.gap-8 { gap: var(--space-2); }
.gap-12 { gap: var(--space-4); }

/* Layout & Component Helpers (Responsive 4 / 8 / 12 Column Grids) */
.warning-icon {
  font-size: var(--text-md);
  color: var(--accent-rose);
}
.header-auth-form { display: inline-flex; align-items: center; gap: var(--space-2); margin: 0; padding: 0; }
.auth-session-cluster { display: inline-flex; align-items: center; gap: var(--space-2); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.input-api-key { width: 170px; }
.dot-emerald { background-color: var(--accent-emerald); }
.dot-amber { background-color: var(--accent-amber); }
.dot-cyan { background-color: var(--accent-cyan); }
.dot-rose { background-color: var(--accent-rose); }

.telemetry-grid {
  display: grid;
  grid-template-columns: repeat(var(--grid-columns), minmax(0, 1fr));
  gap: var(--grid-gap);
}

.telemetry-grid > .card {
  grid-column: span 4;
}

@media (min-width: 640px) {
  .telemetry-grid > .card {
    grid-column: span 8;
  }
}

@media (min-width: 1024px) {
  .telemetry-grid > .card {
    grid-column: span 6;
  }
}

.workbench-grid {
  display: grid;
  grid-template-columns: repeat(var(--grid-columns), minmax(0, 1fr));
  gap: var(--grid-gap);
}

.workbench-grid > .card {
  grid-column: span 4;
}

@media (min-width: 640px) {
  .workbench-grid > .card {
    grid-column: span 8;
  }
}

@media (min-width: 1024px) {
  .workbench-grid > .card {
    grid-column: span 6;
  }
}

.form-row-inline { display: flex; align-items: center; gap: var(--space-2); }
.form-label-inline { font-size: var(--text-xs); font-weight: 600; color: var(--text-muted); }
.input-w-140 { width: 140px; }
.input-w-130 { width: 130px; }
.input-w-150 { width: 150px; }
.input-w-170-pr { width: 190px; padding-right: 34px; }
.grains-selection-bar { margin-bottom: var(--space-3); display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
.search-meta-bar { margin-bottom: var(--space-3); display: none; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.subtabs-bar { display: flex; gap: var(--space-2); margin-bottom: var(--space-4); flex-wrap: wrap; }
.dead-letters-breakdown { margin-bottom: var(--space-4); }
.font-semibold { font-weight: 600; }
.badge-clear { font-size: var(--text-xs); }
.badge-count { font-size: var(--text-xs); }

/* Note Card Inline Scope Editor & Controls */
.btn-icon-edit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: var(--radius-nested-sm);
  background-color: var(--bg-subtle);
  border: 1px solid var(--border-color);
  color: var(--text-muted);
  font-size: var(--text-xs);
  cursor: pointer;
  transition: background-color 0.15s ease-in-out, border-color 0.15s ease-in-out, color 0.15s ease-in-out, transform 0.15s ease-in-out;
  line-height: 1;
}

.btn-icon-edit:hover,
.btn-icon-edit.active {
  color: var(--accent-cyan);
  border-color: var(--accent-cyan);
  background-color: var(--accent-cyan-bg);
  transform: translateY(-1px);
}

.scope-repair-widget {
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-3);
}

.scope-repair-widget.hidden {
  display: none !important;
}

.input-w-full-pr {
  width: 100%;
  padding-right: 34px;
}

.input-w-180-pr {
  width: 180px;
  padding-right: 34px;
}

.input-w-170 {
  width: 170px;
}

/* Knowledge Graph & Side Inspector (Responsive 12-col layout) */
.graph-legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  align-items: center;
  margin-bottom: var(--space-4);
  padding: var(--space-3) var(--space-4);
  background-color: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: calc(var(--radius-outer) - var(--card-padding));
  corner-shape: squircle;
}

.graph-legend-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
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
  grid-template-columns: repeat(var(--grid-columns), minmax(0, 1fr));
  gap: var(--grid-gap);
  align-items: start;
}

.graph-canvas-wrap {
  grid-column: span 4;
  background-color: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: calc(var(--radius-outer) - var(--card-padding));
  corner-shape: squircle;
  min-height: 520px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.graph-inspector-wrap {
  grid-column: span 4;
  background-color: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: calc(var(--radius-outer) - var(--card-padding));
  corner-shape: squircle;
  padding: var(--card-padding);
  min-height: 520px;
  max-height: 540px;
  overflow-y: auto;
}

.graph-inspector-empty {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.graph-inspector-caption {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.6;
}

@media (min-width: 640px) {
  .graph-canvas-wrap { grid-column: span 8; }
  .graph-inspector-wrap { grid-column: span 8; }
}

@media (min-width: 1024px) {
  .graph-canvas-wrap { grid-column: span 8; }
  .graph-inspector-wrap { grid-column: span 4; }
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

.graph-node:hover circle,
.graph-node:focus-visible circle {
  stroke: var(--text-primary);
  stroke-width: 2.5;
}

.graph-node:focus-visible {
  outline: 2px solid var(--accent-emerald);
  outline-offset: 2px;
}

.graph-node.selected circle {
  stroke: var(--text-primary);
  stroke-width: 3;
}

.graph-node-label {
  fill: var(--text-primary);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  pointer-events: none;
  user-select: none;
}

.graph-edge-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  width: 100%;
  text-align: left;
  padding: var(--space-2) var(--space-3);
  margin-bottom: var(--space-2);
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-nested-sm);
  color: var(--text-primary);
  font-size: var(--text-xs);
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
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.replay-item {
  background-color: var(--bg-input);
  border: 1px solid var(--border-color);
  border-left: 3px solid var(--accent-cyan);
  border-radius: calc(var(--radius-outer) - var(--card-padding));
  corner-shape: squircle;
  padding: var(--space-3);
}

.replay-item.kind-note {
  border-left-color: var(--accent-emerald);
}

.replay-item.kind-action {
  border-left-color: var(--accent-amber);
}
`;
