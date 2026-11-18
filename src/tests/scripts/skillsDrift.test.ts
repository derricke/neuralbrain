import fs from 'fs';
import os from 'os';
import path from 'path';
import { installAgentIntegration } from '../../scripts/installAgent';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SKILLS_DIR = path.join(REPO_ROOT, 'plugin', 'skills');
const RULES_PATH = path.join(REPO_ROOT, 'plugin', 'rules', 'AGENTS.md');
const MCP_SERVER_PATH = path.join(REPO_ROOT, 'src', 'mcp', 'server.ts');

describe('Plugin skills structure, MCP tool coverage, and non-duplicating install', () => {
  const expectedSkills = ['brain-memory', 'digest', 'handoff', 'save', 'search'];

  test('All 5 expected skills exist with valid frontmatter, <100 lines, and local TROUBLESHOOTING.md', () => {
    const actualSkills = fs
      .readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    expect(actualSkills).toEqual(expectedSkills);

    for (const skill of actualSkills) {
      const skillMdPath = path.join(SKILLS_DIR, skill, 'SKILL.md');
      const troubleshootingPath = path.join(SKILLS_DIR, skill, 'TROUBLESHOOTING.md');

      expect(fs.existsSync(skillMdPath)).toBe(true);
      expect(fs.existsSync(troubleshootingPath)).toBe(true);

      const content = fs.readFileSync(skillMdPath, 'utf8');
      const lines = content.split('\n');
      expect(lines.length).toBeLessThanOrEqual(100);
      expect(content).toMatch(new RegExp(`^---[\\s\\S]*?name:\\s*${skill}\\b`, 'm'));
      expect(content).toMatch(/^---[\s\S]*?user-invocable:\s*(true|false)/m);
      expect(content).toMatch(/^---[\s\S]*?description:.*\bUse\b/m);
    }
  });

  test('Every MCP tool registered in src/mcp/server.ts is documented in REFERENCE.md and plugin/rules/AGENTS.md', () => {
    const serverSrc = fs.readFileSync(MCP_SERVER_PATH, 'utf8');
    const toolMatches = [...serverSrc.matchAll(/server\.tool\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(toolMatches.length).toBe(11);

    const referenceMd = fs.readFileSync(
      path.join(SKILLS_DIR, 'brain-memory', 'REFERENCE.md'),
      'utf8'
    );
    const rulesMd = fs.readFileSync(RULES_PATH, 'utf8');

    for (const toolName of toolMatches) {
      expect(referenceMd).toContain(`\`${toolName}\``);
      expect(rulesMd).toContain(`\`${toolName}\``);
    }
  });

  test('installAgentIntegration writes canonical skills once to .agents/skills and symlinks targets idempotently', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-skills-install-'));
    try {
      const homeDir = path.join(tmpRoot, 'home');
      const projectDir = path.join(tmpRoot, 'project');
      fs.mkdirSync(homeDir, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });

      const report1 = installAgentIntegration({
        homeDir,
        brainRepoDir: REPO_ROOT,
        projectDir,
        global: true,
      });
      expect(report1.success).toBe(true);

      // Canonical global skills live once in ~/.agents/skills/
      for (const skill of expectedSkills) {
        const canonical = path.join(homeDir, '.agents', 'skills', skill, 'SKILL.md');
        expect(fs.existsSync(canonical)).toBe(true);

        const pluginLink = path.join(
          homeDir,
          '.gemini',
          'config',
          'plugins',
          'neuralbrain',
          'skills',
          skill
        );
        expect(fs.lstatSync(pluginLink).isSymbolicLink()).toBe(true);

        const claudeLink = path.join(homeDir, '.claude', 'skills', skill);
        expect(fs.lstatSync(claudeLink).isSymbolicLink()).toBe(true);

        const projGeminiLink = path.join(projectDir, '.gemini', 'skills', skill);
        expect(fs.lstatSync(projGeminiLink).isSymbolicLink()).toBe(true);
      }

      // Re-run should skip all skill files & symlinks (idempotent)
      const report2 = installAgentIntegration({
        homeDir,
        brainRepoDir: REPO_ROOT,
        projectDir,
        global: true,
      });
      expect(report2.createdFiles).toHaveLength(0);
      expect(report2.modifiedFiles).toHaveLength(0);
      expect(report2.skippedFiles.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
