import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import logger from '../utils/logger';

export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const teamId = req.headers['x-team-id'] as string;

  // Token validation
  if (!token || token !== config.security.turboToken) {
    logger.warn('Invalid or missing token', { ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Team validation (if teams are configured)
  if (config.security.allowedTeams.length > 0 && teamId) {
    if (!config.security.allowedTeams.includes(teamId)) {
      logger.warn('Invalid team ID', { teamId, ip: req.ip });
      return res.status(403).json({ error: 'Team not allowed' });
    }
  }

  next();
}; 