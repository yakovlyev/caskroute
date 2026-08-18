/**
 * CaskRoute — Store Location Discovery Agent
 *
 * Автоматически наполняет таблицу `stores` реальными локациями (название,
 * адрес, координаты, телефон, часы работы) по всем городам стартовых
 * штатов — без единого звонка или письма владельцу. Это решает только
 * "где магазины на карте" — НЕ цену/наличие (для этого отдельно
 * chain-price-agent.js для сетей и merchant-update для независимых точек).
 *
 * Запускается вручную или по расписанию (например, раз в месяц — новые
 * магазины открываются нечасто, в отличие от цен).
 *
 * Требуемые переменные окружения:
 *   GOOGLE_PLACES_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Стартовые штаты + ключевые города — расширять по мере роста.
const LAUNCH_CITIES = [
  { city: 'Austin', state: 'TX' },
  { city: 'Houston', state: 'TX' },
  { city: 'Dallas', state: 'TX' },
  { city: 'San Antonio', state: 'TX' },
  { city: 'Denver', state: 'CO' },
  { city: 'Colorado Springs', state: 'CO' },
  { city: 'Phoenix', state: 'AZ' },
  { city: 'Tucson', state: 'AZ' },
  { city: 'Scottsdale', state: 'AZ' },
  { city: 'Miami', state: 'FL' },
  { city: 'Orlando', state: 'FL' },
  { city: 'Tampa', state: 'FL' },
];

// Известные крупные сети — попадают в базу как store_type='chain'
// (их обновляет chain-price-agent.js), всё остальное — 'independent'
// (обновляется через merchant-update владельцем).
const CHAIN_KEYWORDS = ['total wine', 'bevmo', 'spec\'s', 'abc fine wine'];

function classifyStoreType(name) {
  const lower = name.toLowerCase();
  return CHAIN_KEYWORDS.some((k) => lower.includes(k)) ? 'chain' : 'independent';
}

async function searchPlacesText(query) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': required('GOOGLE_PLACES_API_KEY'),
      'X-Goog-FieldMask':
        'places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.regularOpeningHours,places.id',
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 15 }),
  });

  if (!res.ok) {
    throw new Error(`Places API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.places || [];
}

async function supabaseFetch(path, options = {}) {
  const url = `${required('SUPABASE_URL')}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: required('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${required('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase ${options.method || 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function formatHours(regularOpeningHours) {
  if (!regularOpeningHours?.weekdayDescriptions) return null;
  return regularOpeningHours.weekdayDescriptions.join(' | ');
}

async function main() {
  let inserted = 0;
  let skipped = 0;

  for (const { city, state } of LAUNCH_CITIES) {
    console.log(`Searching liquor stores in ${city}, ${state}...`);
    let places;
    try {
      places = await searchPlacesText(`liquor stores in ${city}, ${state}`);
    } catch (err) {
      console.error(`Failed to search ${city}, ${state}:`, err.message);
      continue;
    }

    for (const place of places) {
      const name = place.displayName?.text;
      const address = place.formattedAddress;
      if (!name || !address) {
        skipped++;
        continue;
      }

      // Не дублируем — проверяем по названию + адресу перед вставкой.
      const existing = await supabaseFetch(
        `stores?name=eq.${encodeURIComponent(name)}&address=eq.${encodeURIComponent(address)}&select=id`
      );
      if (existing && existing.length > 0) {
        skipped++;
        continue;
      }

      await supabaseFetch('stores', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify({
          name,
          address,
          city,
          state,
          lat: place.location?.latitude ?? null,
          lng: place.location?.longitude ?? null,
          hours: formatHours(place.regularOpeningHours),
          store_type: classifyStoreType(name),
          contact_phone: place.nationalPhoneNumber || null,
          active: true,
        }),
      });
      inserted++;
    }
  }

  console.log(`Done. Inserted ${inserted} new stores, skipped ${skipped} (duplicates or incomplete).`);
}

main().catch((err) => {
  console.error('store-location-agent fatal error:', err);
  process.exit(1);
});
