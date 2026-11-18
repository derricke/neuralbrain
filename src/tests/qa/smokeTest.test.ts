import { execSync } from 'child_process';
import path from 'path';

describe('Live Process & Real In-Process Model Smoke Test (Automated Runner)', () => {
  it('executes live server, seeds data/brain.db, verifies in-process nomic embeddings, and tests search', () => {
    const scriptPath = path.resolve(__dirname, '../../scripts/smokeTest.ts');
    const output = execSync(`npx ts-node "${scriptPath}"`, {
      encoding: 'utf-8',
      timeout: 45000,
    });

    expect(output).toContain('[SmokeTest] 1. /health: OK (store_meta match: true)');
    expect(output).toContain('[SmokeTest] 2. /dashboard: OK (Security headers: OK)');
    expect(output).toContain('[SmokeTest] 3. POST /notes: OK');
    expect(output).toContain('[SmokeTest] 4. In-Process Embedding: OK (512 dims, L2 norm: 1.0000)');
    expect(output).toContain('[SmokeTest] 5. POST /search (hybrid): OK');
    expect(output).toContain('"realEmbeddingOk": true');
    expect(output).toContain('"vectorDimensions": 512');
    expect(output).toContain('"l2Normalized": true');
    expect(output).toContain('"hybridSearchOk": true');
  }, 60000);
});
