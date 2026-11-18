import { Router, Request, Response } from 'express';
import { getTrajectory, getSwarmTrajectories, runCleanup } from '../memory/trajectoryStore';

export const memoriesRouter = Router();

// GET /memories/trajectories/:id
memoriesRouter.get('/trajectories/:id', (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const record = getTrajectory(String(id));
  if (!record) {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `Trajectory '${id}' not found`,
      },
    });
    return;
  }
  res.json(record);
});

// GET /memories/swarms/:swarmId/trajectories
memoriesRouter.get('/swarms/:swarmId/trajectories', (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 200);
  const records = getSwarmTrajectories(String(req.params.swarmId), limit);
  res.json(records);
});

// POST /memories/cleanup — archive >30d, delete >90d
memoriesRouter.post('/cleanup', (_req: Request, res: Response) => {
  const result = runCleanup();
  res.json(result);
});
