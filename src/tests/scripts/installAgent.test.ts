import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  installAgentIntegration,
  formatNodeHookCommand,
  upsertBrainRuleBlock,
  generateBrainRuleBlock,
  parseCliArgs,
  resolveApiKey,
  resolveApiUrl,
  BRAIN_BLOCK_START,
  BRAIN_BLOCK_END,
  AGENTMEMORY_BLOCK_START,
  AGENTMEMORY_BLOCK_END,
} from '../../scripts/installAgent';

describe('Multi-Agent Installer (installAgent)', () => {
  let tmpBase: string;
  let tmpHome: string;
  let tmpProject: string;
  let mockBrainDir: string;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-installer-test-'));
    tmpHome = path.join(tmpBase, 'user-home');
    tmpProject = path.join(tmpBase, 'my-workspace');
    mockBrainDir = path.join(tmpBase, 'mock-neuralbrain');

    fs.mkdirSync(tmpHome, { recursive: true });
    fs.mkdirSync(tmpProject, { recursive: true });
    fs.mkdirSync(mockBrainDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpBase)) {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Test 1: Idempotency & Legacy agentmemory replacement
  // ---------------------------------------------------------------------------
  test('Test 1: Replaces agentmemory in GEMINI.md and CLAUDE.md with neuralbrain, and is 100% idempotent', () => {
    const geminiDir = path.join(tmpHome, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    const geminiMd = path.join(geminiDir, 'GEMINI.md');
    const legacyGeminiContent = [
      '# Global Gemini Rules',
      '',
      'Some preamble rule content.',
      '',
      AGENTMEMORY_BLOCK_START,
      '## Agent memory (agentmemory)',
      'Legacy instructions that should be removed.',
      AGENTMEMORY_BLOCK_END,
      '',
      'Footer rule content.',
    ].join('\n');
    fs.writeFileSync(geminiMd, legacyGeminiContent, 'utf8');

    const claudeDir = path.join(tmpHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const claudeMd = path.join(claudeDir, 'CLAUDE.md');
    const legacyClaudeContent = [
      '# Claude Guidelines',
      '',
      AGENTMEMORY_BLOCK_START,
      '## Agent memory (agentmemory)',
      'Legacy claude memory block',
      AGENTMEMORY_BLOCK_END,
    ].join('\n');
    fs.writeFileSync(claudeMd, legacyClaudeContent, 'utf8');

    // First Run
    const report1 = installAgentIntegration({
      homeDir: tmpHome,
      brainRepoDir: mockBrainDir,
      targets: ['antigravity', 'claude'],
      replaceAgentMemory: true,
    });

    expect(report1.success).toBe(true);

    const gemini1 = fs.readFileSync(geminiMd, 'utf8');
    expect(gemini1).not.toContain(AGENTMEMORY_BLOCK_START);
    expect(gemini1).not.toContain(AGENTMEMORY_BLOCK_END);
    expect(gemini1).toContain(BRAIN_BLOCK_START);
    expect(gemini1).toContain(BRAIN_BLOCK_END);
    expect(gemini1).toContain('# Global Gemini Rules');
    expect(gemini1).toContain('Footer rule content.');

    const claude1 = fs.readFileSync(claudeMd, 'utf8');
    expect(claude1).not.toContain(AGENTMEMORY_BLOCK_START);
    expect(claude1).not.toContain(AGENTMEMORY_BLOCK_END);
    expect(claude1).toContain(BRAIN_BLOCK_START);
    expect(claude1).toContain(BRAIN_BLOCK_END);
    expect(claude1).toContain('# Claude Guidelines');

    // Second Run (Idempotency check)
    const report2 = installAgentIntegration({
      homeDir: tmpHome,
      brainRepoDir: mockBrainDir,
      targets: ['antigravity', 'claude'],
      replaceAgentMemory: true,
    });

    expect(report2.success).toBe(true);

    const gemini2 = fs.readFileSync(geminiMd, 'utf8');
    const claude2 = fs.readFileSync(claudeMd, 'utf8');

    expect(gemini2).toBe(gemini1);
    expect(claude2).toBe(claude1);

    // Verify exactly one start and end block
    const geminiStartCount = (gemini2.match(new RegExp(BRAIN_BLOCK_START, 'g')) || []).length;
    const claudeStartCount = (claude2.match(new RegExp(BRAIN_BLOCK_START, 'g')) || []).length;
    expect(geminiStartCount).toBe(1);
    expect(claudeStartCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Merges MCP servers and deletes legacy agentmemory
  // ---------------------------------------------------------------------------
  test('Test 2: Merges mcpServers["neuralbrain"] into .claude.json and .cursor/mcp.json while preserving unrelated MCP servers and removing agentmemory', () => {
    // Setup pre-existing .claude.json
    const claudeJsonPath = path.join(tmpHome, '.claude.json');
    const preExistingClaude = {
      theme: 'dark',
      mcpServers: {
        'analytics-mcp': {
          command: 'node',
          args: ['/opt/analytics/server.js'],
        },
        agentmemory: {
          command: 'python',
          args: ['-m', 'agentmemory.server'],
        },
      },
    };
    fs.writeFileSync(claudeJsonPath, JSON.stringify(preExistingClaude, null, 2), 'utf8');

    // Setup pre-existing .cursor/mcp.json
    const cursorDir = path.join(tmpHome, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    const cursorMcpPath = path.join(cursorDir, 'mcp.json');
    const preExistingCursor = {
      mcpServers: {
        'custom-tools': {
          command: '/usr/local/bin/custom-mcp',
        },
        agentmemory: {
          command: 'agentmemory-cli',
        },
      },
    };
    fs.writeFileSync(cursorMcpPath, JSON.stringify(preExistingCursor, null, 2), 'utf8');

    const report = installAgentIntegration({
      homeDir: tmpHome,
      brainRepoDir: mockBrainDir,
      targets: ['claude', 'cursor'],
      apiUrl: 'http://localhost:3000',
      apiKey: 'test-api-key-12345',
      replaceAgentMemory: true,
    });

    expect(report.success).toBe(true);

    // Check .claude.json
    const updatedClaude = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(updatedClaude.theme).toBe('dark');
    expect(updatedClaude.mcpServers['analytics-mcp']).toEqual(
      preExistingClaude.mcpServers['analytics-mcp']
    );
    expect(updatedClaude.mcpServers['agentmemory']).toBeUndefined();
    expect(updatedClaude.mcpServers['neuralbrain']).toBeDefined();
    expect(updatedClaude.mcpServers['neuralbrain'].command).toBe('neuralbrain');
    expect(updatedClaude.mcpServers['neuralbrain'].args).toEqual(['mcp']);
    expect(updatedClaude.mcpServers['neuralbrain'].env).toEqual({
      BRAIN_API_URL: 'http://localhost:3000',
      BRAIN_API_KEY: 'test-api-key-12345',
    });

    // Check .cursor/mcp.json
    const updatedCursor = JSON.parse(fs.readFileSync(cursorMcpPath, 'utf8'));
    expect(updatedCursor.mcpServers['custom-tools']).toEqual(
      preExistingCursor.mcpServers['custom-tools']
    );
    expect(updatedCursor.mcpServers['agentmemory']).toBeUndefined();
    expect(updatedCursor.mcpServers['neuralbrain']).toBeDefined();
    expect(updatedCursor.mcpServers['neuralbrain'].command).toBe('neuralbrain');
    expect(updatedCursor.mcpServers['neuralbrain'].args).toEqual(['mcp']);
    expect(updatedCursor.mcpServers['neuralbrain'].env).toEqual({
      BRAIN_API_URL: 'http://localhost:3000',
      BRAIN_API_KEY: 'test-api-key-12345',
    });
  });

  // ---------------------------------------------------------------------------
  // Test 3: Installs Antigravity plugin bundle
  // ---------------------------------------------------------------------------
  test('Test 3: Installs Antigravity plugin bundle (plugin.json, mcp_config.json, hooks.json, rules/AGENTS.md, skills/brain-memory/SKILL.md)', () => {
    const report = installAgentIntegration({
      homeDir: tmpHome,
      brainRepoDir: mockBrainDir,
      targets: ['antigravity'],
      apiUrl: 'http://127.0.0.1:3000',
      apiKey: 'ag-key-abc',
      enableHooks: true,
    });

    expect(report.success).toBe(true);
    expect(report.configuredTargets).toContain('antigravity');

    const pluginDir = path.join(tmpHome, '.gemini', 'config', 'plugins', 'neuralbrain');

    // 1. plugin.json
    const pluginJsonPath = path.join(pluginDir, 'plugin.json');
    expect(fs.existsSync(pluginJsonPath)).toBe(true);
    const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
    expect(pluginJson.name).toBe('neuralbrain');

    // 2. mcp_config.json (Streamable HTTP /mcp URL, not stdio)
    const mcpConfigPath = path.join(pluginDir, 'mcp_config.json');
    expect(fs.existsSync(mcpConfigPath)).toBe(true);
    const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
    expect(mcpConfig.mcpServers['neuralbrain']).toEqual({
      serverUrl: 'http://127.0.0.1:3000/mcp',
      headers: {
        Authorization: 'Bearer ag-key-abc',
      },
    });

    // 3. hooks.json
    const hooksPath = path.join(pluginDir, 'hooks.json');
    expect(fs.existsSync(hooksPath)).toBe(true);
    const hooksConfig = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    expect(hooksConfig['neuralbrain'].enabled).toBe(true);
    expect(hooksConfig['neuralbrain'].SessionStart[0].command).toContain(
      path.join(tmpHome, '.neuralbrain', 'hooks', 'sessionStart.js')
    );
    expect(hooksConfig['neuralbrain'].PostToolUse[0].hooks[0].command).toContain(
      path.join(tmpHome, '.neuralbrain', 'hooks', 'postToolUse.js')
    );
    expect(hooksConfig['neuralbrain'].Stop[0].command).toContain(
      path.join(tmpHome, '.neuralbrain', 'hooks', 'sessionStop.js')
    );

    // Verify hooks and runtime libs copied to ~/.neuralbrain/hooks
    const brainHooksDir = path.join(tmpHome, '.neuralbrain', 'hooks');
    expect(fs.existsSync(path.join(brainHooksDir, 'sessionStart.js'))).toBe(true);
    expect(fs.existsSync(path.join(brainHooksDir, 'postToolUse.js'))).toBe(true);
    expect(fs.existsSync(path.join(brainHooksDir, 'sessionStop.js'))).toBe(true);
    expect(fs.existsSync(path.join(brainHooksDir, 'lib', 'projectSlug.js'))).toBe(true);
    expect(fs.existsSync(path.join(brainHooksDir, 'lib', 'spool.js'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.neuralbrain', 'mcp', 'server.js'))).toBe(true);

    // 4. rules/AGENTS.md
    const agentsMdPath = path.join(pluginDir, 'rules', 'AGENTS.md');
    expect(fs.existsSync(agentsMdPath)).toBe(true);
    const agentsMd = fs.readFileSync(agentsMdPath, 'utf8');
    expect(agentsMd).toContain(BRAIN_BLOCK_START);
    expect(agentsMd).toContain('brain_search');

    // 5. skills/brain-memory/SKILL.md
    const skillPath = path.join(pluginDir, 'skills', 'brain-memory', 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    const skillContent = fs.readFileSync(skillPath, 'utf8');
    expect(skillContent).toContain('name: brain-memory');
    expect(skillContent).toContain('# neuralbrain Persistent Memory');

    // 6. Global MCP config in ~/.gemini/config/mcp_config.json is NOT created (plugin handles it)
    const globalMcpPath = path.join(tmpHome, '.gemini', 'config', 'mcp_config.json');
    expect(fs.existsSync(globalMcpPath)).toBe(false);

    // 7. Global GEMINI.md
    const globalGeminiMd = path.join(tmpHome, '.gemini', 'GEMINI.md');
    expect(fs.existsSync(globalGeminiMd)).toBe(true);
    expect(fs.readFileSync(globalGeminiMd, 'utf8')).toContain(BRAIN_BLOCK_START);
  });

  // ---------------------------------------------------------------------------
  // Test 4: Workspace Project Setup & slug normalization
  // ---------------------------------------------------------------------------
  test('Test 4: Writes .brainrc with normalized project_id in projectDir (e.g. "My Test Project" -> "my-test-project")', () => {
    const specialProjectDir = path.join(tmpBase, 'My Test Project');
    fs.mkdirSync(specialProjectDir, { recursive: true });

    // Pre-create CLAUDE.md and AGENTS.md in the project
    const projectClaudeMd = path.join(specialProjectDir, 'CLAUDE.md');
    fs.writeFileSync(projectClaudeMd, '# Project Claude Rules\n', 'utf8');

    const projectAgentsMd = path.join(specialProjectDir, 'AGENTS.md');
    fs.writeFileSync(projectAgentsMd, '# Project Agents Rules\n', 'utf8');

    const report = installAgentIntegration({
      homeDir: tmpHome,
      brainRepoDir: mockBrainDir,
      projectDir: specialProjectDir,
      targets: ['project'],
    });

    expect(report.success).toBe(true);
    expect(report.projectId).toBe('my-test-project');
    expect(report.configuredTargets).toContain('project');

    // 1. .brainrc
    const brainrcPath = path.join(specialProjectDir, '.brainrc');
    expect(fs.existsSync(brainrcPath)).toBe(true);
    const brainrc = JSON.parse(fs.readFileSync(brainrcPath, 'utf8'));
    expect(brainrc).toEqual({ project_id: 'my-test-project' });

    // 2. CLAUDE.md updated
    const updatedClaude = fs.readFileSync(projectClaudeMd, 'utf8');
    expect(updatedClaude).toContain(BRAIN_BLOCK_START);
    expect(updatedClaude).toContain('my-test-project');

    // 3. AGENTS.md updated
    const updatedAgents = fs.readFileSync(projectAgentsMd, 'utf8');
    expect(updatedAgents).toContain(BRAIN_BLOCK_START);
    expect(updatedAgents).toContain('my-test-project');

    // 4. Test explicit projectId override
    const reportExplicit = installAgentIntegration({
      homeDir: tmpHome,
      brainRepoDir: mockBrainDir,
      projectDir: specialProjectDir,
      projectId: 'explicit-slug-123',
      targets: ['project'],
    });

    expect(reportExplicit.projectId).toBe('explicit-slug-123');
    const updatedBrainrc = JSON.parse(fs.readFileSync(brainrcPath, 'utf8'));
    expect(updatedBrainrc).toEqual({ project_id: 'explicit-slug-123' });
  });

  // ---------------------------------------------------------------------------
  // Test 5: Dry-Run Mode
  // ---------------------------------------------------------------------------
  test('Test 5: Respects dryRun: true without writing any files to disk', () => {
    const emptyHome = path.join(tmpBase, 'dry-home');
    const emptyProject = path.join(tmpBase, 'dry-project');
    fs.mkdirSync(emptyHome, { recursive: true });
    fs.mkdirSync(emptyProject, { recursive: true });

    const report = installAgentIntegration({
      homeDir: emptyHome,
      brainRepoDir: mockBrainDir,
      projectDir: emptyProject,
      dryRun: true,
    });

    expect(report.success).toBe(true);
    expect(report.dryRun).toBe(true);
    expect(report.createdFiles.length).toBeGreaterThan(0);

    // Verify dry-home has no files created
    expect(fs.readdirSync(emptyHome)).toHaveLength(0);

    // Verify dry-project has no files created
    expect(fs.readdirSync(emptyProject)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 6: Hooks enabling/disabling & Claude settings.json registration
  // ---------------------------------------------------------------------------
  test('Test 6: Registers hooks in Claude settings.json when enableHooks is true, and disables when false', () => {
    // 1. With enableHooks = true
    const report1 = installAgentIntegration({
      homeDir: tmpHome,
      brainRepoDir: mockBrainDir,
      targets: ['claude'],
      enableHooks: true,
    });
    expect(report1.success).toBe(true);

    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].matcher).toBe('');
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(
      path.join(tmpHome, '.neuralbrain', 'hooks', 'sessionStart.js')
    );
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse[0].matcher).toBe('*');
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain(
      path.join(tmpHome, '.neuralbrain', 'hooks', 'postToolUse.js')
    );
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].matcher).toBe('');
    expect(settings.hooks.Stop[0].hooks[0].command).toContain(
      path.join(tmpHome, '.neuralbrain', 'hooks', 'sessionStop.js')
    );
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(settings.hooks.SessionEnd[0].matcher).toBe('');
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain(
      path.join(tmpHome, '.neuralbrain', 'hooks', 'sessionStop.js')
    );

    // Running again does not duplicate entries
    installAgentIntegration({
      homeDir: tmpHome,
      brainRepoDir: mockBrainDir,
      targets: ['claude'],
      enableHooks: true,
    });
    const settingsRun2 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settingsRun2.hooks.SessionStart).toHaveLength(1);
    expect(settingsRun2.hooks.PostToolUse).toHaveLength(1);
    expect(settingsRun2.hooks.Stop).toHaveLength(1);
    expect(settingsRun2.hooks.SessionEnd).toHaveLength(1);

    // 2. In Antigravity with enableHooks = false
    installAgentIntegration({
      homeDir: tmpHome,
      brainRepoDir: mockBrainDir,
      targets: ['antigravity'],
      enableHooks: false,
    });
    const pluginHooks = JSON.parse(
      fs.readFileSync(
        path.join(tmpHome, '.gemini', 'config', 'plugins', 'neuralbrain', 'hooks.json'),
        'utf8'
      )
    );
    expect(pluginHooks['neuralbrain'].enabled).toBe(false);
  });

  test('Test 6b: Preserves existing third-party hooks (e.g. Orca) and correctly merges Claude Code nested hooks schema', () => {
    const claudeSettingsDir = path.join(tmpHome, '.claude');
    fs.mkdirSync(claudeSettingsDir, { recursive: true });
    const settingsPath = path.join(claudeSettingsDir, 'settings.json');

    // Pre-populate with Orca-style hooks
    const existingSettings = {
      hooks: {
        SessionStart: [
          {
            matcher: '',
            hooks: [
              {
                type: 'command',
                command: '/home/user/.orca/agent-hooks/claude-hook SessionStart',
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [
              {
                type: 'command',
                command: '/home/user/.orca/agent-hooks/claude-hook UserPromptSubmit',
              },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));

    const report = installAgentIntegration({
      homeDir: tmpHome,
      brainRepoDir: mockBrainDir,
      targets: ['claude'],
      enableHooks: true,
    });
    expect(report.success).toBe(true);

    const mergedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    // Orca hook on UserPromptSubmit is untouched
    expect(mergedSettings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(mergedSettings.hooks.UserPromptSubmit[0].hooks[0].command).toContain('claude-hook UserPromptSubmit');

    // SessionStart has both Orca hook AND Neuralbrain hook
    expect(mergedSettings.hooks.SessionStart).toHaveLength(2);
    expect(mergedSettings.hooks.SessionStart[0].hooks[0].command).toContain('claude-hook SessionStart');
    expect(mergedSettings.hooks.SessionStart[1].matcher).toBe('');
    expect(mergedSettings.hooks.SessionStart[1].hooks[0].command).toContain(
      path.join(tmpHome, '.neuralbrain', 'hooks', 'sessionStart.js')
    );

    // PostToolUse, Stop, SessionEnd are registered
    expect(mergedSettings.hooks.PostToolUse).toHaveLength(1);
    expect(mergedSettings.hooks.PostToolUse[0].matcher).toBe('*');
    expect(mergedSettings.hooks.PostToolUse[0].hooks[0].command).toContain(
      path.join(tmpHome, '.neuralbrain', 'hooks', 'postToolUse.js')
    );

    expect(mergedSettings.hooks.Stop).toHaveLength(1);
    expect(mergedSettings.hooks.Stop[0].matcher).toBe('');
    expect(mergedSettings.hooks.Stop[0].hooks[0].command).toContain(
      path.join(tmpHome, '.neuralbrain', 'hooks', 'sessionStop.js')
    );

    expect(mergedSettings.hooks.SessionEnd).toHaveLength(1);
    expect(mergedSettings.hooks.SessionEnd[0].matcher).toBe('');
    expect(mergedSettings.hooks.SessionEnd[0].hooks[0].command).toContain(
      path.join(tmpHome, '.neuralbrain', 'hooks', 'sessionStop.js')
    );

    // Re-running does not duplicate
    installAgentIntegration({
      homeDir: tmpHome,
      brainRepoDir: mockBrainDir,
      targets: ['claude'],
      enableHooks: true,
    });
    const reMergedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(reMergedSettings.hooks.SessionStart).toHaveLength(2);
    expect(reMergedSettings.hooks.PostToolUse).toHaveLength(1);
    expect(reMergedSettings.hooks.Stop).toHaveLength(1);
    expect(reMergedSettings.hooks.SessionEnd).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Test 7: CLI argument parsing
  // ---------------------------------------------------------------------------
  test('Test 7: parseCliArgs parses all command-line arguments accurately', () => {
    const argv = [
      '--project-dir',
      '/custom/path',
      '--project-id',
      'my-custom-slug',
      '--api-url',
      'http://10.0.0.1:4000',
      '--api-key',
      'secret-token',
      '--no-hooks',
      '--keep-agentmemory',
      '--dry-run',
      '--target',
      'claude,cursor',
    ];

    const opts = parseCliArgs(argv);
    expect(opts.projectDir).toBe('/custom/path');
    expect(opts.projectId).toBe('my-custom-slug');
    expect(opts.apiUrl).toBe('http://10.0.0.1:4000');
    expect(opts.apiKey).toBe('secret-token');
    expect(opts.enableHooks).toBe(false);
    expect(opts.replaceAgentMemory).toBe(false);
    expect(opts.dryRun).toBe(true);
    expect(opts.targets).toEqual(['claude', 'cursor']);
  });

  // ---------------------------------------------------------------------------
  // Test 8: Protection of brainRepoDir from overwriting own rules
  // ---------------------------------------------------------------------------
  test('Test 8: Does not overwrite AGENTS.md or CLAUDE.md when projectDir is the brain repo itself', () => {
    const originalConstitution = '# neuralbrain Constitution\n';
    const brainAgentsMd = path.join(mockBrainDir, 'AGENTS.md');
    fs.writeFileSync(brainAgentsMd, originalConstitution, 'utf8');

    const report = installAgentIntegration({
      homeDir: tmpHome,
      brainRepoDir: mockBrainDir,
      projectDir: mockBrainDir,
      targets: ['project'],
    });

    expect(report.success).toBe(true);
    // Constitution should NOT be overwritten with rule block
    const agentsContent = fs.readFileSync(brainAgentsMd, 'utf8');
    expect(agentsContent).toBe(originalConstitution);
    expect(agentsContent).not.toContain(BRAIN_BLOCK_START);
  });

  // ---------------------------------------------------------------------------
  // Test 9: Automatic .env loading (BRAIN_API_KEY & BRAIN_API_URL)
  // ---------------------------------------------------------------------------
  test('Test 9: Automatically pulls BRAIN_API_KEY and BRAIN_API_URL from brainRepoDir/.env without CLI/options exposure', () => {
    const origKey = process.env.BRAIN_API_KEY;
    const origUrl = process.env.BRAIN_API_URL;
    delete process.env.BRAIN_API_KEY;
    delete process.env.BRAIN_API_URL;

    try {
      const envPath = path.join(mockBrainDir, '.env');
      fs.writeFileSync(
        envPath,
        ['BRAIN_API_KEY=secret-from-dotenv', 'BRAIN_API_URL=https://brain.example.com'].join('\n'),
        'utf8'
      );

      const report = installAgentIntegration({
        homeDir: tmpHome,
        brainRepoDir: mockBrainDir,
        targets: ['antigravity', 'claude', 'cursor'],
      });

      expect(report.success).toBe(true);

      // 1. Antigravity plugin mcp_config.json (Streamable HTTP /mcp URL)
      const pluginMcpPath = path.join(
        tmpHome,
        '.gemini',
        'config',
        'plugins',
        'neuralbrain',
        'mcp_config.json'
      );
      const pluginMcp = JSON.parse(fs.readFileSync(pluginMcpPath, 'utf8'));
      expect(pluginMcp.mcpServers['neuralbrain']).toEqual({
        serverUrl: 'https://brain.example.com/mcp',
        headers: {
          Authorization: 'Bearer secret-from-dotenv',
        },
      });

      // 2. Antigravity global mcp_config.json is NOT created
      const globalMcpPath = path.join(tmpHome, '.gemini', 'config', 'mcp_config.json');
      expect(fs.existsSync(globalMcpPath)).toBe(false);

      // 3. Claude .claude.json
      const claudeJsonPath = path.join(tmpHome, '.claude.json');
      const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
      expect(claudeJson.mcpServers['neuralbrain'].env).toEqual({
        BRAIN_API_URL: 'https://brain.example.com',
        BRAIN_API_KEY: 'secret-from-dotenv',
      });

      // 4. Cursor .cursor/mcp.json
      const cursorMcpPath = path.join(tmpHome, '.cursor', 'mcp.json');
      const cursorMcp = JSON.parse(fs.readFileSync(cursorMcpPath, 'utf8'));
      expect(cursorMcp.mcpServers['neuralbrain'].env).toEqual({
        BRAIN_API_URL: 'https://brain.example.com',
        BRAIN_API_KEY: 'secret-from-dotenv',
      });
    } finally {
      if (origKey !== undefined) process.env.BRAIN_API_KEY = origKey;
      if (origUrl !== undefined) process.env.BRAIN_API_URL = origUrl;
    }
  });

  // ---------------------------------------------------------------------------
  // Test 10: Supports PORT in .env converting to http://127.0.0.1:${PORT}
  // ---------------------------------------------------------------------------
  test('Test 10: Supports PORT in .env converting to http://127.0.0.1:${PORT} when BRAIN_API_URL is omitted', () => {
    const origKey = process.env.BRAIN_API_KEY;
    const origUrl = process.env.BRAIN_API_URL;
    const origPort = process.env.PORT;
    delete process.env.BRAIN_API_KEY;
    delete process.env.BRAIN_API_URL;
    delete process.env.PORT;

    try {
      const envPath = path.join(mockBrainDir, '.env');
      fs.writeFileSync(envPath, 'PORT=4567\nBRAIN_API_KEY=port-test-key\n', 'utf8');

      const report = installAgentIntegration({
        homeDir: tmpHome,
        brainRepoDir: mockBrainDir,
        targets: ['claude'],
      });

      expect(report.success).toBe(true);

      const claudeJsonPath = path.join(tmpHome, '.claude.json');
      const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
      expect(claudeJson.mcpServers['neuralbrain'].env).toEqual({
        BRAIN_API_URL: 'http://127.0.0.1:4567',
        BRAIN_API_KEY: 'port-test-key',
      });
    } finally {
      if (origKey !== undefined) process.env.BRAIN_API_KEY = origKey;
      if (origUrl !== undefined) process.env.BRAIN_API_URL = origUrl;
      if (origPort !== undefined) process.env.PORT = origPort;
    }
  });

  // ---------------------------------------------------------------------------
  // Test 11: Priority resolution for API Key
  // ---------------------------------------------------------------------------
  test('Test 11: Resolves API key in prioritized order (options > process.env > .env > data/api-key.txt)', () => {
    // Hermetic: pass an explicit temp homeDir so resolveApiKey never consults the
    // developer's real ~/.neuralbrain/.env or ~/.neuralbrain/data/api-key.txt
    // (an explicit homeDir also bypasses BRAIN_HOME). BRAIN_API_KEY may have been
    // loaded into process.env from the real ~/.neuralbrain/.env, so clear it too.
    const origKey = process.env.BRAIN_API_KEY;
    delete process.env.BRAIN_API_KEY;

    try {
      // 1. data/api-key.txt
      const dataDir = path.join(mockBrainDir, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'api-key.txt'), 'key-from-file\n', 'utf8');
      expect(resolveApiKey({}, mockBrainDir, undefined, tmpHome)).toBe('key-from-file');

      // 2. .env overrides data/api-key.txt
      fs.writeFileSync(path.join(mockBrainDir, '.env'), 'BRAIN_API_KEY=key-from-env\n', 'utf8');
      expect(resolveApiKey({}, mockBrainDir, undefined, tmpHome)).toBe('key-from-env');

      // 3. process.env overrides .env
      process.env.BRAIN_API_KEY = 'key-from-process-env';
      expect(resolveApiKey({}, mockBrainDir, undefined, tmpHome)).toBe('key-from-process-env');

      // 4. options overrides process.env
      expect(resolveApiKey({ apiKey: 'key-from-options' }, mockBrainDir, undefined, tmpHome)).toBe('key-from-options');
    } finally {
      if (origKey !== undefined) process.env.BRAIN_API_KEY = origKey;
      else delete process.env.BRAIN_API_KEY;
    }
  });

  // ---------------------------------------------------------------------------
  // Test 12: Emits security warning when --api-key is passed on CLI
  // ---------------------------------------------------------------------------
  test('Test 12: Emits security warning when --api-key is passed on CLI', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const opts = parseCliArgs(['--api-key', 'secret-via-cli']);
      expect(opts.apiKey).toBe('secret-via-cli');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[SECURITY WARNING]')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // Test 13: Without projectDir, installs ONLY to global homeDir
  // ---------------------------------------------------------------------------
  test('Test 13: Calling installAgentIntegration({ homeDir }) without projectDir installs ONLY to global homeDir', () => {
    const globalHome = path.join(tmpBase, 'only-global-home');
    fs.mkdirSync(globalHome, { recursive: true });

    const report = installAgentIntegration({
      homeDir: globalHome,
      brainRepoDir: mockBrainDir,
    });

    expect(report.success).toBe(true);
    expect(report.configuredTargets).toEqual(['antigravity', 'claude', 'cursor']);

    // Antigravity global plugin & rules
    expect(
      fs.existsSync(
        path.join(globalHome, '.gemini', 'config', 'plugins', 'neuralbrain', 'plugin.json')
      )
    ).toBe(true);
    expect(fs.existsSync(path.join(globalHome, '.gemini', 'GEMINI.md'))).toBe(true);

    // Claude global configs
    expect(fs.existsSync(path.join(globalHome, '.claude.json'))).toBe(true);
    expect(fs.existsSync(path.join(globalHome, '.claude', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(globalHome, '.claude', 'CLAUDE.md'))).toBe(true);

    // Cursor global config
    expect(fs.existsSync(path.join(globalHome, '.cursor', 'mcp.json'))).toBe(true);

    // No projectDir was configured
    expect(report.configuredTargets).not.toContain('project');
  });

  // ---------------------------------------------------------------------------
  // Test 14: With projectDir, installs ONLY into projectDir (zero global writes)
  // ---------------------------------------------------------------------------
  test('Test 14: Calling installAgentIntegration({ homeDir, projectDir }) installs ONLY to projectDir and touches ZERO global files', () => {
    const untouchedHome = path.join(tmpBase, 'untouched-home');
    const isolatedProject = path.join(tmpBase, 'isolated-project');
    fs.mkdirSync(untouchedHome, { recursive: true });
    fs.mkdirSync(isolatedProject, { recursive: true });

    const report = installAgentIntegration({
      homeDir: untouchedHome,
      brainRepoDir: mockBrainDir,
      projectDir: isolatedProject,
    });

    expect(report.success).toBe(true);
    expect(report.configuredTargets).toEqual(['project']);
    expect(report.projectId).toBe('isolated-project');

    // 1. Untouched homeDir verification
    expect(fs.readdirSync(untouchedHome)).toHaveLength(0);

    // 2. Project-level files verification
    // .brainrc
    const brainrcPath = path.join(isolatedProject, '.brainrc');
    expect(fs.existsSync(brainrcPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(brainrcPath, 'utf8'))).toEqual({
      project_id: 'isolated-project',
    });

    // .mcp.json with BRAIN_DEFAULT_PROJECT_ID
    const claudeMcpPath = path.join(isolatedProject, '.mcp.json');
    expect(fs.existsSync(claudeMcpPath)).toBe(true);
    const claudeMcp = JSON.parse(fs.readFileSync(claudeMcpPath, 'utf8'));
    expect(claudeMcp.mcpServers['neuralbrain'].command).toBe('neuralbrain');
    expect(claudeMcp.mcpServers['neuralbrain'].args).toEqual(['mcp']);
    expect(claudeMcp.mcpServers['neuralbrain'].env.BRAIN_DEFAULT_PROJECT_ID).toBe(
      'isolated-project'
    );

    // .claude/settings.json (hooks)
    const claudeSettingsPath = path.join(isolatedProject, '.claude', 'settings.json');
    expect(fs.existsSync(claudeSettingsPath)).toBe(true);
    const claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    expect(claudeSettings.hooks.SessionStart).toHaveLength(1);
    expect(claudeSettings.hooks.PostToolUse).toHaveLength(1);
    expect(claudeSettings.hooks.Stop).toHaveLength(1);

    // .gemini/hooks.json (Antigravity hooks)
    const geminiHooksPath = path.join(isolatedProject, '.gemini', 'hooks.json');
    expect(fs.existsSync(geminiHooksPath)).toBe(true);
    const geminiHooks = JSON.parse(fs.readFileSync(geminiHooksPath, 'utf8'));
    expect(geminiHooks['neuralbrain'].enabled).toBe(true);
    expect(geminiHooks['neuralbrain'].SessionStart).toHaveLength(1);

    // .gemini/skills/brain-memory/SKILL.md
    const geminiSkillPath = path.join(
      isolatedProject,
      '.gemini',
      'skills',
      'brain-memory',
      'SKILL.md'
    );
    expect(fs.existsSync(geminiSkillPath)).toBe(true);
    expect(fs.readFileSync(geminiSkillPath, 'utf8')).toContain('name: brain-memory');

    // .cursor/mcp.json with BRAIN_DEFAULT_PROJECT_ID
    const cursorMcpPath = path.join(isolatedProject, '.cursor', 'mcp.json');
    expect(fs.existsSync(cursorMcpPath)).toBe(true);
    const cursorMcp = JSON.parse(fs.readFileSync(cursorMcpPath, 'utf8'));
    expect(cursorMcp.mcpServers['neuralbrain'].command).toBe('neuralbrain');
    expect(cursorMcp.mcpServers['neuralbrain'].args).toEqual(['mcp']);
    expect(cursorMcp.mcpServers['neuralbrain'].env.BRAIN_DEFAULT_PROJECT_ID).toBe(
      'isolated-project'
    );

    // CLAUDE.md created automatically because neither CLAUDE.md nor AGENTS.md existed
    const createdClaudeMd = path.join(isolatedProject, 'CLAUDE.md');
    expect(fs.existsSync(createdClaudeMd)).toBe(true);
    expect(fs.readFileSync(createdClaudeMd, 'utf8')).toContain(BRAIN_BLOCK_START);
    expect(fs.readFileSync(createdClaudeMd, 'utf8')).toContain('isolated-project');
  });

  // ---------------------------------------------------------------------------
  // Test 15: Dual installation with global: true
  // ---------------------------------------------------------------------------
  test('Test 15: With projectDir AND global: true, installs both global and project configurations', () => {
    const dualHome = path.join(tmpBase, 'dual-home');
    const dualProject = path.join(tmpBase, 'dual-project');
    fs.mkdirSync(dualHome, { recursive: true });
    fs.mkdirSync(dualProject, { recursive: true });

    const report = installAgentIntegration({
      homeDir: dualHome,
      brainRepoDir: mockBrainDir,
      projectDir: dualProject,
      global: true,
    });

    expect(report.success).toBe(true);
    expect(report.configuredTargets).toEqual(['antigravity', 'claude', 'cursor', 'project']);

    // Global files exist
    expect(fs.existsSync(path.join(dualHome, '.claude.json'))).toBe(true);
    expect(fs.existsSync(path.join(dualHome, '.cursor', 'mcp.json'))).toBe(true);
    expect(
      fs.existsSync(
        path.join(dualHome, '.gemini', 'config', 'plugins', 'neuralbrain', 'plugin.json')
      )
    ).toBe(true);

    // Project files exist
    expect(fs.existsSync(path.join(dualProject, '.brainrc'))).toBe(true);
    expect(fs.existsSync(path.join(dualProject, '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(dualProject, '.gemini', 'hooks.json'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 16: CLI --global flag parsing
  // ---------------------------------------------------------------------------
  test('Test 16: parseCliArgs recognizes --global flag', () => {
    const opts = parseCliArgs(['--project-dir', '/my/project', '--global']);
    expect(opts.projectDir).toBe('/my/project');
    expect(opts.global).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 17: Preserves other plugins in .gemini/hooks.json and keeps agentmemory by default
  // ---------------------------------------------------------------------------
  test('Test 17: Preserves existing plugins in <projectDir>/.gemini/hooks.json and keeps agentmemory by default', () => {
    const projectDir = path.join(tmpBase, 'preserve-project');
    const geminiDir = path.join(projectDir, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });

    const hooksPath = path.join(geminiDir, 'hooks.json');
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({
        'other-plugin': {
          enabled: true,
          SessionStart: [{ type: 'command', command: 'echo other' }],
        },
      }),
      'utf8'
    );

    const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(
      claudeMdPath,
      '# Project\n\n<!-- agentmemory:start -->\nLegacy agentmemory\n<!-- agentmemory:end -->\n',
      'utf8'
    );

    const cursorDir = path.join(projectDir, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      path.join(cursorDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { agentmemory: { command: 'agentmemory-cli' } } }),
      'utf8'
    );

    const report = installAgentIntegration({
      homeDir: tmpHome,
      brainRepoDir: mockBrainDir,
      projectDir,
    });

    expect(report.success).toBe(true);

    const updatedHooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    expect(updatedHooks['other-plugin']).toEqual({
      enabled: true,
      SessionStart: [{ type: 'command', command: 'echo other' }],
    });
    expect(updatedHooks['neuralbrain']).toBeDefined();

    const updatedClaudeMd = fs.readFileSync(claudeMdPath, 'utf8');
    expect(updatedClaudeMd).toContain('<!-- agentmemory:start -->');
    expect(updatedClaudeMd).toContain('<!-- neuralbrain:start -->');

    const updatedCursor = JSON.parse(fs.readFileSync(path.join(cursorDir, 'mcp.json'), 'utf8'));
    expect(updatedCursor.mcpServers['agentmemory']).toBeDefined();
    expect(updatedCursor.mcpServers['neuralbrain']).toBeDefined();
  });

  test('formatNodeHookCommand quotes paths containing whitespace and leaves others unquoted', () => {
    expect(formatNodeHookCommand('/home/user/.neuralbrain/hooks/sessionStart.js')).toBe(
      'node /home/user/.neuralbrain/hooks/sessionStart.js'
    );
    expect(formatNodeHookCommand('C:\\Users\\John Doe\\.neuralbrain\\hooks\\sessionStart.js')).toBe(
      'node "C:\\Users\\John Doe\\.neuralbrain\\hooks\\sessionStart.js"'
    );

    const spacedHome = path.join(tmpBase, 'John Doe');
    fs.mkdirSync(spacedHome, { recursive: true });
    installAgentIntegration({
      homeDir: spacedHome,
      brainRepoDir: mockBrainDir,
      targets: ['antigravity', 'claude'],
      enableHooks: true,
    });

    const pluginHooks = JSON.parse(
      fs.readFileSync(
        path.join(spacedHome, '.gemini', 'config', 'plugins', 'neuralbrain', 'hooks.json'),
        'utf8'
      )
    );
    expect(pluginHooks.neuralbrain.SessionStart[0].command).toBe(
      `node "${path.join(spacedHome, '.neuralbrain', 'hooks', 'sessionStart.js')}"`
    );

    const claudeSettings = JSON.parse(
      fs.readFileSync(path.join(spacedHome, '.claude', 'settings.json'), 'utf8')
    );
    expect(claudeSettings.hooks.SessionStart[0].hooks[0].command).toBe(
      `node "${path.join(spacedHome, '.neuralbrain', 'hooks', 'sessionStart.js')}"`
    );
  });

  test('installRuntimeHooks creates self-contained hooks/lib with redactSecrets, tls, and dotenv/pino shims', () => {
    const isolatedHome = path.join(tmpBase, 'isolated-hooks-home');
    fs.mkdirSync(isolatedHome, { recursive: true });

    installAgentIntegration({
      homeDir: isolatedHome,
      brainRepoDir: path.resolve(__dirname, '../../..'),
      targets: ['claude'],
      enableHooks: true,
    });

    const hooksLibDir = path.join(isolatedHome, '.neuralbrain', 'hooks', 'lib');
    expect(fs.existsSync(path.join(hooksLibDir, 'redactSecrets.js'))).toBe(true);
    expect(fs.existsSync(path.join(hooksLibDir, 'tls.js'))).toBe(true);
    expect(fs.existsSync(path.join(hooksLibDir, 'node_modules', 'dotenv', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(hooksLibDir, 'node_modules', 'pino', 'index.js'))).toBe(true);

    // Verify brainHome.js and logger.js resolve their shims from hooks/lib without repo node_modules
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        [
          `const bh = require(${JSON.stringify(path.join(hooksLibDir, 'brainHome.js'))});`,
          `const lg = require(${JSON.stringify(path.join(hooksLibDir, 'logger.js'))});`,
          `const rs = require(${JSON.stringify(path.join(hooksLibDir, 'redactSecrets.js'))});`,
          `const tl = require(${JSON.stringify(path.join(hooksLibDir, 'tls.js'))});`,
          `if (typeof bh.getBrainHomeDir !== 'function') process.exit(1);`,
          `if (typeof lg.logger.warn !== 'function') process.exit(2);`,
          `if (typeof rs.redactSecrets !== 'function') process.exit(3);`,
          `if (typeof tl.createLocalTlsFetch !== 'function') process.exit(4);`,
          `process.stdout.write('ok');`,
        ].join(' '),
      ],
      { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } }
    );
    expect(out).toBe('ok');
  });

  test('omits BRAIN_API_KEY from project-level .mcp.json and .cursor/mcp.json and writes sensitive configs with 0600', () => {
    const secHome = path.join(tmpBase, 'sec-home');
    const secProject = path.join(tmpBase, 'sec-project');
    fs.mkdirSync(secHome, { recursive: true });
    fs.mkdirSync(secProject, { recursive: true });

    installAgentIntegration({
      homeDir: secHome,
      projectDir: secProject,
      brainRepoDir: mockBrainDir,
      targets: ['antigravity', 'claude', 'cursor', 'project'],
      apiKey: 'super-secret-key',
      apiUrl: 'http://127.0.0.1:3737',
    });

    const projectMcp = JSON.parse(fs.readFileSync(path.join(secProject, '.mcp.json'), 'utf8'));
    expect(projectMcp.mcpServers.neuralbrain.env.BRAIN_API_KEY).toBeUndefined();

    const projectCursorMcp = JSON.parse(
      fs.readFileSync(path.join(secProject, '.cursor', 'mcp.json'), 'utf8')
    );
    expect(projectCursorMcp.mcpServers.neuralbrain.env.BRAIN_API_KEY).toBeUndefined();

    if (process.platform !== 'win32') {
      const sensitiveFiles = [
        path.join(secHome, '.gemini', 'config', 'plugins', 'neuralbrain', 'mcp_config.json'),
        path.join(secHome, '.claude.json'),
        path.join(secHome, '.cursor', 'mcp.json'),
        path.join(secProject, '.mcp.json'),
        path.join(secProject, '.cursor', 'mcp.json'),
      ];
      for (const fp of sensitiveFiles) {
        expect(fs.statSync(fp).mode & 0o777).toBe(0o600);
      }
    }
  });

  test('parseCliArgs throws when value-expecting flags are missing values', () => {
    expect(() => parseCliArgs(['--project-dir'])).toThrow(/Missing value for --project-dir/);
    expect(() => parseCliArgs(['--project-id', '--global'])).toThrow(/Missing value for --project-id/);
    expect(() => parseCliArgs(['--api-key'])).toThrow(/Missing value for --api-key/);
    expect(() => parseCliArgs(['--api-url'])).toThrow(/Missing value for --api-url/);
    expect(() => parseCliArgs(['--target'])).toThrow(/Missing value for --target/);
  });
});
