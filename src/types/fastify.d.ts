export {};

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    adminEmail?: string;
    errorBody?: unknown;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
