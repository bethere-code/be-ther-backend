import type { Env } from '../config/env.js';

export type PlaceSuggestion = {
  placeId: string;
  primaryText: string;
  secondaryText: string;
};

export type StructuredPlace = {
  placeId: string;
  name: string;
  formattedAddress: string;
  locality: string;
  street: string;
  area: string;
  city: string;
  district: string;
  state: string;
  country: string;
  postalCode: string;
  lat: number;
  lng: number;
};

type AddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
  long_name?: string;
  short_name?: string;
};

function requirePlacesKey(env: Env): string {
  const key = env.GOOGLE_PLACES_API_KEY?.trim();
  if (!key) {
    throw Object.assign(new Error('Location search is not configured'), {
      statusCode: 503,
    });
  }
  return key;
}

function componentLong(components: AddressComponent[], type: string): string {
  const hit = components.find((c) => (c.types ?? []).includes(type));
  return (hit?.longText ?? hit?.long_name ?? '').trim();
}

function componentShort(components: AddressComponent[], type: string): string {
  const hit = components.find((c) => (c.types ?? []).includes(type));
  return (hit?.shortText ?? hit?.short_name ?? hit?.longText ?? hit?.long_name ?? '').trim();
}

/** Map Google address components into our event-location shape. */
export function structureFromAddressComponents(input: {
  placeId: string;
  name: string;
  formattedAddress: string;
  lat: number;
  lng: number;
  components: AddressComponent[];
}): StructuredPlace {
  const c = input.components;
  const streetNumber = componentLong(c, 'street_number');
  const route = componentLong(c, 'route');
  const street = [streetNumber, route].filter(Boolean).join(' ').trim();

  const locality = componentLong(c, 'locality');
  const postalTown = componentLong(c, 'postal_town');
  const admin3 = componentLong(c, 'administrative_area_level_3');
  const city = locality || postalTown || admin3;

  const area =
    componentLong(c, 'sublocality_level_1') ||
    componentLong(c, 'sublocality') ||
    componentLong(c, 'neighborhood');

  const district =
    componentLong(c, 'administrative_area_level_2') ||
    componentLong(c, 'administrative_area_level_3');

  const state = componentLong(c, 'administrative_area_level_1');
  const country = componentLong(c, 'country') || componentShort(c, 'country');
  const postalCode = componentLong(c, 'postal_code');

  return {
    placeId: input.placeId,
    name: input.name.trim() || input.formattedAddress.trim(),
    formattedAddress: input.formattedAddress.trim(),
    locality,
    street,
    area,
    city,
    district,
    state,
    country,
    postalCode,
    lat: input.lat,
    lng: input.lng,
  };
}

/**
 * Autocomplete for venues / halls / addresses.
 * Biased to the user's GPS when provided (nearby results first).
 */
export async function autocompletePlaces(
  env: Env,
  input: {
    query: string;
    lat?: number;
    lng?: number;
    sessionToken?: string;
  },
): Promise<PlaceSuggestion[]> {
  const key = requirePlacesKey(env);
  const query = input.query.trim();
  if (query.length < 3) return [];

  const body: Record<string, unknown> = {
    input: query,
    languageCode: 'en',
  };

  if (
    typeof input.lat === 'number' &&
    typeof input.lng === 'number' &&
    Number.isFinite(input.lat) &&
    Number.isFinite(input.lng)
  ) {
    body.locationBias = {
      circle: {
        center: { latitude: input.lat, longitude: input.lng },
        radius: 50000.0, // 50 km nearby bias
      },
    };
  }

  if (input.sessionToken) {
    body.sessionToken = input.sessionToken;
  }

  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask':
        'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat',
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as {
    error?: { message?: string };
    suggestions?: Array<{
      placePrediction?: {
        placeId?: string;
        structuredFormat?: {
          mainText?: { text?: string };
          secondaryText?: { text?: string };
        };
      };
    }>;
  };

  if (!res.ok) {
    throw Object.assign(
      new Error(data.error?.message ?? 'Places autocomplete failed'),
      { statusCode: 502 },
    );
  }

  const out: PlaceSuggestion[] = [];
  for (const suggestion of data.suggestions ?? []) {
    const pred = suggestion.placePrediction;
    const placeId = pred?.placeId?.trim();
    if (!placeId) continue;
    out.push({
      placeId,
      primaryText: pred?.structuredFormat?.mainText?.text?.trim() || 'Place',
      secondaryText: pred?.structuredFormat?.secondaryText?.text?.trim() || '',
    });
  }
  return out;
}

/** Full place details for saving on the event. */
export async function getPlaceDetails(
  env: Env,
  input: { placeId: string; sessionToken?: string },
): Promise<StructuredPlace> {
  const key = requirePlacesKey(env);
  const placeId = input.placeId.trim();
  if (!placeId) {
    throw Object.assign(new Error('placeId is required'), { statusCode: 400 });
  }

  const pathId = placeId.startsWith('places/') ? placeId : `places/${placeId}`;
  const url = new URL(`https://places.googleapis.com/v1/${pathId}`);
  if (input.sessionToken) {
    url.searchParams.set('sessionToken', input.sessionToken);
  }

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask':
        'id,displayName,formattedAddress,location,addressComponents',
    },
  });

  const data = (await res.json()) as {
    error?: { message?: string };
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
    addressComponents?: AddressComponent[];
  };

  if (!res.ok) {
    throw Object.assign(
      new Error(data.error?.message ?? 'Place details failed'),
      { statusCode: 502 },
    );
  }

  const lat = data.location?.latitude;
  const lng = data.location?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw Object.assign(new Error('Place has no coordinates'), { statusCode: 502 });
  }

  const rawId = (data.id ?? pathId).replace(/^places\//, '');
  return structureFromAddressComponents({
    placeId: rawId,
    name: data.displayName?.text ?? '',
    formattedAddress: data.formattedAddress ?? '',
    lat,
    lng,
    components: data.addressComponents ?? [],
  });
}

/**
 * GPS → structured place (reverse geocode).
 * Requires Geocoding API enabled on the same Google key.
 */
export async function reverseGeocodePlace(
  env: Env,
  input: { lat: number; lng: number },
): Promise<StructuredPlace> {
  const key = requirePlacesKey(env);
  const { lat, lng } = input;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw Object.assign(new Error('Invalid coordinates'), { statusCode: 400 });
  }

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('latlng', `${lat},${lng}`);
  url.searchParams.set('key', key);

  const res = await fetch(url);
  const data = (await res.json()) as {
    status?: string;
    error_message?: string;
    results?: Array<{
      place_id?: string;
      formatted_address?: string;
      address_components?: AddressComponent[];
      geometry?: { location?: { lat?: number; lng?: number } };
    }>;
  };

  if (!res.ok || (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS')) {
    throw Object.assign(
      new Error(data.error_message ?? data.status ?? 'Reverse geocode failed'),
      { statusCode: 502 },
    );
  }

  const first = data.results?.[0];
  if (!first) {
    throw Object.assign(new Error('No address found for this location'), {
      statusCode: 404,
    });
  }

  const resultLat = first.geometry?.location?.lat ?? lat;
  const resultLng = first.geometry?.location?.lng ?? lng;
  const formatted = first.formatted_address ?? '';
  const name = formatted.split(',')[0]?.trim() || formatted;

  return structureFromAddressComponents({
    placeId: first.place_id ?? `geo:${resultLat},${resultLng}`,
    name,
    formattedAddress: formatted,
    lat: resultLat,
    lng: resultLng,
    components: first.address_components ?? [],
  });
}
