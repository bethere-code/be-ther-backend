import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    const dbConnected = mongoose.connection.readyState === 1;
    return {
      ok: true,
      service: 'be-ther-backend',
      dbConnected,
      uptimeSec: Math.round(process.uptime()),
    };
  });
}
