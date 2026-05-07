export {};

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
