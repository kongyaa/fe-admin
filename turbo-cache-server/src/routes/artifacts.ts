import { Router } from 'express';
import { CacheService } from '../services/cache';
import logger from '../utils/logger';

const router = Router();
const cacheService = new CacheService();

// Get artifact by hash
router.get('/:hash', async (req, res) => {
  const { hash } = req.params;

  try {
    const data = await cacheService.get(hash);
    
    if (!data) {
      return res.status(404).json({ error: 'Artifact not found' });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(data);
  } catch (error) {
    logger.error('Failed to retrieve artifact', { hash, error });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Store artifact
router.put('/:hash', async (req, res) => {
  const { hash } = req.params;
  const data = req.body;

  if (!Buffer.isBuffer(data)) {
    return res.status(400).json({ error: 'Invalid data format' });
  }

  try {
    await cacheService.put(hash, data);
    res.status(201).json({ message: 'Artifact stored successfully' });
  } catch (error) {
    if (error.message === 'Hash mismatch') {
      return res.status(400).json({ error: 'Hash verification failed' });
    }
    
    logger.error('Failed to store artifact', { hash, error });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete artifact
router.delete('/:hash', async (req, res) => {
  const { hash } = req.params;

  try {
    await cacheService.delete(hash);
    res.status(204).send();
  } catch (error) {
    logger.error('Failed to delete artifact', { hash, error });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router; 