import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Env } from '../../config/env.js';
import {
  autocompletePlaces,
  getPlaceDetails,
  reverseGeocodePlace,
} from '../../services/places.service.js';

const autocompleteQuery = z.object({
  q: z.string().min(3).max(200),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  sessionToken: z.string().max(100).optional(),
});

const detailsQuery = z.object({
  placeId: z.string().min(3).max(300),
  sessionToken: z.string().max(100).optional(),
});

const reverseQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

function errorStatus(err: unknown): number {
  if (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof (err as { statusCode: unknown }).statusCode === 'number'
  ) {
    return (err as { statusCode: number }).statusCode;
  }
  return 502;
}

export async function registerPlacesV1Routes(
  app: FastifyInstance,
  env: Env,
): Promise<void> {
  const placesConfigured = Boolean(env.GOOGLE_PLACES_API_KEY?.trim());
  app.log.info(
    {
      placesConfigured,
      routes: [
        'GET /api/v1/places/autocomplete',
        'GET /api/v1/places/details',
        'GET /api/v1/places/reverse',
      ],
    },
    'Registering Places API routes',
  );

  app.get(
    '/api/v1/places/autocomplete',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      app.log.info({ query: req.query }, 'places.autocomplete request');
      const parsed = autocompleteQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          ok: false,
          error: { message: 'Query q must be at least 3 characters' },
        });
      }

      try {
        const suggestions = await autocompletePlaces(env, {
          query: parsed.data.q,
          lat: parsed.data.lat,
          lng: parsed.data.lng,
          sessionToken: parsed.data.sessionToken,
        });
        app.log.info(
          { q: parsed.data.q, count: suggestions.length },
          'places.autocomplete ok',
        );
        return reply.send({ ok: true, data: { suggestions } });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Places autocomplete failed';
        app.log.error({ err, message }, 'places.autocomplete failed');
        return reply.status(errorStatus(err)).send({
          ok: false,
          error: { message },
        });
      }
    },
  );

  app.get(
    '/api/v1/places/details',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      app.log.info({ query: req.query }, 'places.details request');
      const parsed = detailsQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          ok: false,
          error: { message: 'placeId is required' },
        });
      }

      try {
        const place = await getPlaceDetails(env, {
          placeId: parsed.data.placeId,
          sessionToken: parsed.data.sessionToken,
        });
        app.log.info(
          { placeId: parsed.data.placeId, name: place.name },
          'places.details ok',
        );
        return reply.send({ ok: true, data: { place } });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Place details failed';
        app.log.error({ err, message }, 'places.details failed');
        return reply.status(errorStatus(err)).send({
          ok: false,
          error: { message },
        });
      }
    },
  );

  app.get(
    '/api/v1/places/reverse',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      app.log.info({ query: req.query }, 'places.reverse request');
      const parsed = reverseQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          ok: false,
          error: { message: 'Valid lat and lng are required' },
        });
      }

      try {
        const place = await reverseGeocodePlace(env, {
          lat: parsed.data.lat,
          lng: parsed.data.lng,
        });
        app.log.info(
          { lat: parsed.data.lat, lng: parsed.data.lng, name: place.name },
          'places.reverse ok',
        );
        return reply.send({ ok: true, data: { place } });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Reverse geocode failed';
        app.log.error({ err, message }, 'places.reverse failed');
        return reply.status(errorStatus(err)).send({
          ok: false,
          error: { message },
        });
      }
    },
  );
}
